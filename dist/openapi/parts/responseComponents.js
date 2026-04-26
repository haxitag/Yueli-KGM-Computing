const err = (desc) => ({
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
export const openApiResponseComponents = {
    BadRequest: err("错误请求（如 JSON 非法、缺少必填字段）"),
    Unauthorized: err("未提供有效 API Key / Bearer，且路径不在豁免列表"),
    NotFound: err("资源不存在或路由未实现"),
    NotImplemented: err("服务未启用该能力（如可选模块未配置）"),
    RateLimited: err("超过 HTTP 限流（见 Retry-After 响应头）"),
    ServerError: err("服务内部错误"),
};
