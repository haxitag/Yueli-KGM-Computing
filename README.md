# Yueli KGM Computing

`@haxitag/yueli-kgm-computing` — 阅粒 **KGM**（Knowledge Graph & Model runtime）：自托管的 **OpenAI / Anthropic 兼容网关与编排层**，内建 **进程内 Native 推理** 与 **受管模型控制面**；支持 `kgm` 扩展（工具、图谱信号、检索、观测等）。

- **环境**：Node **20.x**（与 `package.json` 的 `engines` 一致）
- **官方文档**（能力说明、部署、API、Playground 等）：[阅粒知识计算引擎 — HaxiTAG](https://www.haxitag.com/read/yueli-knowledge-computation-engine-system)
- **使用指南**（企业场景、落地与 Q&A 等）：[Yueli KGM Engine 使用指南](https://www.haxitag.com/articles/yueli-kgm-engine-enterprise-ai-qa-solution)
- **npm 包内容**：`dist/`（运行时代码）+ `playground/`（Web Playground 静态资源）+ 本 `README`；**不**再内置仓库中的大量 `docs/*.md`，以减小包体；完整文档以官网为准
- **生产加固（可选）**：`KGM_HTTP_API_KEY`（`Authorization: Bearer` 或 `X-API-Key`）；`KGM_HTTP_AUTH_EXEMPT` 逗号路径前缀，默认只豁免 `/health`（若开启 API Key 且需本机 Playground，可加入 `/api` 等前缀）；`KGM_HTTP_RATE_LIMIT_MAX` + `KGM_HTTP_RATE_LIMIT_WINDOW_MS`（`MAX=0` 表示不限流）
- **OpenAPI 3.1**：`GET /openapi.json`（主规范同 `src/openapi/kgmOpenApiV1Spec.ts`）
- **检索三阶段**：`kgm.retrieval.strategy=hybrid`（BM25+向量）、`kgm.retrieval.rerank=embed`（双塔成对编码）或 `rerank=http` + `KGM_RERANK_HTTP_URL`
- **图与多模态**
  - 图：`POST /v1/kgm/graph/communities`、`reason/expand`、`reason/rules` 等
  - 多模态：`POST /v1/kgm/multimodal/embed`：KGM 将请求转发到由环境变量指定的上游图像向量服务
    - 必填：`KGM_MULTIMODAL_BASE_URL`
    - 常用：`KGM_MULTIMODAL_PATH`（默认 `"/v1/embeddings"`）、`KGM_MULTIMODAL_MODEL`（默认 `"clip"`）、`KGM_MULTIMODAL_KEY`、`KGM_MULTIMODAL_TIMEOUT_MS`（默认 `120000`）
    - `KGM_MULTIMODAL_JSON_TEMPLATE=1`：对上游发 `{ model, image, mime, text? }`；否则默认 `{ model, input: [dataUrl] }`

---

## 快速开始（带 Playground）

```bash
mkdir kgm-host && cd kgm-host
npm init -y
npm install @haxitag/yueli-kgm-computing@latest

export PORT=3000
export KGM_LLM_BASE_URL="https://api.openai.com/v1"
export KGM_LLM_API_KEY="sk-..."
export KGM_LLM_MODEL="gpt-4o-mini"
export KGM_LLM_MODE="chat"
export KGM_LLM_PATH="/chat/completions"

node ./node_modules/@haxitag/yueli-kgm-computing/dist/server/enhancedStart.js
```

浏览器访问：`http://localhost:3000/`（Playground），`http://localhost:3000/metrics`（Prometheus 文本指标）。

**OpenAI 兼容**最小请求示例：

```bash
curl -sS "http://127.0.0.1:3000/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "用一句话说明 KGM 是什么" }
    ]
  }'
```

---

## 两种集成方式

### A. 独立服务（HTTP，适合多语言 / 多微服务）

在别处部署 KGM 进程，业务侧只调 HTTP：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，以及管理面 `/v1/kgm/*` 等。入口脚本可选：

- `dist/server/enhancedStart.js`：含 **Playground** 与相关路由
- `dist/server/start.js`：偏 **纯 API**（无内置 Playground 静态页）

### B. 进程内集成（Node，适合单体或自建网关）

```js
import { createRuntime, createKgmServer } from "@haxitag/yueli-kgm-computing";

const runtime = createRuntime({});
const server = createKgmServer({
  scheduler: runtime.scheduler,
  contextBuilder: runtime.contextBuilder,
  llmClient: runtime.llmClient,
  schemaRegistry: runtime.schemaRegistry,
  toolRegistry: runtime.toolRegistry,
  memoryStore: runtime.memoryStore,
  graphStore: runtime.graphStore,
  embedder: runtime.embedder,
  sandboxManager: runtime.sandboxManager,
  modelManager: runtime.modelManager,
  autoRoutingClient: runtime.autoRoutingClient,
  configStore: runtime.configStore,
  skillRuntime: runtime.skillRuntime,
  artifactStore: runtime.artifactStore,
  sessionStore: runtime.sessionStore
});

server.listen(process.env.PORT || 3000);
```

更细的实战步骤与排错仍以官网文档为准。

---

## 从源码开发本仓库

```bash
git clone <你的仓库> && cd <仓库目录>
npm install
npm run build
npm run dev:enhanced
```

---

## 版本说明

若曾固定旧版本（如 `0.1.3`）且首页文档不满意，**请升级至本包 `@latest`**；npm 上**不能覆盖已发布**的同版本号内容，旧版可维护者侧使用 `npm deprecate` 提示迁移（见 npm 官方说明）。
