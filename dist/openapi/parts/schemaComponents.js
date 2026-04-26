/**
 * OpenAPI `components.schemas`：字段级或约束级描述，按模块分块，由 `getKgmOpenApiV1` 合并。
 */
export const openApiSchemaComponents = {
    KgmError: {
        type: "object",
        required: ["error"],
        properties: {
            error: {
                type: "object",
                required: ["code", "message", "status"],
                properties: {
                    code: { type: "string", description: "可机读错误码，如 invalid_json, unauthorized, rate_limited" },
                    message: { type: "string" },
                    status: { type: "integer", description: "与 HTTP 状态码一致" },
                },
            },
        },
    },
    HealthOk: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", const: "ok" } },
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
        properties: { from: { type: "string" }, to: { type: "string" }, maxHops: { type: "integer" } },
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
        properties: {
            entity: { type: "string" },
            maxDepth: { type: "integer" },
            relations: { type: "array", items: { type: "string" } },
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
        properties: {
            rules: { type: "array", items: { $ref: "#/components/schemas/GraphRule" } },
            maxRounds: { type: "integer" },
            source: { type: "string" },
        },
    },
    GraphRulesResult: { type: "object", required: ["added", "count"], properties: { added: { type: "array" }, count: { type: "integer" } } },
    GraphTriplesRequest: {
        type: "object",
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
        },
    },
    GraphTriplesResult: { type: "object", properties: { status: { type: "string" }, count: { type: "integer" }, triples: { type: "array" } } },
    ImageEmbed: {
        type: "object",
        description: "对 KGM 路由 `POST /v1/kgm/multimodal/embed`；进程侧经 `embedImageRemote` 访问上游。环境变量：KGM_MULTIMODAL_BASE_URL（必填）、KGM_MULTIMODAL_PATH（默认 /v1/embeddings）、KGM_MULTIMODAL_MODEL、KGM_MULTIMODAL_KEY、KGM_MULTIMODAL_TIMEOUT_MS；KGM_MULTIMODAL_JSON_TEMPLATE=1 时对上游体为 {model,image,mime,text?}，否则 {model,input:[dataUrl]}。",
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
    RoutingRollback: {
        type: "object",
        properties: { version: { type: "string" }, note: { type: "string" } },
    },
    StringMap: { type: "object", additionalProperties: { type: "string" } },
};
