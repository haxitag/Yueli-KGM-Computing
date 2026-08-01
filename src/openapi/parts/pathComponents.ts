const R = {
  bad: { $ref: "#/components/responses/BadRequest" },
  unauth: { $ref: "#/components/responses/Unauthorized" },
  nf: { $ref: "#/components/responses/NotFound" },
  ni: { $ref: "#/components/responses/NotImplemented" },
  rl: { $ref: "#/components/responses/RateLimited" },
  err5: { $ref: "#/components/responses/ServerError" },
  badGw: { $ref: "#/components/responses/BadGateway" },
  gwTimeout: { $ref: "#/components/responses/GatewayTimeout" },
};

function j200(name: string, desc?: string) {
  return {
    description: desc ?? "成功",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  };
}

function postWithBody() {
  return { "400": R.bad, "401": R.unauth, "429": R.rl, "500": R.err5 };
}
function getOnly() {
  return { "401": R.unauth, "404": R.nf, "429": R.rl, "500": R.err5 };
}
function postOrGet() {
  return { "400": R.bad, "401": R.unauth, "404": R.nf, "429": R.rl, "500": R.err5 };
}
function postBodyNoGet404() {
  return { "400": R.bad, "401": R.unauth, "429": R.rl, "500": R.err5 };
}

/** Media thin-proxy: KGM-owned statuses only (vendor codes never passthrough). */
function mediaProxyResponses(extra?: Record<string, unknown>) {
  return {
    "400": {
      description:
        "Client/config selection error — codes: media_provider_not_found, media_template_missing_var, video_duration_exceeded",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "401": R.unauth,
    "404": {
      description: "job_not_found (async media jobs)",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "429": {
      description: "video_concurrency_limit or HTTP rate limit",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "501": {
      description:
        "*_provider_not_configured — soft-degrade; do not treat as 500",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "502": {
      description:
        "media_upstream_error / unreachable / failed — vendor HTTP status only in error.details.upstreamStatus",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "504": {
      description: "media_poll_timeout / video_poll_timeout",
      content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
    },
    "500": R.err5,
    ...extra,
  };
}

/**
 * 全部 `paths`：含 `requestBody` 与主要 `responses` 的 `application/json` schema。
 */
export function buildOpenApiPathsV1(): Record<string, unknown> {
  return {
    "/health": {
      get: { summary: "健康检查", security: [], responses: { "200": j200("HealthOk"), "500": R.err5 } },
    },
    "/v1/status": {
      get: {
        summary: "服务状态（/v1 前缀探测；含版本与常用入口指针）",
        security: [],
        responses: {
          "200": {
            description: "status ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceStatusV1" } } },
          },
          "500": R.err5,
        },
      },
    },
    "/metrics": {
      get: {
        summary: "Prometheus 文本",
        security: [],
        responses: { "200": { description: "text/plain; Prometheus exposition" }, "500": R.err5 },
      },
    },
    "/openapi.json": {
      get: { summary: "OpenAPI 3.1 文档", security: [], responses: { "200": { description: "OpenAPI 根对象" } } },
    },
    "/v1/openapi.json": {
      get: { summary: "同 /openapi.json", security: [], responses: { "200": { description: "OpenAPI" } } },
    },
    "/v1/models": {
      get: {
        summary: "OpenAI 模型列表（含 kgm.capabilities / kgm.model_type；?type=|model_type|capability 过滤）",
        parameters: [
          {
            name: "type",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "按 kgm.model_type 或 capabilities 过滤（亦接受 model_type / capability）",
          },
        ],
        responses: { "200": j200("OpenAiListModels"), ...getOnly() },
      },
    },
    "/v1/images/generations": {
      post: {
        summary: "OpenAI Images Generations（KGM 薄代理；错误体见 KgmError，上游状态不透传）",
        description:
          "未配置 → 501 image_generation_provider_not_configured；未知 provider id → 400 media_provider_not_found；上游失败 → 502 media_upstream_error（details.upstreamStatus）。",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "200": { description: "normalized / upstream JSON" },
          ...mediaProxyResponses(),
        },
      },
    },
    "/v1/images/edits": {
      post: {
        summary: "OpenAI Images Edits（复用 image 上游）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: { "200": { description: "upstream JSON" }, ...mediaProxyResponses() },
      },
    },
    "/v1/images/variations": {
      post: {
        summary: "OpenAI Images Variations（复用 image 上游）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: { "200": { description: "upstream JSON" }, ...mediaProxyResponses() },
      },
    },
    "/v1/audio/speech": {
      post: {
        summary: "OpenAI Audio Speech / TTS（可返回 audio/* 二进制）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "200": { description: "audio binary or JSON" },
          ...mediaProxyResponses(),
        },
      },
    },
    "/v1/audio/transcriptions": {
      post: {
        summary: "OpenAI Audio Transcriptions / ASR（JSON+base64 或 multipart）",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
            "multipart/form-data": { schema: { type: "object", additionalProperties: true } },
          },
        },
        responses: {
          "200": { description: "transcription JSON" },
          ...mediaProxyResponses(),
        },
      },
    },
    "/v1/audio/translations": {
      post: {
        summary: "OpenAI Audio Translations（复用 STT 上游）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: { "200": { description: "translation JSON" }, ...mediaProxyResponses() },
      },
    },
    "/v1/videos/generations": {
      post: {
        summary: "视频生成（异步 job；202 + GET /v1/kgm/media/jobs/{id}）",
        description:
          "202 kgm.media_job；501 未配置；400 duration；429 并发；上游失败记入 job.error（轮询见 504 media_poll_timeout）。",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "202": { description: "kgm.media_job queued/processing" },
          ...mediaProxyResponses(),
        },
      },
    },
    "/v1/kgm/media/video": {
      post: {
        summary: "同 /v1/videos/generations（KGM 别名）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "202": { description: "kgm.media_job" },
          ...mediaProxyResponses(),
        },
      },
    },
    "/v1/kgm/media/jobs/{id}": {
      get: {
        summary: "查询媒体异步任务状态",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "kgm.media_job" },
          ...getOnly(),
          "404": {
            description: "job_not_found（含跨租户不可见）",
            content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
          },
        },
      },
    },
    "/v1/rerank": {
      post: {
        summary: "可选 Rerank 薄代理（Forge RAG 自管时可不用）",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: { "200": { description: "upstream JSON" }, ...mediaProxyResponses() },
      },
    },
    "/v1/chat/completions": {
      post: {
        summary: "OpenAI Chat Completions",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ChatCompletionRequest" } } } },
        responses: {
          "200": j200("ChatCompletionResponse", "非 stream"),
          "502": {
            description:
              "LLM_UPSTREAM_ERROR / LLM_UPSTREAM_UNREACHABLE — 厂商状态仅在 details.upstreamStatus",
            content: { "application/json": { schema: { $ref: "#/components/schemas/KgmError" } } },
          },
          ...postWithBody(),
        },
      },
    },
    "/v1/responses": {
      post: {
        summary: "OpenAI Responses",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ResponsesRequest" } } } },
        responses: { "200": j200("ResponsesResult"), ...postWithBody() },
      },
    },
    "/v1/messages": {
      post: {
        summary: "Anthropic Messages",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/AnthropicMessagesRequest" } } } },
        responses: { "200": j200("AnthropicMessagesResult"), ...postWithBody() },
      },
    },
    "/v1/kgm/config": {
      get: { summary: "读配置（秘密仅返回 configured 标记）", responses: { "200": j200("KgmConfig"), ...getOnly() } },
      post: {
        summary: "更新配置 (patch)",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/KgmConfigPatch" } } } },
        responses: { "200": j200("KgmConfig"), ...postWithBody() },
      },
    },
    "/v1/kgm/ops/config-status": {
      get: {
        summary: "读 P0-P2 控制面 effective 状态（无秘密）",
        responses: { "200": { description: "control-plane status" }, ...getOnly() },
      },
    },
    "/v1/kgm/auto-routing": {
      get: { summary: "读 auto-routing", responses: { "200": { description: "段对象" }, ...getOnly() } },
      post: {
        summary: "写 auto-routing",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "更新后" }, ...postWithBody() },
      },
    },
    "/v1/kgm/auto-routing/summary": {
      get: { summary: "审计摘要", responses: { "200": { description: "summary JSON" }, "501": R.ni, ...getOnly() } },
    },
    "/v1/kgm/auto-routing/audit": {
      get: { summary: "审计列表", responses: { "200": { description: "{ items }" }, "501": R.ni, ...getOnly() } },
    },
    "/v1/kgm/routing": {
      get: { summary: "业务路由", responses: { "200": { description: "路由" }, ...getOnly() } },
    },
    "/v1/kgm/routing/versions": {
      get: { summary: "路由版本历史", responses: { "200": { description: "{ items }" }, ...getOnly() } },
    },
    "/v1/kgm/routing/rollback": {
      post: {
        summary: "回滚",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/RoutingRollback" } } } },
        responses: { "200": { description: "路由" }, "404": R.nf, ...postWithBody() },
      },
    },
    "/v1/kgm/tools": {
      get: { summary: "工具定义", responses: { "200": j200("ToolList"), ...getOnly() } },
    },
    "/v1/kgm/tools/stats": {
      get: { summary: "工具调用统计", responses: { "200": j200("ToolStats"), ...getOnly() } },
    },
    "/v1/kgm/schemas/{schemaId}": {
      get: {
        summary: "按 ID 取 schema",
        parameters: [{ name: "schemaId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": j200("SchemaRecord"), ...getOnly() },
      },
    },
    "/v1/kgm/schemas": {
      post: {
        summary: "注册 schema",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/SchemaRegister" } } } },
        responses: { "200": j200("SchemaRecord"), ...postWithBody() },
      },
    },
    "/v1/kgm/memory": {
      post: {
        summary: "写入记忆（canonical）",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryWriteRequest" } } } },
        responses: { "200": j200("MemoryWriteOk"), ...postWithBody() },
      },
    },
    "/v1/memory/store": {
      post: {
        summary: "写入记忆（别名，同 POST /v1/kgm/memory）",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryWriteRequest" } } } },
        responses: { "200": j200("MemoryWriteOk"), ...postWithBody() },
      },
    },
    "/v1/kgm/memory/search": {
      post: {
        summary: "记忆检索（canonical）",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MemorySearch" } } } },
        responses: { "200": j200("MemorySearchResult"), ...postWithBody() },
      },
    },
    "/v1/memory/query": {
      post: {
        summary: "记忆检索（别名，同 POST /v1/kgm/memory/search）",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MemorySearch" } } } },
        responses: { "200": j200("MemorySearchResult"), ...postWithBody() },
      },
    },
    "/v1/kgm/graph/shortest_path": {
      post: {
        summary: "最短无向链",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphPath" } } } },
        responses: { "200": j200("GraphPathWrapper", "{ result: ... | null }"), "501": R.ni, ...postWithBody() },
      },
    },
    "/v1/kgm/graph/communities": {
      post: {
        summary: "连通分量",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphCommunitiesRequest" } } } },
        responses: { "200": j200("GraphCommunitiesResult"), "501": R.ni, ...postBodyNoGet404() },
      },
    },
    "/v1/kgm/graph/reason/expand": {
      post: {
        summary: "BFS 子图展开",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphReasonExpandRequest" } } } },
        responses: { "200": j200("GraphReasonExpandWrapper"), "501": R.ni, ...postWithBody() },
      },
    },
    "/v1/kgm/graph/reason/rules": {
      post: {
        summary: "前向规则",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphRulesRequest" } } } },
        responses: { "200": j200("GraphRulesResult"), "501": R.ni, ...postWithBody() },
      },
    },
    "/v1/kgm/graph/triples": {
      post: {
        summary: "写入三元组",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphTriplesRequest" } } } },
        responses: { "200": j200("GraphTriplesResult"), ...postWithBody() },
      },
    },
    "/v1/kgm/graph/export": {
      post: {
        summary: "开放格式导出（JSON-LD / N-Triples / Turtle / GraphML）",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphExportRequest" } } } },
        responses: { "200": j200("GraphExportResult"), ...postWithBody() },
      },
    },
    "/v1/kgm/graph/import": {
      post: {
        summary: "开放格式导入",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/GraphImportRequest" } } } },
        responses: { "200": { description: "导入结果" }, ...postWithBody() },
      },
    },
    "/v1/kgm/graph/query": {
      post: {
        summary: "子图查询",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "子图" }, ...postWithBody() },
      },
    },
    "/v1/kgm/graph/reason/dual_track": {
      post: {
        summary: "形式化+统计双轨推理",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "双轨结果" }, ...postWithBody() },
      },
    },
    "/v1/kgm/weights/capabilities": {
      get: { summary: "权重/LoRA 能力面", responses: { "200": { description: "能力报告" }, ...getOnly() } },
    },
    "/v1/kgm/weights/resolve": {
      post: {
        summary: "权重执行策略解析（HF→worker / native 闸门）",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "assessment + resolvedRuntime" }, ...postWithBody() },
      },
    },
    "/v1/kgm/runtime/gpu_throughput/plan": {
      post: {
        summary: "GPU 吞吐 Worker 规划（vLLM/SGLang）",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "规划" }, ...postWithBody() },
      },
    },
    "/v1/runtime/workers/llama.cpp": {
      get: {
        summary: "llama.cpp 部署探测（是否安装/可调用）",
        responses: { "200": { description: "LlamaCppDeployStatus" }, ...getOnly() },
      },
    },
    "/v1/runtime/workers/ds4": {
      get: {
        summary: "ds4 部署探测（DeepSeek V4 / GLM specialized；含 SSD streaming / micro-batch servingHints）",
        responses: { "200": { description: "Ds4DeployStatus + servingHints" }, ...getOnly() },
      },
    },
    "/v1/runtime/workers/tokenspeed": {
      get: {
        summary: "TokenSpeed 部署探测（OpenAI-compat attach；prefix cache / parsers）",
        responses: { "200": { description: "TokenSpeedDeployStatus" }, ...getOnly() },
      },
    },
    "/v1/runtime/agentic": {
      get: {
        summary: "Agentic 计数（工具调用 / 会话亲和相关运行时计数）",
        responses: { "200": { description: "AgenticCounters" }, ...getOnly() },
      },
    },
    "/v1/kgm/multimodal/embed": {
      post: {
        summary: "多模态向量（KGM 经 KGM_MULTIMODAL_* 调上游；见 components.schemas 说明）",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ImageEmbed" } } } },
        responses: { "200": j200("ImageEmbedResponse", "KGM 对客户端返回 embedding+dim；上游由环境变量控制"), "400": R.bad, "401": R.unauth, "500": R.err5, "429": R.rl },
      },
    },
    "/v1/kgm/models": { get: { summary: "KGM 模型", responses: { "200": { description: "列表" }, ...getOnly() } } },
    "/v1/kgm/models/running": { get: { summary: "运行中", responses: { "200": { description: "列表" }, ...getOnly() } } },
    "/v1/kgm/models/create": {
      post: { summary: "创建", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "创建结果" }, ...postWithBody() } },
    },
    "/v1/kgm/models/artifacts": { get: { summary: "制品列表", responses: { "200": { description: "列表" }, ...getOnly() } } },
    "/v1/kgm/models/artifacts/{id}": {
      get: {
        summary: "单制品",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "制品" }, ...getOnly() },
      },
    },
    "/v1/kgm/models/pull": {
      post: { summary: "拉取", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "artifact" }, ...postWithBody() } },
    },
    "/v1/kgm/models/runtimes": {
      get: { summary: "Runtime 列表", responses: { "200": { description: "列表" }, ...getOnly() } },
      post: { summary: "创建 runtime", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "runtime" }, ...postWithBody() } },
    },
    "/v1/kgm/models/runtimes/{id}": {
      get: {
        summary: "单 Runtime",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "runtime" }, ...getOnly() },
      },
    },
    "/v1/kgm/models/runtimes/{id}/start": {
      post: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "启动",
        responses: { "200": { description: "runtime" }, "404": R.nf, ...postWithBody() },
      },
    },
    "/v1/kgm/models/runtimes/{id}/stop": {
      post: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "停止",
        responses: { "200": { description: "runtime" }, "404": R.nf, ...postWithBody() },
      },
    },
    "/v1/kgm/models/runtimes/{id}/metrics": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "Runtime 指标",
        responses: { "200": { description: "metrics" }, ...getOnly() },
      },
    },
    "/v1/kgm/models/{id}": {
      delete: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "删除",
        responses: { "200": { description: "结果" }, ...getOnly() },
      },
    },
    "/v1/kgm/sandboxes": {
      get: { summary: "沙箱列表", responses: { "200": { description: "列表" }, ...getOnly() } },
      post: { summary: "创建", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "sandbox" }, ...postWithBody() } },
    },
    "/v1/kgm/sandboxes/adapters": {
      get: {
        summary: "沙箱 adapter 状态",
        responses: { "200": { description: "adapters + config overlay" }, ...getOnly() },
      },
    },
    "/v1/kgm/sandboxes/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "单沙箱",
        responses: { "200": { description: "sandbox" }, ...getOnly() },
      },
    },
    "/v1/kgm/sandboxes/{id}/start": {
      post: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "启动",
        responses: { "200": { description: "sandbox" }, "404": R.nf, "503": { description: "sandbox adapter required" }, ...postWithBody() },
      },
    },
    "/v1/kgm/sandboxes/{id}/stop": {
      post: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        summary: "停止",
        responses: { "200": { description: "sandbox" }, "404": R.nf, ...postWithBody() },
      },
    },
    "/v1/kgm/artifacts/{id}": {
      get: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        summary: "读 artifact",
        responses: { "200": { description: "片段" }, "501": R.ni, ...getOnly() },
      },
    },
    "/v1/kgm/sessions/{id}": {
      get: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        summary: "读 session",
        responses: { "200": { description: "片段" }, "501": R.ni, ...getOnly() },
      },
    },
    "/v1/kgm/execute": {
      post: {
        summary: "KGM 主调度",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/KgmRequest" } } } },
        responses: { "200": j200("KgmExecuteResult"), ...postWithBody() },
      },
    },
    "/v1/kgm/kce/compute": {
      post: {
        summary: "KCE 端到端知识计算",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/KceComputeRequest" } } },
        },
        responses: { "200": j200("KceComputeResult"), ...postWithBody() },
      },
    },
  };
}
