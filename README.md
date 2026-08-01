# Yueli KGM Computing

自托管的 **OpenAI / Anthropic 兼容 AI 网关**：本地编排、受管推理 Worker、Playground 配置控制面。

[![npm version](https://img.shields.io/npm/v/@haxitag/yueli-kgm-computing.svg)](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing)
[![Node.js](https://img.shields.io/badge/node-20.x-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

```bash
npm install @haxitag/yueli-kgm-computing@latest
```

**文档**：[官网](https://haxitag.com/page/kgm) · [社区](https://haxitag.com/community/yuelikgm) · [GitHub](https://github.com/haxitag/Yueli-KGM-Computing) · 版本说明见下文（npm / 开源仓以本 README 为准）

---

## 它能做什么

- **兼容网关**：`/v1/chat/completions`、`/v1/responses`、Anthropic `/v1/messages`
- **本地推理**：llama.cpp / vLLM / SGLang / ds4 / TokenSpeed 等受管 Worker
- **Playground**：配置 LLM/Embedding、记忆后端、Worker 门闩、沙箱、Keys 分域
- **控制面**：HTTP 安全、前站、熔断/流式、Native/CORS/Discovery 只读状态
- **媒体薄代理**：生图 / TTS / ASR / 视频异步 job；声明式 `media.providers`（可选）

---

## 快速开始

```bash
npm install
npm run build
npm run dev:enhanced
# 打开 http://localhost:3000
```

生产建议：`KGM_HTTP_SECURITY_MODE=strict` + `KGM_HTTP_API_KEY`。

---

## 0.3.8

声明式媒体 Provider、stream≠auto、统一宿主错误、Xiaomi MiMo、Playground 对齐：

- **Media Provider**：`media.modelPresets` + `media.providers`（模板拼装 / JSONPath / 异步 poll → `kgm.media_job`）；未知显式 provider → **400**；旧 `KGM_*` 零回归
- **Stream ≠ Auto**：`stream` 只做交付；trusted passthrough 仅 managed / 默认 `llm`（含别名）；`model=auto` 走评分选路后再流式；头 `x-kgm-stream-source`
- **统一 `KgmError`**：厂商 HTTP 不透传，仅 `details.upstreamStatus`；LLM 上游失败 → **502** `LLM_UPSTREAM_ERROR`
- **Xiaomi MiMo**：`xiaomi` → `https://api.xiaomimimo.com/v1`，`mimo-v2.5-pro`，`MIMO_API_KEY`，auth `api-key`/`bearer`/`both`
- Playground 与 `/v1` 共用 AutoRouting；虚拟 Key / media job 租户隔离；critical e2e 上游 401→502、跨租户 job 404

```bash
npm install @haxitag/yueli-kgm-computing@0.3.8
```

---

## 文档与社区（HaxiTAG）

完整文档在 [阅粒知识计算引擎社区](https://haxitag.com/community/yuelikgm) 发布（需邮箱验证访问正文）；npm 包内容为 `README`、`dist/`、`playground/`、`LICENSE`（**不含**内部 `CHANGELOG.md` / `docs/`）。

| 主题 | 链接 |
|------|------|
| **新开发者使用指南** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw) |
| **开源组件说明** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-es923485r01d) |
| **性能优化配置** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-k9gyjbpkyq8t) |
| **多语言后端集成** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-7ipzi1bv7gho) |
| **集成实践** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-2muqnfrly7jc) |

---

## 历史版本摘要

### 0.3.7：OpenAI 兼容媒体薄代理
- 生图 / TTS / ASR / 视频异步 job / 可选 rerank；`GET /v1/models` 能力标注；未配置 → **501**

### 0.3.6：Worker/Provider · AutoRouting 契约
- TokenSpeed、runtimeId 亲和、显式 `KGM_*_ATTACH`；薄厂商 → `HttpLlmClient`；pricing / failover / 流式 idle

### 0.3.5：配置控制面 · Keys 分域
- Playground 可写 LLM/Embedding/记忆/Worker/Sandbox；Keys 安全分域；配置脱敏

### 0.3.4：前站 encoder 浅层 · Trace · Compose sidecar
- Trace / Request ID 对齐；前站意图 + Cross-Encoder + 抽取式摘要；`frontstation-worker` sidecar

### 0.3.3：算子复用 · 开放图导出
- 生产算子复用 llama.cpp / vLLM / SGLang；图导出 JSON-LD / N-Triples / Turtle / GraphML

### 0.3.1–0.3.0：YueliAI 网关 · MaaS Thinking
- YueliAI v1 反向代理；统一 MaaS Thinking / Reasoning 兼容

### 0.2.x：Copilot / Responses / 品牌统一
- Responses API、Copilot SSE、Critical E2E、Yueli KGM Runtime 品牌统一
<details>
<summary>更早功能清单（0.2.6 起）</summary>

### ✅ 新增功能

**品牌统一与用户体验**
- 统一品牌标识：将所有用户可见的错误消息、日志输出更新为 `Yueli KGM Runtime` 品牌标识
- 保持 API 兼容性：类名、类型名、配置值、环境变量保持不变

**模型管理增强**
- 模型扫描发现：`POST /v1/models/discover`
- 模型上传 / 删除 / 标签管理 API

**核心能力概览**

| 能力类别 | 支持内容 |
|---------|---------|
| **多厂商支持** | 30+ 主流 LLM 提供商 |
| **本地推理引擎** | Ollama、vLLM、SGLang、LM Studio、llama.cpp、ds4、TokenSpeed（可选 agentic worker） |
| **统一 API** | OpenAI Chat/Completions、Anthropic Messages 兼容 |
| **智能路由** | 多 API Key 轮询、自动故障转移 |
| **知识图谱** | 图检索、社区发现、规则推理 |

</details>

---

- **环境**：Node **20.x**（与 `package.json` 的 `engines` 一致）
- **官网**：[Yueli KGM Computing 产品页](https://haxitag.com/page/kgm)
- **社区文档**：[阅粒知识计算引擎主题](https://haxitag.com/community/yuelikgm)
- **npm**：[@haxitag/yueli-kgm-computing](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing)
- **GitHub**：[haxitag/Yueli-KGM-Computing](https://github.com/haxitag/Yueli-KGM-Computing)
- **npm 包内容**：`dist/` + `playground/` + `README` + `LICENSE`；完整文档以社区与官网为准
- **生产加固**：`NODE_ENV=production`（或 `KGM_HTTP_SECURITY_MODE=strict`）**强制** `KGM_HTTP_API_KEY`；未设限流时默认 **120 req/分钟**；`KGM_HTTP_AUTH_EXEMPT` 默认 `/health,/metrics,/openapi.json`；`KGM_HTTP_TRUST_PROXY=1` 才信任 `X-Forwarded-For`。本地开发默认 permissive。上游 LLM 经 **opossum** 按 host 熔断（`KGM_CIRCUIT_BREAKER_*`）。Managed worker（vLLM/SGLang/llama.cpp/MLX）异常退出默认**自动重启**（`KGM_WORKER_AUTO_RESTART`，指数退避）；自动路由在首 token 前失败时可 **stream failover** 到 default 候选。
- **OpenAPI 3.1**：`GET /openapi.json`
- **Runtime 观测层**：`GET /v1/runtime/status`、`/topology`、`/discovery`、`/diagnostics`，以及 `POST /v1/runtime/route/explain`
- **检索三阶段**：`kgm.retrieval.strategy=hybrid`、`kgm.retrieval.rerank=embed|http`
- **图与多模态**：图社区 / 规则推理；`POST /v1/kgm/multimodal/embed`（`KGM_MULTIMODAL_*`）

---

## Non-goals

KGM 主包聚焦统一推理入口、模型与引擎生命周期、动态路由、运行时可观测性。以下能力不由 KGM 主包持有：

- KGM 不管理应用层 session / 对话历史（编排层可选用 SessionStore；应用仍应自持权威对话状态）
- KGM 不执行应用业务 skill 逻辑本身；承载 OpenAI Compatible 的 `tools` / `tool_choice` 协议，以及可执行 steps 的技能运行时
- KGM 不持有应用端 UI 状态

**Multi-agent**：KGM 提供有界 **supervisor + specialists** 协作（`POST /v1/agent-runs`），不是无限 swarm / 自治复制。Skills registry 与 Workflow 仍建议以可替换扩展形式演进，避免主包承担任意应用编排。

**TokenSpeed**：与 Ollama 同级的可选 OpenAI-compat **managed worker**（生产推荐 `KGM_TOKENSPEED_ENABLED=auto` + `KGM_TOKENSPEED_BASE_URL` attach；默认 off）。吸收其 agentic 服务模式（会话连续性、原生 tool_calls、RequestStats / `kgm.perf`），**不是** KGM 的意图/技能层；内核不并入 native-gpu。专节：[`docs/tokenspeed-worker.md`](./docs/tokenspeed-worker.md)。

**Worker / Provider 覆盖审计**：会话 · 工具 · SLO · 评测四维以代码为准，见 [`docs/worker-provider-session-tools-slo-eval-audit.md`](./docs/worker-provider-session-tools-slo-eval-audit.md)。控制面「Agentic 计数」为进程内快照，**不是** Prometheus SLA。

**Evaluation / FDE**：Context 层选型评估框架（FDE）由**独立组件**承载，**不在 KGM 主包实现**。KGM 仅提供可运行的 ContextBuilder / YCB 汇合面，供外部 FDE 挂接评测。

---

## 快速开始（带 Playground）

```bash
mkdir kgm-host && cd kgm-host
npm init -y
npm install @haxitag/yueli-kgm-computing@latest

export PORT=58691
export KGM_LLM_BASE_URL="https://api.openai.com/v1"
export KGM_LLM_API_KEY="sk-..."
export KGM_LLM_MODEL="gpt-4o-mini"
export KGM_LLM_MODE="chat"
export KGM_LLM_PATH="/chat/completions"
export KGM_MOCK_MODE=0

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

## Runtime Layer 与应用端预检

应用端推荐启动时先调用：

```bash
curl -sS http://127.0.0.1:3000/v1/runtime/status
curl -sS http://127.0.0.1:3000/v1/runtime/discovery
curl -sS http://127.0.0.1:3000/v1/models/effective
```

发起推理前可用 `POST /v1/runtime/route/explain` 做 preflight。该接口不执行推理、不消耗 token，只返回 KGM 会选择的路径、候选模型、阻塞问题和 `wouldUseMock`。

`KGM_MOCK_MODE=1` 仅用于本地开发；所有受影响响应会带 `kgm.mock=true`，`/v1/runtime/status` 会返回 `mockMode=true`。生产环境应 unset 或设置 `KGM_MOCK_MODE=0`。

### KGM 核心环境变量

配置优先级为：`env > playground > discovery > config-file > default`。`/v1/runtime/status` 会在 `llm.source` / `embedding.source` 中暴露当前可识别来源。

```text
KGM_LLM_BASE_URL / KGM_LLM_API_KEY / KGM_LLM_MODEL / KGM_LLM_PATH / KGM_LLM_MODE / KGM_LLM_PROVIDER
KGM_EMBEDDING_BASE_URL / KGM_EMBEDDING_API_KEY / KGM_EMBEDDING_MODEL / KGM_EMBEDDING_PATH / KGM_EMBEDDING_PROVIDER
KGM_DISCOVERY_ENABLED / KGM_DISCOVERY_PORTS / KGM_DISCOVERY_TIMEOUT_MS
KGM_MOCK_MODE
KGM_HTTP_API_KEY / KGM_HTTP_RATE_LIMIT_MAX / KGM_HTTP_RATE_LIMIT_WINDOW_MS
KGM_CONFIG_PATH / KGM_DB_PATH / KGM_VECTOR_BACKEND
KGM_FRONTSTATION_MODE / KGM_FRONTSTATION_*_URL / KGM_FRONTSTATION_PREFER_ONNX / KGM_FRONTSTATION_ONNX_MODEL
```

前站浅层（encoder 轨，进 LLM 前；与 decoder-only Native GPU 分轨）：

```bash
# 本地：ONNX MiniLM 或 hash 回退（见 .env.example）
export KGM_FRONTSTATION_MODE=auto
export KGM_FRONTSTATION_PREFER_ONNX=1

# Docker Compose：自动拉起 frontstation-worker 并注入 URL
export KGM_HTTP_API_KEY=$(openssl rand -hex 16)
docker compose up --build
# worker: :8091/health ；kgm: :3000
```

自动发现本机 OpenAI-compatible 引擎示例：

```bash
export KGM_DISCOVERY_ENABLED=1
export KGM_DISCOVERY_PORTS="11434 8002 8080 1234 8000 5000 8095"
export KGM_DISCOVERY_TIMEOUT_MS=2000
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

server.listen(process.env.PORT || 58691);
```

更细的实战步骤与排错仍以官网文档为准。

---

## 架构概述

### 核心技术栈

| 分类 | 技术 | 版本/说明 |
|------|------|-----------|
| **运行环境** | Node.js | 20.x |
| **核心语言** | TypeScript | 5.x |
| **原生集成** | C++ (Node.js Addon) | CUDA 推理后端 |
| **进程管理** | Rust | 推理核心进程管理 |
| **数据库** | SQLite / PostgreSQL | 配置与状态存储 |
| **向量存储** | Chroma | 嵌入向量检索 |

### 关键模块

| 模块 | 文件路径 | 功能 |
|------|----------|------|
| **Scheduler (FSM)** | `src/scheduler/fsm.ts` | 核心调度器，处理多轮对话、工具执行 |
| **KCE** | `src/kce/engine.ts` | 知识计算引擎，DAG 执行框架 |
| **DAG Scheduler** | `src/tools/dagScheduler.ts` | 独立 DAG 编排器 |
| **Rust 集成** | `src/native/rustIntegration.ts` | Rust 推理核心进程管理 |
| **C++ Addon** | `native-core/` | CUDA/native 推理后端 |

### 跨语言集成架构

```
┌─────────────────────────────────────────────────────────────────┐
│              @haxitag/yueli-kgm-computing (NPM Package)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │ Rust 推理   │  │ Golang 推理 │  │ Python 推理 │           │
│  │ (STDIO IPC) │  │ (gRPC/IPC)  │  │ (HTTP API)  │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                                 │
│  ┌─────────────┐                                                │
│  │ C++ Addon   │                                                │
│  │ (CUDA/原生) │                                                │
│  └─────────────┘                                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 集成方式对比

| 技术栈 | 集成方式 | 复杂度 | 适用场景 |
|--------|----------|--------|----------|
| **Node.js** | 直接 import NPM 包 | 无 | 单体应用、自建网关 |
| **Rust** | 子进程 + STDIO JSON | 低 | 高性能推理引擎 |
| **Golang** | gRPC/HTTP 或子进程 | 中 | 微服务架构 |
| **Python** | HTTP API (OpenAI 兼容) | 低-中 | 现有 AI 生态集成 |
| **C++** | Node.js Addon | 高 | 极致性能要求 |

---

## 跨语言集成指南

KGM 作为 NPM 包，可与 Rust、Golang、Python、Node.js、C++ 等技术栈灵活集成。以下是常见集成方案：

### Node.js 直接集成（推荐）

```typescript
import { createRuntime, createKgmServer } from "@haxitag/yueli-kgm-computing";

// 初始化运行时
const runtime = createRuntime({
  llm: {
    baseURL: process.env.KGM_LLM_BASE_URL,
    apiKey: process.env.KGM_LLM_API_KEY,
    model: process.env.KGM_LLM_MODEL,
  },
});

// 创建服务
const server = createKgmServer({
  scheduler: runtime.scheduler,
  contextBuilder: runtime.contextBuilder,
  llmClient: runtime.llmClient,
  toolRegistry: runtime.toolRegistry,
  memoryStore: runtime.memoryStore,
  graphStore: runtime.graphStore,
  embedder: runtime.embedder,
});

server.listen(3000);
```

### Rust 集成（子进程 + STDIO）

适用于需要高性能推理引擎的场景：

```rust
// rust_engine/src/main.rs
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader, Write};

#[derive(Serialize)]
struct InferenceRequest {
    model: String,
    prompt: String,
    max_tokens: u32,
}

#[derive(Deserialize)]
struct InferenceResponse {
    content: String,
    tokens: u32,
}

fn inference(request: InferenceRequest) -> Result<InferenceResponse, Box<dyn std::error::Error>> {
    let mut child = Command::new("./target/release/shimmy")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(serde_json::to_string(&request)?.as_bytes())?;
    drop(stdin);

    let reader = BufReader::new(child.stdout.take().unwrap());
    let response: InferenceResponse = serde_json::from_reader(reader)?;
    Ok(response)
}
```

```typescript
// src/integrations/rustEngine.ts
import { spawn, ChildProcess } from 'child_process';

export class RustEngineClient {
  private process: ChildProcess;

  constructor(binaryPath: string) {
    this.process = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  }

  async inference(request: {
    model: string;
    prompt: string;
    max_tokens: number;
  }): Promise<{ content: string; tokens: number }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(request) + '\n';
      this.process.stdin?.write(data);

      let buffer = '';
      const handler = (chunk: Buffer) => {
        buffer += chunk.toString();
        try {
          const response = JSON.parse(buffer);
          this.process.stdout?.removeListener('data', handler);
          resolve(response);
        } catch {
          // 继续接收数据
        }
      };
      this.process.stdout?.on('data', handler);
      this.process.stderr?.on('data', (d) => reject(d.toString()));
    });
  }
}
```

### C++ 集成（Node.js Addon）

适用于需要极致性能的场景，通过 Node.js C++ Addon 直接调用 CUDA 推理：

```cpp
// native-core/src/inference.cpp
#include <napi.h>
#include <cuda_runtime.h>
#include "model_loader.h"
#include "inference_engine.h"

class InferenceEngineWrapper : public Napi::ObjectWrap<InferenceEngineWrapper> {
private:
    std::unique_ptr<InferenceEngine> engine;

public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "InferenceEngine", {
            InstanceMethod("loadModel", &InferenceEngineWrapper::LoadModel),
            InstanceMethod("complete", &InferenceEngineWrapper::Complete),
            InstanceMethod("stream", &InferenceEngineWrapper::Stream),
            InstanceMethod("release", &InferenceEngineWrapper::Release),
        });
        exports.Set("InferenceEngine", func);
        return exports;
    }

    Napi::Value LoadModel(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        std::string modelPath = info[0].As<Napi::String>();
        
        engine = std::make_unique<InferenceEngine>();
        engine->Load(modelPath);
        
        return Napi::Boolean::New(env, true);
    }

    Napi::Value Complete(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        std::string prompt = info[0].As<Napi::String>();
        
        std::string result = engine->Complete(prompt);
        return Napi::String::New(env, result);
    }

    Napi::Value Stream(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        std::string prompt = info[0].As<Napi::String>();
        Napi::Function callback = info[1].As<Napi::Function>();
        
        engine->Stream(prompt, [callback](const std::string& token) {
            callback.Call({Napi::String::New(callback.Env(), token)});
        });
        
        return env.Undefined();
    }

    Napi::Value Release(const Napi::CallbackInfo& info) {
        engine->Release();
        engine.reset();
        return Napi::Boolean::New(info.Env(), true);
    }
};

NODE_API_MODULE(yueli_native, InferenceEngineWrapper::Init)
```

```typescript
// src/integrations/cppEngine.ts
import { InferenceEngine } from '../native/bindings';

export class CppInferenceClient {
  private engine: InferenceEngine;

  constructor() {
    this.engine = new InferenceEngine();
  }

  async loadModel(modelPath: string): Promise<void> {
    this.engine.loadModel(modelPath);
  }

  async complete(prompt: string): Promise<string> {
    return this.engine.complete(prompt);
  }

  async* stream(prompt: string): AsyncGenerator<string> {
    return new Promise((resolve) => {
      this.engine.stream(prompt, (token: string) => {
        yield token;
      });
      resolve();
    });
  }

  release(): void {
    this.engine.release();
  }
}
```

### Golang 集成（gRPC）

适用于微服务架构：

```protobuf
// proto/kgm.proto
syntax = "proto3";
package kgm;

service Orchestrator {
  rpc Orchestrate(OrchestrateRequest) returns (OrchestrateResponse);
  rpc StreamOrchestrate(stream OrchestrateRequest) returns (stream OrchestrateResponse);
}

message OrchestrateRequest {
  string query = 1;
  map<string, string> context = 2;
  repeated string tools = 3;
}

message OrchestrateResponse {
  string answer = 1;
  repeated ToolCall tool_calls = 2;
  map<string, string> metadata = 3;
}

message ToolCall {
  string tool = 1;
  map<string, string> params = 2;
  string result = 3;
}
```

```typescript
// src/integrations/golangGrpc.ts
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = './proto/kgm.proto';
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const kgmProto = grpc.loadPackageDefinition(packageDef) as any;

export class GolangOrchestratorClient {
  private client: any;

  constructor(address: string = 'localhost:50051') {
    this.client = new kgmProto.kgm.Orchestrator(
      address,
      grpc.credentials.createInsecure()
    );
  }

  orchestrate(query: string, context: Record<string, string> = {}, tools: string[] = []) {
    return new Promise((resolve, reject) => {
      this.client.Orchestrate(
        { query, context, tools },
        (err: any, response: any) => {
          if (err) reject(err);
          else resolve(response);
        }
      );
    });
  }
}
```

### Python 集成（HTTP API / OpenAI 兼容）

KGM 原生支持 OpenAI 兼容接口，Python 应用可直接调用：

```python
# python_client.py
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="http://localhost:3000/v1"  # KGM 服务地址
)

# 方式 1：直接使用 OpenAI 兼容接口
response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "system", "content": "你是一个助手"},
        {"role": "user", "content": "你好，请介绍一下自己"}
    ]
)
print(response.choices[0].message.content)

# 方式 2：使用 KGM 扩展接口
import requests

# 调用知识图谱检索
graph_response = requests.post(
    "http://localhost:3000/v1/kgm/graph/retrieve",
    headers={"Authorization": "Bearer your-api-key"},
    json={"query": "查找相关实体", "top_k": 5}
)
print(graph_response.json())
```

### Python Orchestrator 桥接（避免生态不匹配）

如果需要复用现有 Python Orchestrator 的调度逻辑，可通过以下方式桥接：

```python
# python_orchestrator_bridge.py
from flask import Flask, request, jsonify
from kgm_client import KGMRestClient

app = Flask(__name__)
kgm = KGMRestClient("http://localhost:3000")

@app.route("/orchestrate", methods=["POST"])
def orchestrate():
    """
    Python Orchestrator 桥接服务
    将 Python 侧的调度逻辑暴露为 HTTP API
    """
    data = request.json
    query = data.get("query")
    strategy = data.get("strategy", "auto")

    # 调用 KGM 的原生能力（知识图谱、记忆检索等）
    graph_result = kgm.graph.query(query)
    memory_result = kgm.memory.search(query)

    # Python 侧的业务调度逻辑
    orchestrated_result = your_orchestrator_logic(
        query=query,
        graph_data=graph_result,
        memory_data=memory_result,
        strategy=strategy
    )

    return jsonify(orchestrated_result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
```

```typescript
// src/integrations/pythonBridge.ts
import { createLLMClient } from '../llm/client';

export class PythonOrchestratorBridge {
  private baseURL: string;
  private client: ReturnType<typeof createLLMClient>;

  constructor(baseURL: string = 'http://localhost:8000') {
    this.baseURL = baseURL;
    this.client = createLLMClient({
      provider: 'openai-compatible',
      baseURL: `${baseURL}/v1`,
      apiKey: 'dummy',
      model: 'orchestrator',
    });
  }

  async orchestrate(query: string, strategy = 'auto') {
    const response = await fetch(`${this.baseURL}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, strategy }),
    });
    return response.json();
  }
}
```

---

## 版本更新流程

### 开发环境更新
```bash
# 更新到最新版本
npm install @haxitag/yueli-kgm-computing@latest

# 查看当前版本
npm list @haxitag/yueli-kgm-computing

# 升级到指定版本
npm install @haxitag/yueli-kgm-computing@0.3.8
```

### 开源仓库同步（维护者）
```bash
# 确保本地开发分支最新
git checkout main
git pull origin main

# 必须用同步脚本（过滤 docs/.cursor/data/tests 等后再 force 推公开仓）
# 禁止：git push public main
bash scripts/sync-to-public.sh
```
---

## 从源码开发本仓库

```bash
git clone <你的仓库> && cd <仓库目录>
npm install
npm run build
npm run dev:enhanced
```

---

## 版本说明（当前：`0.3.8`）

详见上方「0.3.8」。历史版本摘要见「历史版本摘要」一节。npm / 开源仓以本 README 为准。

### 本地 GPU 推理支持

| 模型系列 | 文件 | 状态 |
|---------|------|------|
| **Qwen 3.5/3.6** | [src/native/gpu/qwen3.ts](./src/native/gpu/qwen3.ts) | ✅ |
| **GLM 5.0/5.1** | [src/native/gpu/glm5.ts](./src/native/gpu/glm5.ts) | ✅ |
| **Google Gemma 4** | [src/native/gpu/gemma4.ts](./src/native/gpu/gemma4.ts) | ✅ |
| **MiniMax 2.5/2.7** | [src/native/gpu/minimax25.ts](./src/native/gpu/minimax25.ts) | ✅ |
| **MiMo 2.5** | [src/native/gpu/mimo25.ts](./src/native/gpu/mimo25.ts) | ✅ |
| **vMLX (Apple Silicon)** | [src/native/gpu/vmlxAdapter.ts](./src/native/gpu/vmlxAdapter.ts) | ✅ |

```bash
npm run test:native-gpu-models
```

---

**官方资源**

- **官网**: [Yueli KGM Computing](https://haxitag.com/page/kgm)
- **社区**: [阅粒知识计算引擎主题](https://haxitag.com/community/yuelikgm)
- **npm**: [@haxitag/yueli-kgm-computing](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing)
- **GitHub**: [haxitag/Yueli-KGM-Computing](https://github.com/haxitag/Yueli-KGM-Computing)
- **新开发者使用指南**: [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw)
- **开源组件说明**: [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-es923485r01d)
- **推理引擎优化（性能配置）**: [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-k9gyjbpkyq8t)
- **Rust / Go / Python / C++ 集成**: [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-7ipzi1bv7gho)
- **集成具体操作实践**: [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-2muqnfrly7jc)
