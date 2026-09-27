import { postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";

export type ImageEmbedRequest = {
  imageBase64: string;
  /** 如 `image/png`；缺省由 data url 或 octet-stream 推断 */
  mimeType?: string;
  text?: string;
  model?: string;
};

/**
 * 通过 HTTP 调用本地/远端多模态嵌入服务（**具体模型在部署侧**；可为本机向量服务、自建网关或云 API）。
 *
 * **进程环境变量**（均可用 `embedImageRemote` 同名参数覆盖）：
 * - `KGM_MULTIMODAL_BASE_URL`：必填。主机名或已含 `http(s)://` 的基址，末尾可不带 `/`。
 * - `KGM_MULTIMODAL_PATH`：默认 `"/v1/embeddings"`，与 `BASE_URL` 拼成完整上游 URL。
 * - `KGM_MULTIMODAL_MODEL`：默认 `"clip"`，写入对上游 JSON 的 `model` 字段。
 * - `KGM_MULTIMODAL_KEY`：可选；若设置则发 `Authorization: Bearer <key>`。
 * - `KGM_MULTIMODAL_TIMEOUT_MS`：默认 `120000`（毫秒）。
 * - `KGM_MULTIMODAL_JSON_TEMPLATE`：设为 `"1"` 时见下文「模板模式」。
 *
 * **默认模式**（未设 `KGM_MULTIMODAL_JSON_TEMPLATE=1`）：对上游发送
 * `{ "model", "input": [ "<dataUrl>" ] }`，
 * 其中 `dataUrl = "data:" + (mimeType ?? "image/png") + ";base64," + imageBase64`。
 * 适用于接受 `input` 为单条 data URL 字符串的 OpenAI 风格 Embeddings 等接口。
 *
 * **模板模式** `KGM_MULTIMODAL_JSON_TEMPLATE=1`：改发
 * `{ "model", "image": <base64 原文>, "mime", "text"?: <可选> }`，供自研/适配服务解析。
 * 成功时从响应 JSON 的 `embedding` 或 `data` 或 `vector` 之一读取 `number[]`。
 */
export async function embedImageRemote(params: {
  request: ImageEmbedRequest;
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<number[]> {
  const base = (params.baseUrl ?? process.env.KGM_MULTIMODAL_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) {
    throw new Error("KGM_MULTIMODAL_BASE_URL is not set");
  }
  const path = params.path ?? process.env.KGM_MULTIMODAL_PATH ?? "/v1/embeddings";
  const model = params.model ?? process.env.KGM_MULTIMODAL_MODEL ?? "clip";
  const apiKey = params.apiKey ?? process.env.KGM_MULTIMODAL_KEY;
  const timeoutMs = params.timeoutMs ?? Number.parseInt(process.env.KGM_MULTIMODAL_TIMEOUT_MS ?? "120000", 10);
  const mime = params.request.mimeType ?? "image/png";
  const dataUrl = `data:${mime};base64,${params.request.imageBase64}`;

  const url = base.startsWith("http") ? joinUrl(base, path) : joinUrl(`http://${base}`, path);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  if (process.env.KGM_MULTIMODAL_JSON_TEMPLATE === "1") {
    const data = (await postJson(
      url,
      {
        model,
        image: params.request.imageBase64,
        mime: mime,
        text: params.request.text,
      },
      { headers, timeoutMs },
    )) as { embedding?: number[]; data?: number[]; vector?: number[] };
    const v = data.embedding ?? data.data ?? data.vector;
    if (!v || !Array.isArray(v)) {
      throw new Error("multimodal: no embedding in response");
    }
    return v;
  }

  const data = (await postJson(
    url,
    {
      model,
      input: [dataUrl],
    },
    { headers, timeoutMs },
  )) as { data?: Array<{ embedding: number[] }>; embedding?: number[] };
  const emb = data.embedding ?? data.data?.[0]?.embedding;
  if (!emb) {
    throw new Error("multimodal: OpenAI-style response missing embedding");
  }
  return emb;
}
