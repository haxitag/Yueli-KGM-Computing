import type { ServerResponse } from "node:http";
import type { ConfigStore } from "../../core/configStore.js";
import type { ManagedModelManager } from "../../models/modelManager.js";
import { InferenceDiscoveryService } from "../../runtime/discoveryService.js";
import { collectRuntimeDiagnostics, inferConfigSource } from "../../runtime/diagnosticsCollector.js";
import { resolveRuntimeTopology } from "../../runtime/topologyResolver.js";
import { explainRuntimeRoute } from "../../runtime/routeExplainer.js";

export type RuntimeRouteParams = {
  method: string;
  pathname: string;
  body?: unknown;
  res: ServerResponse;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  configStore: ConfigStore;
  modelManager?: ManagedModelManager;
  discoveryService: InferenceDiscoveryService;
  startedAt: number;
};

export async function handleRuntimeRoute(params: RuntimeRouteParams): Promise<boolean> {
  const { method, pathname } = params;
  if (!pathname.startsWith("/v1/runtime/")) {
    return false;
  }
  if (method === "GET" && pathname === "/v1/runtime/discovery") {
    return send(params, 200, await params.discoveryService.discover({ force: true }));
  }
  const discovery = params.discoveryService.getLastResult() ?? await params.discoveryService.discover();
  const topology = resolveRuntimeTopology({
    configStore: params.configStore,
    modelManager: params.modelManager,
    discovery,
  });
  const diagnostics = collectRuntimeDiagnostics(params.configStore);
  if (method === "GET" && pathname === "/v1/runtime/status") {
    const config = params.configStore.get();
    const llmDiscovered = discovery.engines.some((engine) => engine.baseUrl === config.llm.baseUrl && engine.models.some((model) => model.id === config.llm.model));
    const embeddingDiscovered = discovery.engines.some((engine) => engine.baseUrl === config.embedding.baseUrl && engine.models.some((model) => model.id === config.embedding.model));
    return send(params, 200, {
      ok: diagnostics.issues.every((issue) => issue.severity !== "error"),
      version: process.env.npm_package_version || "0.2.2",
      mockMode: process.env.KGM_MOCK_MODE === "1",
      uptimeMs: Date.now() - params.startedAt,
      llm: {
        configured: Boolean(config.llm.provider && config.llm.baseUrl && config.llm.model),
        healthy: topology.paths.llmProvider.healthy,
        provider: normalizeProviderLabel(config.llm.provider),
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        source: inferConfigSource("llm", llmDiscovered),
      },
      embedding: {
        configured: Boolean(config.embedding.provider && config.embedding.baseUrl && config.embedding.model),
        healthy: !(config.embedding.provider === "openai" && !config.embedding.apiKey),
        provider: normalizeProviderLabel(config.embedding.provider),
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
        source: inferConfigSource("embedding", embeddingDiscovered),
      },
      native: topology.paths.native,
      blockingIssues: diagnostics.issues.filter((issue) => issue.severity === "error"),
    });
  }
  if (method === "GET" && pathname === "/v1/runtime/topology") {
    return send(params, 200, topology);
  }
  if (method === "POST" && pathname === "/v1/runtime/route/explain") {
    return send(params, 200, explainRuntimeRoute({
      configStore: params.configStore,
      topology,
      issues: diagnostics.issues,
      request: params.body as { model?: string; options?: { mode?: string } } | undefined,
    }));
  }
  if (method === "GET" && pathname === "/v1/runtime/diagnostics") {
    return send(params, 200, diagnostics);
  }
  return send(params, 404, { error: "not_found" });
}

function send(params: RuntimeRouteParams, status: number, body: unknown): true {
  params.sendJson(params.res, status, body);
  return true;
}

function normalizeProviderLabel(provider: string): string {
  if (provider === "openai" || provider === "custom") {
    return "openai-compatible";
  }
  return provider;
}
