const err = (desc: string) => ({
  description: desc,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/KgmError" },
    },
  },
});

/**
 * 可复用的 HTTP 响应块（`#/components/responses/*`），供各 path 的 `responses` 引用。
 */
export const openApiResponseComponents: Record<string, unknown> = {
  BadRequest: err("错误请求（如 JSON 非法、缺少必填字段）"),
  Unauthorized: err("未提供有效 API Key / Bearer，且路径不在豁免列表"),
  NotFound: err("资源不存在或路由未实现"),
  NotImplemented: err("服务未启用该能力（如可选模块未配置）"),
  RateLimited: err("超过 HTTP 限流（见 Retry-After 响应头）"),
  ServerError: err("服务内部错误"),
  BadGateway: err(
    "上游失败（媒体/LLM）；HTTP 恒为 502，厂商原始状态仅在 error.details.upstreamStatus",
  ),
  GatewayTimeout: err("上游轮询/网关超时（如 media_poll_timeout）"),
};
