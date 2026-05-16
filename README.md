# Yueli KGM Computing

`@haxitag/yueli-kgm-computing` — 阅粒 **KGM**（Knowledge Graph & Model runtime）：自托管的 **OpenAI / Anthropic 兼容网关与编排层**，内建 **进程内 Native 推理** 与 **受管模型控制面**；支持 `kgm` 扩展（工具、图谱信号、检索、观测等）。

> **NPM 安装**: [![npm version](https://badge.fury.io/js/@haxitag%2Fyueli-kgm-computing.svg)](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing)
> 
> ```bash
> npm install @haxitag/yueli-kgm-computing@latest
> ```

**快速入口**：[官网](https://haxitag.com/page/kgm) · [社区主题](https://haxitag.com/community/yuelikgm) · [npm 包](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing) · [GitHub](https://github.com/haxitag/Yueli-KGM-Computing)

---

## 文档与社区（HaxiTAG）

完整文档在 [阅粒知识计算引擎社区](https://haxitag.com/community/yuelikgm) 发布（需邮箱验证访问正文）；npm 包仅含 `README` 与运行时代码。

| 主题 | 链接 |
|------|------|
| **Yueli-KGM-Computing 新开发者使用指南** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw) |
| **Yueli KGM Computing 开源组件说明** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-es923485r01d) |
| **Yueli 推理引擎优化 — 性能优化配置使用指南** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-k9gyjbpkyq8t) |
| **后端 Rust / Go / Python / C++ 集成阅粒知识计算引擎** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-7ipzi1bv7gho) |
| **haxitag/yueli-kgm-computing 集成具体操作实践** | [社区文章](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-2muqnfrly7jc) |
| **官网与产品页** | [haxitag.com/page/kgm](https://haxitag.com/page/kgm) |
| **npm 包** | [@haxitag/yueli-kgm-computing](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing) |
| **GitHub 开源仓库** | [haxitag/Yueli-KGM-Computing](https://github.com/haxitag/Yueli-KGM-Computing) |

---

## 🚀 0.2.7 版本更新

### 本版要点
- **Critical E2E**：补充 `/v1/chat/completions` 与 `/v1/responses` 的 SSE 流式覆盖（含 `tool_calls`、`response.output_item.added` 等）；记录「同步路径 `502`」与「流式先返回 SSE `200` 后上游失败截断」的差异（见 `tests/e2e/critical-review-matrix.e2e.test.ts` 与部署文档）。

### 0.2.6 起延续：Yueli KGM Runtime 品牌统一

**1. 用户体验优化**
- 统一品牌标识：将所有用户可见的错误消息、日志输出从 `native_runtime_*` 格式更新为 `Yueli KGM Runtime` 品牌标识
- 更新 `src/models/modelManager.ts`、`src/native/backend.ts`、`src/native/loaders.ts`、`src/native/bindings.ts` 等核心模块的错误消息
- 保持 API 兼容性：类名（`NativeRuntimeEngine`）、类型名、配置值（`runtime: 'native'`）、环境变量（`KGM_NATIVE_*`）保持不变

**2. 文档体系完善**
- [新开发者使用指南](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw)（社区）：项目概述、快速开始、核心组件、本地推理、进程内集成、环境变量、调试与生产部署
- 代码示例为主，帮助新开发者快速上手

**3. 生产级发布准备**
- 完善的错误处理和日志输出体系
- 统一的用户可见消息格式
- 增强的开发者体验

### 关键改进
- **品牌一致性**: 统一的 `Yueli KGM Runtime` 品牌标识贯穿所有用户可见文本
- **文档增强**: 新增面向新开发者的完整使用指南
- **向后兼容**: 所有公共 API、类型定义、环境变量保持兼容
- **构建验证**: 完整的 TypeScript 编译和类型诊断通过

### 核心能力概览

| 能力类别 | 支持内容 |
|---------|---------|
| **多厂商支持** | 30+ 主流 LLM 提供商（OpenAI、Anthropic、智谱、阿里云、百度千帆等） |
| **本地推理引擎** | Ollama、vLLM、SGLang、LM Studio |
| **原生推理** | Yueli KGM Runtime（进程内张量计算），支持 kgm-json、GGUF、safetensors |
| **统一 API** | OpenAI Chat/Completions、Anthropic Messages 兼容 |
| **智能路由** | 多 API Key 轮询、自动故障转移 |
| **知识图谱** | 图检索、社区发现、规则推理 |
| **多模态** | 图像嵌入、视觉检索 |

### 快速入门

```typescript
// 创建 Yueli KGM Runtime 推理引擎
import { NativeRuntimeEngine } from '@haxitag/yueli-kgm-computing';

const engine = new NativeRuntimeEngine('./models/my-model.kgm.json', {
promptCacheLimit: 8,
sessionCacheLimit: 64,
schedulerMaxBatchSize: 8,
kvCacheMode: 'paged',
});

const result = await engine.complete('Hello, Yueli KGM!');
console.log(result.text);
```

---

- **环境**：Node **20.x**（与 `package.json` 的 `engines` 一致）
- **官网**：[Yueli KGM Computing 产品页](https://haxitag.com/page/kgm)
- **社区文档**：[阅粒知识计算引擎主题](https://haxitag.com/community/yuelikgm)（含[新开发者指南](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw)、[开源组件说明](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-es923485r01d)、[集成实践](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-2muqnfrly7jc)等）
- **npm**：[@haxitag/yueli-kgm-computing](https://www.npmjs.com/package/@haxitag/yueli-kgm-computing)
- **GitHub**：[haxitag/Yueli-KGM-Computing](https://github.com/haxitag/Yueli-KGM-Computing)
- **npm 包内容**：`dist/`（运行时代码）+ `playground/`（Web Playground 静态资源）+ 本 `README`；**不**再内置仓库中的大量 `docs/*.md`，以减小包体；完整文档以社区与官网为准
- **生产加固（可选）**：`KGM_HTTP_API_KEY`（`Authorization: Bearer` 或 `X-API-Key`）；`KGM_HTTP_AUTH_EXEMPT` 逗号路径前缀，默认只豁免 `/health`（若开启 API Key 且需本机 Playground，可加入 `/api` 等前缀）；`KGM_HTTP_RATE_LIMIT_MAX` + `KGM_HTTP_RATE_LIMIT_WINDOW_MS`（`MAX=0` 表示不限流）
- **OpenAPI 3.1**：`GET /openapi.json`（主规范同 `src/openapi/kgmOpenApiV1Spec.ts`）
- **Runtime 观测层**：`GET /v1/runtime/status`、`/topology`、`/discovery`、`/diagnostics`，以及 `POST /v1/runtime/route/explain`，用于应用端启动体检、模型发现、路由预检与失败解释
- **检索三阶段**：`kgm.retrieval.strategy=hybrid`（BM25+向量）、`kgm.retrieval.rerank=embed`（双塔成对编码）或 `rerank=http` + `KGM_RERANK_HTTP_URL`
- **图与多模态**
  - 图：`POST /v1/kgm/graph/communities`、`reason/expand`、`reason/rules` 等
  - 多模态：`POST /v1/kgm/multimodal/embed`：KGM 将请求转发到由环境变量指定的上游图像向量服务
    - 必填：`KGM_MULTIMODAL_BASE_URL`
    - 常用：`KGM_MULTIMODAL_PATH`（默认 `"/v1/embeddings"`）、`KGM_MULTIMODAL_MODEL`（默认 `"clip"`）、`KGM_MULTIMODAL_KEY`、`KGM_MULTIMODAL_TIMEOUT_MS`（默认 `120000`）
    - `KGM_MULTIMODAL_JSON_TEMPLATE=1`：对上游发 `{ model, image, mime, text? }`；否则默认 `{ model, input: [dataUrl] }`

---

## Non-goals

KGM 主包聚焦统一推理入口、模型与引擎生命周期、动态路由、运行时可观测性。以下能力不由 KGM 主包持有：

- KGM 不管理应用层 session / 对话历史
- KGM 不执行应用业务 skill；只承载 OpenAI Compatible 的 `tools` / `tool_choice` 协议
- KGM 不做 multi-agent orchestration
- KGM 不持有应用端 UI 状态

Agent、Workflow、Evaluation、Skills registry 等高层能力建议以 plugin extension 形式挂载，避免主包承担应用编排职责。

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
```

自动发现本机 OpenAI-compatible 引擎示例：

```bash
export KGM_DISCOVERY_ENABLED=1
export KGM_DISCOVERY_PORTS="11434 8002 8080 1234 8000 5000"
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

server.listen(process.env.PORT || 3000);
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
npm install @haxitag/yueli-kgm-computing@0.2.7
```

### 开源仓库同步（维护者）
```bash
# 确保本地开发分支最新
git checkout main
git pull origin main

# 运行同步脚本（自动清理敏感文件并推送到公开仓库）
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

## 版本说明（当前 npm：`0.2.7`）

**0.2.7**：Critical E2E 增补 SSE 流式场景；部署文档补充同步错误与流式截断的差异说明（见上文「本版要点」）。

**0.2.6 及延续**：以下「✅ 新增功能」等条目主要来自 **0.2.6** 发布公告，能力与兼容性与当前 **0.2.7** 一致。

### ✅ 新增功能

**品牌统一与用户体验**
- 统一品牌标识：将所有用户可见的错误消息、日志输出更新为 `Yueli KGM Runtime` 品牌标识
- 更新核心模块：`src/models/modelManager.ts`、`src/native/backend.ts`、`src/native/loaders.ts`、`src/native/bindings.ts`
- 保持 API 兼容性：类名、类型名、配置值、环境变量保持不变

**文档体系完善**
- [新开发者使用指南](https://haxitag.com/community/yuelikgm/yuelikgm_t-yuelikgm-6jnu87fondgw)（社区）：项目概述、快速开始、核心组件、本地推理、进程内集成、环境变量、调试与生产部署

**模型管理增强**
- 模型扫描发现：`POST /v1/models/discover` 扫描宿主机可用模型
- 模型上传：`POST /v1/models/upload` 上传本地模型文件
- 模型删除：`DELETE /v1/models/{model}` 删除模型
- 模型标签：`POST /v1/models/{model}/tags/add`、`/remove`、`PUT /v1/models/{model}/tags`

**流式响应稳定性**
- 流式请求超时控制（默认 5 分钟），可通过 `KGM_STREAM_TIMEOUT_MS` 配置
- 客户端断开连接检测与资源清理
- **安全增强**: 添加 `headersSent` 检查，防止重复发送响应头

**内存存储优化**
- LRU/FIFO 驱逐策略
- 用户级和全局级容量限制
- 环境变量：`KGM_MEMORY_MAX_CHUNKS_PER_USER`、`KGM_MEMORY_MAX_TOTAL_CHUNKS`、`KGM_MEMORY_EVICTION_POLICY`

**请求安全加固**
- 请求体大小限制（默认 5MB），可通过 `KGM_HTTP_MAX_BODY_SIZE_MB` 配置
- 完整 CORS 配置支持（`KGM_CORS_ORIGINS`、`KGM_CORS_METHODS`、`KGM_CORS_HEADERS`）
- 敏感信息日志脱敏

### 🔒 安全修复

| 问题 | 严重程度 | 描述 |
|------|----------|------|
| CORS 安全漏洞 | 严重 | 通配符源模式下错误设置 `Access-Control-Allow-Credentials: true` |
| sendSse 头部检查缺失 | 高 | 缺少 `headersSent` 检查，可能导致运行时错误 |
| 环境变量解析错误 | 中 | `parseInt` 结果未验证 NaN |

### 📦 本地 GPU 推理支持

| 模型系列 | 文件 | 支持型号 | 状态 |
|---------|------|---------|------|
| **Qwen 3.5/3.6** | [src/native/gpu/qwen3.ts](./src/native/gpu/qwen3.ts) | 7B/14B/32B/72B | ✅ |
| **GLM 5.0/5.1** | [src/native/gpu/glm5.ts](./src/native/gpu/glm5.ts) | 9B/32B | ✅ |
| **Google Gemma 4** | [src/native/gpu/gemma4.ts](./src/native/gpu/gemma4.ts) | 2B/4B/9B/27B | ✅ |
| **MiniMax 2.5/2.7** | [src/native/gpu/minimax25.ts](./src/native/gpu/minimax25.ts) | 4B/8B/32B/456B | ✅ |
| **MiMo 2.5** | [src/native/gpu/mimo25.ts](./src/native/gpu/mimo25.ts) | 1.5B/7B/13B/30B | ✅ |
| **vMLX (Apple Silicon)** | [src/native/gpu/vmlxAdapter.ts](./src/native/gpu/vmlxAdapter.ts) | M1/M2/M3/M4 | ✅ |

### 运行测试
```bash
npm run test:native-gpu-models
```

**结果**: 63 测试通过，0 失败

### 主要功能
- **权重别名映射**: 支持 Hugging Face 格式 → 本地 GPU 格式
- **内存估算**: 支持多种量化格式 (Q4_0, Q8_0, F16 等)
- **统一接口**: [getModelConfig()](./src/native/gpu/index.ts), [estimateModelMemory()](./src/native/gpu/index.ts)
- **模型注册表**: `MODEL_REGISTRY` 包含所有支持模型
- **特色功能**:
  - Qwen: 滑动窗口、Yarn RoPE
  - GLM: Prefix Attention、MQA/GQA
  - Gemma: GeGLU、嵌入归一化
  - MiniMax: 400K 上下文、KV 压缩
  - MiMo: 端侧量化、推荐 batch size
  - vMLX (Apple MLX): 统一内存、Metal 加速、前缀缓存、连续批处理

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
