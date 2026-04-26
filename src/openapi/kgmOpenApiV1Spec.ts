import { openApiResponseComponents } from "./parts/responseComponents.js";
import { openApiSchemaComponents } from "./parts/schemaComponents.js";
import { buildOpenApiPathsV1 } from "./parts/pathComponents.js";

/**
 * KGM HTTP API — OpenAPI 3.1（`createKgmServer` / `enhancedStart` 等暴露的 REST 面，不含 Playground 静态与 `/api/kgm` Playground 私有接口）。
 * `components.schemas` 与 `paths` 拆在 `src/openapi/parts/*` 便于维护。
 */
export function getKgmOpenApiV1(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Yueli KGM Computing API",
      version: "1.0.0",
      description:
        "OpenAI/Anthropic 兼容层与 `/v1/kgm/*` 管理面。安全：`KGM_HTTP_API_KEY` + `KGM_HTTP_AUTH_EXEMPT`；限流：`KGM_HTTP_RATE_LIMIT_*`。多模态上游：`KGM_MULTIMODAL_*`。Rerank 外呼：`KGM_RERANK_HTTP_URL`。",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "与 Authorization: Bearer 一致" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      responses: openApiResponseComponents,
      schemas: openApiSchemaComponents,
    },
    paths: buildOpenApiPathsV1(),
  };
}
