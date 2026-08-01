/**
 * OpenAPI `components.schemas`：字段级或约束级描述，按模块分块，由 `getKgmOpenApiV1` 合并。
 */
export const openApiSchemaComponents: Record<string, unknown> = {
  KgmError: {
    type: "object",
    required: ["error"],
    description:
      "统一错误信封。HTTP 状态只取 KGM 规范集（400/401/403/404/429/500/501/502/503/504）；厂商状态不透传，仅可出现在 details.upstreamStatus。",
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "status"],
        properties: {
          code: {
            type: "string",
            description:
              "可机读错误码。媒体示例：media_provider_not_found, *_provider_not_configured, media_upstream_error, media_poll_timeout",
          },
          message: { type: "string" },
          status: {
            type: "integer",
            description: "与 HTTP 状态码一致（KGM 规范集）",
            enum: [400, 401, 402, 403, 404, 429, 500, 501, 502, 503, 504],
          },
          details: {
            type: "object",
            additionalProperties: true,
            properties: {
              upstreamStatus: {
                type: "integer",
                description: "上游原始 HTTP 状态（仅诊断；勿当作宿主 HTTP）",
              },
              providerId: { type: "string" },
              cause: { type: "string" },
            },
          },
        },
      },
    },
  },
  HealthOk: {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", const: "ok" } },
  },
  ServiceStatusV1: {
    type: "object",
    required: ["status", "service", "timestamp", "version"],
    properties: {
      status: { type: "string", const: "ok" },
      service: { type: "string", const: "yueli-kgm-computing" },
      timestamp: { type: "string", format: "date-time" },
      uptime_seconds: { type: "number" },
      version: { type: "string" },
      node: { type: "string" },
      environment: { type: "string" },
      endpoints: {
        type: "object",
        properties: {
          health: { type: "string" },
          metrics: { type: "string" },
          openapi: { type: "string" },
          runtime_status: { type: "string" },
        },
      },
    },
  },
  OpenApiJson: {
    type: "object",
    description: "OpenAPI 3.1 根文档自身",
  },
  OpenAiListModels: {
    type: "object",
    properties: {
      object: { type: "string", const: "list" },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { type: "string" },
            created: { type: "integer" },
            owned_by: { type: "string" },
          },
        },
      },
    },
  },
  ChatCompletionRequest: {
    type: "object",
    properties: {
      model: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { description: "string 或多段 content 数组" },
            name: { type: "string" },
            tool_call_id: { type: "string" },
            tool_calls: { type: "array" },
          },
        },
      },
      stream: { type: "boolean" },
      temperature: { type: "number" },
      max_tokens: { type: "integer" },
      tools: { type: "array" },
      kgm: { type: "object", description: "KGM 扩展，见 KgmRequest.kgm" },
    },
  },
  ChatCompletionResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      object: { type: "string" },
      created: { type: "integer" },
      model: { type: "string" },
      choices: { type: "array" },
      usage: { type: "object" },
    },
  },
  ResponsesRequest: {
    type: "object",
    description: "OpenAI Responses 兼容请求体",
    properties: {
      model: { type: "string" },
      input: {},
      stream: { type: "boolean" },
    },
  },
  ResponsesResult: { type: "object", properties: { id: { type: "string" }, output: { type: "array" } } },
  AnthropicMessagesRequest: {
    type: "object",
    properties: {
      model: { type: "string" },
      max_tokens: { type: "integer" },
      messages: { type: "array" },
      stream: { type: "boolean" },
    },
  },
  AnthropicMessagesResult: { type: "object" },
  KgmConfig: {
    type: "object",
    description: "完整 KGM 运行配置，见 `KgmConfig` / `ConfigStore`",
    additionalProperties: true,
  },
  KgmConfigPatch: {
    type: "object",
    description: "部分更新；字段与 `KgmConfig` 对齐",
    additionalProperties: true,
  },
  MemoryWriteRequest: {
    type: "object",
    required: ["userId", "text", "source"],
    properties: {
      userId: { type: "string" },
      text: { type: "string" },
      source: { type: "string" },
    },
  },
  MemoryWriteOk: {
    type: "object",
    properties: { status: { type: "string", const: "ok" } },
  },
  MemorySearch: {
    type: "object",
    required: ["userId", "query"],
    properties: {
      userId: { type: "string" },
      query: { type: "string" },
      topK: { type: "integer", minimum: 1, maximum: 50 },
      strategy: { type: "string", enum: ["vector", "hybrid"] },
      lexicalWeight: { type: "number", minimum: 0, maximum: 1 },
      overFetch: { type: "number" },
      rerank: { type: "string", enum: ["off", "embed", "http"] },
      rerankBlend: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  Evidence: {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      score: { type: "number" },
      source: { type: "string" },
    },
  },
  MemorySearchResult: {
    type: "object",
    required: ["evidence"],
    properties: { evidence: { type: "array", items: { $ref: "#/components/schemas/Evidence" } } },
  },
  GraphPath: {
    type: "object",
    required: ["from", "to"],
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      maxHops: { type: "integer" },
      userId: { type: "string", description: "图命名空间。与 namespace 二选一必填。" },
      namespace: { type: "string", description: "图命名空间。与 userId 二选一必填。" },
    },
  },
  GraphCommunitiesRequest: {
    type: "object",
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      userId: { type: "string", description: "图命名空间。与 namespace 二选一必填。" },
      namespace: { type: "string", description: "图命名空间。与 userId 二选一必填。" },
    },
  },
  GraphShortestPathResult: {
    type: "object",
    properties: {
      path: { type: "array", items: { type: "string" } },
      edges: { type: "array" },
    },
  },
  GraphPathWrapper: { type: "object", properties: { result: { $ref: "#/components/schemas/GraphShortestPathResult" } } },
  GraphCommunitiesResult: {
    type: "object",
    required: ["communities", "count"],
    properties: {
      communities: { type: "array", items: { type: "array", items: { type: "string" } } },
      count: { type: "integer" },
    },
  },
  GraphReasonExpandRequest: {
    type: "object",
    required: ["entity"],
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      entity: { type: "string" },
      maxDepth: { type: "integer" },
      relations: { type: "array", items: { type: "string" } },
      userId: { type: "string", description: "图命名空间。与 namespace 二选一必填。" },
      namespace: { type: "string", description: "图命名空间。与 userId 二选一必填。" },
    },
  },
  GraphReasonExpandResult: {
    type: "object",
    properties: {
      center: { type: "string" },
      depth: { type: "integer" },
      entities: { type: "array", items: { type: "string" } },
      triples: { type: "array" },
    },
  },
  GraphReasonExpandWrapper: { type: "object", properties: { result: { $ref: "#/components/schemas/GraphReasonExpandResult" } } },
  GraphRule: {
    type: "object",
    required: ["id", "if", "then"],
    properties: {
      id: { type: "string" },
      if: {
        type: "array",
        items: {
          type: "object",
          required: ["subject", "predicate", "object"],
          properties: {
            subject: { type: "string", description: "`*` 表通配" },
            predicate: { type: "string" },
            object: { type: "string" },
          },
        },
      },
      then: {
        type: "object",
        required: ["subject", "predicate", "object"],
        properties: { subject: { type: "string" }, predicate: { type: "string" }, object: { type: "string" } },
      },
    },
  },
  GraphRulesRequest: {
    type: "object",
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      rules: { type: "array", items: { $ref: "#/components/schemas/GraphRule" } },
      maxRounds: { type: "integer" },
      source: { type: "string" },
      userId: { type: "string", description: "图命名空间。与 namespace 二选一必填。" },
      namespace: { type: "string", description: "图命名空间。与 userId 二选一必填。" },
    },
  },
  GraphRulesResult: { type: "object", required: ["added", "count"], properties: { added: { type: "array" }, count: { type: "integer" } } },
  GraphTriplesRequest: {
    type: "object",
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      triples: {
        type: "array",
        items: {
          type: "object",
          required: ["subject", "predicate", "object"],
          properties: { subject: { type: "string" }, predicate: { type: "string" }, object: { type: "string" }, weight: { type: "number" } },
        },
      },
      source: { type: "string" },
      userId: { type: "string", description: "图命名空间。与 namespace 二选一必填。" },
      namespace: { type: "string", description: "图命名空间。与 userId 二选一必填。" },
    },
  },
  GraphTriplesResult: { type: "object", properties: { status: { type: "string" }, count: { type: "integer" }, triples: { type: "array" } } },
  GraphExportRequest: {
    type: "object",
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      format: {
        type: "string",
        enum: ["jsonld", "ntriples", "turtle", "graphml", "json-triples"],
        description: "开放导出格式；默认 jsonld",
      },
      userId: { type: "string" },
      namespace: { type: "string" },
    },
  },
  GraphExportResult: {
    type: "object",
    properties: {
      status: { type: "string" },
      format: { type: "string" },
      contentType: { type: "string" },
      body: { type: "string" },
      tripleCount: { type: "integer" },
      antiLockIn: { type: "object" },
    },
  },
  GraphImportRequest: {
    type: "object",
    anyOf: [{ required: ["userId"] }, { required: ["namespace"] }],
    properties: {
      format: { type: "string" },
      content: { type: "string" },
      body: { type: "string" },
      triples: { type: "array" },
      source: { type: "string" },
      userId: { type: "string" },
      namespace: { type: "string" },
    },
  },
  ImageEmbed: {
    type: "object",
    description:
      "对 KGM 路由 `POST /v1/kgm/multimodal/embed`；进程侧经 `embedImageRemote` 访问上游。环境变量：KGM_MULTIMODAL_BASE_URL（必填）、KGM_MULTIMODAL_PATH（默认 /v1/embeddings）、KGM_MULTIMODAL_MODEL、KGM_MULTIMODAL_KEY、KGM_MULTIMODAL_TIMEOUT_MS；KGM_MULTIMODAL_JSON_TEMPLATE=1 时对上游体为 {model,image,mime,text?}，否则 {model,input:[dataUrl]}。",
    required: ["imageBase64"],
    properties: {
      imageBase64: { type: "string", description: "仅 base64 内容，无 data: 前缀" },
      mimeType: { type: "string", example: "image/png" },
      text: { type: "string", description: "可选，与图联合编码时传入（模板模式写入上游）" },
      model: { type: "string", description: "覆盖 KGM_MULTIMODAL_MODEL" },
    },
  },
  ImageEmbedResponse: {
    type: "object",
    required: ["embedding", "dim"],
    properties: { embedding: { type: "array", items: { type: "number" } }, dim: { type: "integer" } },
  },
  ToolList: { type: "object", properties: { tools: { type: "array" } } },
  ToolStats: { type: "object", required: ["total", "byName"], properties: { total: { type: "integer" }, byName: { type: "object", additionalProperties: { type: "integer" } } } },
  SchemaRecord: { type: "object" },
  SchemaRegister: {
    type: "object",
    required: ["schemaId", "version", "status", "schema"],
    properties: {
      schemaId: { type: "string" },
      version: { type: "string" },
      status: { type: "string", enum: ["draft", "active", "deprecated", "retired"] },
      schema: { type: "object" },
    },
  },
  KgmRequest: {
    type: "object",
    description: "KGM 调度主请求，见 `core/types` KgmRequest",
    properties: {
      userId: { type: "string" },
      input: { type: "string" },
      requestId: { type: "string" },
      sessionId: { type: "string" },
      kgm: { type: "object" },
    },
  },
  KgmExecuteResult: { type: "object", description: "调度输出，与 Schema 与工具链相关", additionalProperties: true },
  KceComputeRequest: {
    type: "object",
    description: "KCE 服务端计算请求；以 KgmRequest 为基础，额外支持 kce.mode / llm / graphLimit / memoryTopK / maxParallel。",
    required: ["userId", "input"],
    properties: {
      userId: { type: "string" },
      input: { type: "string" },
      requestId: { type: "string" },
      sessionId: { type: "string" },
      constraints: { type: "object" },
      kgm: { type: "object" },
      kce: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "balanced", "quality"] },
          llm: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
            },
          },
          graphLimit: { type: "integer", minimum: 1, maximum: 32 },
          memoryTopK: { type: "integer", minimum: 0, maximum: 16 },
          maxParallel: { type: "integer", minimum: 1, maximum: 8 },
        },
      },
    },
  },
  KceComputeResult: {
    type: "object",
    required: ["answer", "evidence", "reasoning_trace", "execution_plan", "validation", "metrics"],
    properties: {
      request_id: { type: "string" },
      session_id: { type: "string" },
      trace_id: { type: "string" },
      answer: { type: "string" },
      logical_form: { type: "object" },
      session_ref: { type: "object", description: "会话审计引用，供 GET /v1/kgm/sessions/:id 使用。" },
      artifacts: {
        type: "object",
        properties: {
          request: { type: "object", description: "KCE 请求快照 artifact 引用" },
          trace: { type: "object", description: "KCE reasoning/validation trace artifact 引用" },
          response: { type: "object", description: "KCE 最终响应 artifact 引用" },
        },
      },
      evidence: {
        type: "object",
        properties: {
          nodes: { type: "array" },
          edges: { type: "array" },
          subgraph_id: { type: "string" },
          memory: { type: "array", items: { $ref: "#/components/schemas/Evidence" } },
        },
      },
      reasoning_trace: { type: "array" },
      execution_plan: { type: "object" },
      validation: { type: "object" },
      confidence: { type: "number" },
      metrics: {
        type: "object",
        properties: {
          total_latency_ms: { type: "number" },
          steps_executed: { type: "integer" },
          execution_batches: { type: "integer" },
          llm_calls: { type: "integer" },
          graph_triples: { type: "integer" },
          memory_evidence: { type: "integer" },
          validation_passed: { type: "boolean" },
        },
      },
    },
  },
  RoutingRollback: {
    type: "object",
    properties: { version: { type: "string" }, note: { type: "string" } },
  },
  StringMap: { type: "object", additionalProperties: { type: "string" } },
};
