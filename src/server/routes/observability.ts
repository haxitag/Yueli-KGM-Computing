import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContextBuilder } from "../../context/contextBuilder.js";
import type { MemoryStore } from "../../memory/store.js";
import { isInspectableMemoryStore } from "../../memory/store.js";
import type { ManagedModelManager } from "../../models/modelManager.js";
import { getOptimizer } from "../../optimization/optimizer.js";
import { getOpsStore } from "../../admin/opsStore.js";

type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

/**
 * Observability routes for memory records, cache, dynamic context, KV + token usage.
 */
export async function handleObservabilityRoute(params: {
  method: string;
  pathname: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  sendJson: SendJson;
  memoryStore: MemoryStore;
  contextBuilder: ContextBuilder;
  modelManager: ManagedModelManager;
}): Promise<boolean> {
  const { method, pathname, url, res, sendJson } = params;

  if (method === "GET" && pathname === "/v1/kgm/observability/context") {
    const userId = url.searchParams.get("userId") || undefined;
    const limit = Number(url.searchParams.get("limit") || "40");
    const offset = Number(url.searchParams.get("offset") || "0");

    const memory = await buildMemorySection(params.memoryStore, { userId, limit, offset });
    const dynamicContext = params.contextBuilder.getObservabilityStats();
    const optimizer = getOptimizer().getStats();
    const runtimes = params.modelManager.listRuntimes().map((runtime) => {
      const metrics = params.modelManager.getRuntimeMetrics(runtime.id);
      const cacheHits = metrics?.cacheHits ?? 0;
      const cacheMisses = metrics?.cacheMisses ?? 0;
      const cacheTotal = cacheHits + cacheMisses;
      return {
        id: runtime.id,
        modelName: runtime.modelName,
        runtime: runtime.runtime,
        status: runtime.status,
        kvResidentBytes: metrics?.avgKvResidentBytes ?? 0,
        lastKvResidentBytes: metrics?.lastKvResidentBytes ?? 0,
        cacheHits,
        cacheMisses,
        prefixCacheHitRate: cacheTotal > 0 ? Number((cacheHits / cacheTotal).toFixed(4)) : null,
        avgOutputTokensPerSecond: metrics?.avgOutputTokensPerSecond ?? 0,
        successesTotal: metrics?.successesTotal ?? 0,
        errorsTotal: metrics?.errorsTotal ?? 0,
      };
    });

    let tokenUsage: unknown = null;
    try {
      const store = await getOpsStore();
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      tokenUsage = store.summarizeUsage({ since });
    } catch {
      tokenUsage = { available: false, reason: "ops_store_unavailable" };
    }

    sendJson(res, 200, {
      timestamp: new Date().toISOString(),
      memory,
      compression: {
        modes: [
          {
            id: "evidence_budget",
            available: true,
            description:
              "ContextBuilder.applyEvidenceBudget：按 maxEvidenceChars 截断证据，超长可外置 artifact（非 LLM 摘要）。",
            maxEvidenceChars: dynamicContext.evidenceBudget.maxEvidenceChars,
          },
          {
            id: "kce_evidence_compression",
            available: true,
            description:
              "KCE 路径可选 evidenceCompression（LLM 压缩证据）；无独立 /memory/compress HTTP。",
          },
          {
            id: "hybrid_retriever_similarity",
            available: false,
            description: "HybridMemoryRetriever.enableCompression 为库内可选，默认未挂到主 HTTP。",
          },
        ],
      },
      cache: {
        retrieval: dynamicContext.retrievalCache,
        responseOptimizer: optimizer.cache ?? null,
        optimizerEnabled: optimizer.enabled ?? false,
        note: "ds4 / llama.cpp 进程内 KV 命中率不由 KGM 采集；此处 prefix cacheHits 为 managed runtime 启发式。",
      },
      dynamicContext: {
        lastBuildAt: dynamicContext.lastBuildAt,
        lastBuildSummary: dynamicContext.lastBuildSummary,
        evidenceBudget: dynamicContext.evidenceBudget,
      },
      kvCache: {
        source: "managed_runtime_metrics",
        prometheus: "GET /metrics → kgm_runtime_kv_resident_bytes",
        runtimes,
        ds4Note:
          "ds4 disk-KV / SSD streaming 仅控制面配置（KGM_DS4_KV_*）；真实 KV 用量在 worker 内，KGM 不伪造命中率。",
      },
      tokenUsage: {
        source: "ops_usage_ledger",
        endpoints: ["GET /v1/kgm/usage", "GET /v1/kgm/usage/summary"],
        ui: "运维 → 用量",
        summary7d: tokenUsage,
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/kgm/memory/records") {
    const userId = url.searchParams.get("userId") || undefined;
    const limit = Number(url.searchParams.get("limit") || "50");
    const offset = Number(url.searchParams.get("offset") || "0");
    const memory = await buildMemorySection(params.memoryStore, { userId, limit, offset });
    sendJson(res, 200, memory);
    return true;
  }

  if (method === "POST" && pathname === "/v1/kgm/observability/retrieval-cache/clear") {
    const cleared = params.contextBuilder.clearRetrievalCache();
    sendJson(res, 200, { cleared, timestamp: new Date().toISOString() });
    return true;
  }

  return false;
}

async function buildMemorySection(
  memoryStore: MemoryStore,
  params: { userId?: string; limit: number; offset: number },
) {
  if (!isInspectableMemoryStore(memoryStore)) {
    return {
      inspectable: false,
      stats: {
        backend: "unknown",
        totalChunks: 0,
        userCount: 0,
        byUser: [],
        inspectable: false,
      },
      records: [],
      writeApi: ["POST /v1/kgm/memory", "POST /v1/memory/store"],
      searchApi: ["POST /v1/kgm/memory/search", "POST /v1/memory/query"],
      deleteApi: ["DELETE /v1/memory/:id"],
      note: "当前 MemoryStore 未实现 inspect；仅支持 write/search/delete API。",
    };
  }
  const stats = await memoryStore.getMemoryStats();
  const records = await memoryStore.listMemoryRecords({
    userId: params.userId,
    limit: params.limit,
    offset: params.offset,
  });
  return {
    inspectable: true,
    stats,
    records,
    writeApi: ["POST /v1/kgm/memory", "POST /v1/memory/store"],
    searchApi: ["POST /v1/kgm/memory/search", "POST /v1/memory/query"],
    deleteApi: ["DELETE /v1/memory/:id"],
  };
}
