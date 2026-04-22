# KGM-computing Runtime

**npm 包**：**`@haxitag/yuli-kgm-computing`** — 发布至 [npmjs.com](https://www.npmjs.com/) 后，在宿主项目执行 **`npm install @haxitag/yuli-kgm-computing`**；程序内 **`import { createRuntimeWithStorage, … } from "@haxitag/yuli-kgm-computing"`**（需先 **`npm run build`** 生成 `dist/`）。本地联调可使用 **`"file:../Yueli-KGM-Computing"`** 依赖同仓库。发布账号需为 npm 用户 **`haxitag`**（或与该 scope 有发布权限的 CI token）。

截止20260406
当前补的是“识别、解析、建模、路由”。原生 native runtime 现在能直接跑的是 kgm-json，以及一部分可落到现有 reference backend 的 GGUF / safetensors 路径。**JANG**（MLX 混合精度，常见 `jang_config.json`）权重不会在 KGM CPU reference 上执行；请使用 **`runtime: "mlx"`** 托管启动 `mlx_lm.server`（见 `docs/mlx-runtime.md`）或自备 OpenAI-compatible 端点。原始 PyTorch 和 TensorFlow 权重现在还不是“原生直接执行”，而是已经能被可靠识别并正确导向 vllm / sglang / openai-compatible。如果你下一步要继续做“Yueli 自己直接执行 raw PyTorch / TensorFlow 权重”，那就得进入真正的权重张量恢复、算子映射和执行后端实现，这是一条新的底层工程线。

## Capabilities & Limits（对外手册）

- 产品级能力与边界说明：`docs/capabilities.md`
- 部署与 API 调用：`docs/deployment-and-api.md`
- 运维手册：`docs/operations-manual.md`
- 升级验收与回归清单：`docs/KGM-升级验证-Checklist.md`

### HaxiTAG 协议面 · YCB 与 KGM 分工

- **协议与数据流**：前端 / UI / 聚合 API 将请求归一为 `KgmRequest`；进程内 **`ContextBuilder`**（`src/context/contextBuilder.ts`）只负责组装 **`ContextPack`** 并交给模板与引擎。外置 **YCB（ContextBuilder 服务）** 为可选动态上下文中间件，通过 **`YcbClient`** 在 Runtime 汇合点将上下文块合并进 `ContextPack.evidence`，失败默认降级为仅平面一 + 本地记忆检索（不阻塞推理）。
- **对齐文档**：`docs/kgm-haxitag-ycb-alignment.md`（UI 扁平字段 ↔ `KgmExtensions` 语义与优先级、YCB 契约与追踪头）。三平面总览见 `docs/haxitag protocol/three-planes-data-flow-and-follow-up.md`。


Yueli-KGM-Computing项目梳理:

# Yueli-KGM-Computing 系统全面分析

## 一、核心定位与价值主张

### 1.1 核心定位
**Yueli-KGM-Computing** 是一个面向**认知型AI应用**的高级推理运行时系统,核心目标是解决传统AI系统中的三大痛点:
- **幻觉问题**: 通过严格的"Render → Completion → Parse"流程控制
- **不一致性**: 通过单一canonical embedding保证检索稳定性  
- **不可控性**: 通过工具门控、记忆管理实现可审计的决策链

### 1.2 独特价值
- **信任委托架构**: 为计算模型提供可靠的情景和效用适配逻辑
- **认知记忆体系**: 分离式短期/长期记忆 + 证据驱动的长期记忆
- **可审计性**: 所有操作、记忆、工具调用都有完整溯源
- **模型无关性**: 通过ProviderFactory支持多模型智能路由

## 二、功能模块完备度分析

### 2.1 核心功能模块(完备度:95%)

#### 2.1.1 多模型管理与路由 ⭐⭐⭐⭐⭐
**实现位置**: `models/` 目录

**核心能力**:
- **ModelRegistry** (`models/registry.ts`): 模型注册中心,管理模型元数据和能力标签
- **ModelRouter** (`models/router.ts`): 智能路由器,支持8种路由策略:
  - 随机选择
  - 加权轮询
  - 基于质量评分
  - 指定模型
  - 基于能力要求
  - 基于用途分类
  - 成本优化
  - 延迟优化
  单个模型文件路径，也可以是模型目录路径；当前 loader 代码明确支持 .gguf、.safetensors、.onnx、.kgm.json，以及包含这些文件的目录。Transformers / Hugging Face 目录：只有 config.json、tokenizer.json 也能识别为 transformers 元数据目录，见 loaders.ts (line 523)。
PyTorch / TensorFlow 本地产物：支持识别 pytorch_model.bin、分片 pytorch_model.bin.index.json、.pt/.pth、saved_model.pb、.h5、.ckpt，并

- **ModelCapabilitySelector** (`models/selector.ts`): 能力标签系统,支持20+种能力标签
- **MultiModelOrchestrator** (`models/parallel.ts`): 并行执行与投票仲裁
  - 多数投票
  - 置信度投票  
  - 共识机制
  - 专家投票

**优势**:
- 高度可配置,支持动态权重调整
- 完善的性能监控体系
- 自动A/B测试支持

**潜在问题**:
- 路由策略算法相对简单,缺乏机器学习驱动的智能优化
- 性能监控的评估逻辑偏静态,未引入实际运行时数据反馈

#### 2.1.2 多提供商统一接入 ⭐⭐⭐⭐⭐
**实现位置**: `llm/providerFactory.ts`, `llm/third-party.ts`

**支持提供商**:
- OpenAI, Anthropic, Google (通过OpenAI兼容接口)
- 智谱AI (Zhipu)
- Minimax
- OpenRouter (聚合商)
- NVIDIA
- DeepSeek
- Ollama (本地)
- vLLM (高性能)
- Slang (专用引擎)

**设计优势**:
- 统一的LlmClient接口抽象
- 环境变量自动配置加载
- 提供商验证机制
- 优雅的错误处理与回退策略

#### 2.1.3 托管模型控制面 ⭐⭐⭐⭐⭐
**实现位置**: `models/modelManager.ts` (64.2KB,核心模块)

**核心能力**:
- 模型制品管理: 支持从HuggingFace、Ollama、GitHub、ModelScope、Direct URL拉取
- Runtime生命周期管理: llama.cpp, ollama, vllm, sglang, openai-compatible
- 完整的调度系统: 队列、并发控制、重试、熔断器
- Prometheus指标输出: 请求量、延迟、tokens/s、prefix-hit统计
- KGMfile支持: 类似Dockerfile的单文件模型定义
- 本地状态分片存储：默认 `data/models/store/`，`artifacts/<id>.json`、`runtimes/<id>.json` 与 `manifest.json`；环境变量 `KGM_MODEL_STATE_PATH` 指向该目录。若仍配置旧版单文件路径 `.../catalog.json` 且文件存在，启动时一次性迁移至同目录下 `store/` 并删除旧文件

**亮点**:
- 端到端的模型管理: 下载→创建runtime→启动→监控
- 细粒度的QoS控制: maxConcurrentRequests, maxQueueSize, retry策略
- 完善的健康检查机制

**潜在问题**:
- 缺少模型版本管理的精细化控制
- 备份需自行打包 `data/models/store/` 与 `data/model-artifacts/`

### 2.1.4 记忆管理系统 ⭐⭐⭐⭐
**实现位置**: `memory/` 目录

**三层架构**:
1. **基础存储层** (`memory/store.ts`): 
   - InMemoryStore: 内存实现
   - 向量检索 + 余弦相似度

2. **分离式记忆** (`memory/separation.ts`):
   - 短期记忆: 自动过期,会话级隔离
   - 长期记忆: 基于重要性、访问次数、标签的迁移策略

3. **高级特性**:
   - **记忆衰减机制** (`memory/decay.ts`):
     - 可配置的衰减函数
     - 撤销机制
     - 软删除与永久删除
   - **写入门控** (`memory/writeGating.ts`):
     - 用户配额
     - 内容过滤
     - 相似性阈值
     - 嵌入版本校验
     - 审批流程

**优势**:
- 完善的记忆生命周期管理
- 灵活的策略配置
- 全面的审计日志

**潜在问题**:
- 缺少记忆压缩与去重机制
- 长期记忆的检索优化空间较大

### 2.1.5 多模态处理 ⭐⭐⭐
**实现位置**: `multimodal/` 目录

**MediaProcessor能力**:
- 图像处理: OCR、特征提取、描述生成
- 音频处理: 转录、特征提取
- 视频处理: 关键帧提取、音频转录
- 文档处理: 文本提取、格式保留

**LanguageAsAService** (`multimodal/languageService.ts`):
- 信任委托API接口
- 多模态→文本转换
- 知识图谱补全
- 丰富的上下文API

**优势**:
- 统一的多模态处理接口
- 缓存机制优化性能
- 并发控制与超时保护

**潜在问题**:
- 实际的多模态处理依赖外部服务,缺少本地实现
- 缺少跨媒体类型的语义对齐

### 2.1.6 知识图谱 ⭐⭐⭐⭐
**实现位置**: `graph/store.ts`

**核心功能**:
- 实体-关系-三元组管理
- 子图查询(支持实体、关系、文本查询)
- 动态图谱信号注入到context
- 支持多种推理模式: entity/path/subgraph

**优势**:
- 轻量级内存实现,性能优异
- 灵活的查询接口
- 与ContextBuilder深度集成

**潜在问题**:
- 缺少图算法(最短路径、社区发现等)
- 缺少图谱可视化与调试工具

### 2.1.7 工具系统 ⭐⭐⭐⭐
**实现位置**: `tools/` 目录

**内置工具**:
- `search_web`: 网络搜索
- `get_weather`: 天气查询
- `retrieve_subgraph`: 知识图谱检索
- `read_artifact`: 工件读取
- `read_session`: 会话历史读取
- `list_tools/describe_tool`: 工具发现
- 沙箱工具: computer/browser/mobile控制

**工具注册机制**:
- 统一的ToolDefinition接口
- 工具描述模式(Schema)
- 元数据标注: latency, costLevel, permission, tags

**优势**:
- 灵活的工具注册与发现机制
- 完善的工具元数据
- 支持工具权限与门控

**潜在问题**:
- 缺少工具依赖管理
- 缺少工具版本控制

### 2.1.8 沙箱管理 ⭐⭐⭐
**实现位置**: `sandbox/` 目录

**支持沙箱类型**:
- Computer: 虚拟机(QEMU)
- Browser: Playwright浏览器
- Mobile: Android模拟器

**运行模式**:
- `simulated`: 最小化模拟实现
- `external`: 通过adapter连接真实沙箱

**优势**:
- 统一的沙箱抽象接口
- 支持嵌入式adapter
- 提供实时预览指标

**潜在问题**:
- 缺少沙箱资源限制与配额
- 缺少沙箱间通信机制

### 2.1.9 调度器(FSM) ⭐⭐⭐⭐⭐
**实现位置**: `scheduler/fsm.ts`

**核心工作流**:
```
用户请求 → ContextBuilder → PromptRenderer → LLM Client → Parser → 工具执行(可选) → 结果返回
```

**关键特性**:
- 多轮工具调用(maxRounds控制)
- Schema验证与解析
- 工具结果自动记录到记忆
- 会话管理

**优势**:
- 清晰的状态机设计
- 严格的输出验证
- 完整的工具调用追踪

### 2.1.10 OpenAI兼容层 ⭐⭐⭐⭐⭐
**实现位置**: `openai/compat.ts`

**支持接口**:
- `GET /v1/models`: 模型列表
- `POST /v1/chat/completions`: 对话补全
- `POST /v1/responses`: Responses API

**流式模式**:
- **Native Passthrough**: 无需KGM增强时直接透传上游SSE
- **Bridge Streaming**: 需要KGM编排时通过兼容桥接层转换

**工具调用增强**:
- `kgm.capabilities.executeToolCalls=true`: 服务端执行工具
- 工具调用轨迹完整记录在`kgm.tool_trace`

**优势**:
- 完全兼容OpenAI API,可无缝替换
- 智能的流式模式切换
- 丰富的KGM扩展字段

## 三、技术架构优势

### 3.1 模块化设计
- 清晰的层次划分: core/context/memory/llm/tools/scheduler/...
- 接口抽象完善,易于扩展
- 依赖注入模式,支持自定义实现

### 3.2 可观测性
- 完整的ContextPack,记录所有上下文信息
- 工具调用trace
- Prometheus指标输出
- Adapter集成(性能与上下文质量上报)

### 3.3 扩展性
- ProviderFactory插件架构
- Skill系统支持自定义工作流
- 支持自定义MemoryStore, Embedder, GraphStore

## 四、潜在问题与优化建议

### 4.1 架构层面

**问题1: 缺少分布式部署支持**
- 当前设计是单机架构
- 缺少集群模式下的记忆共享、图谱同步
- 缺少分布式锁与协调机制

**建议**:
- 引入Redis等分布式存储层
- 设计分片策略与一致性协议
- 增加集群模式的配置选项

**问题2: 缺少API认证与授权**
- HTTP server(`/src/server/http.ts`)未实现认证中间件
- 缺少用户权限管理
- 缺少租户隔离

**建议**:
- 集成JWT或OAuth2认证
- 实现RBAC权限模型
- 增加多租户支持

**问题3: 缺少限流与熔断的精细化控制**
- 虽然ModelManager有熔断器,但HTTP层缺少限流
- 缺少用户级、租户级的QoS控制

**建议**:
- 在HTTP层引入rate limiting
- 实现令牌桶或漏桶算法
- 增加用户配额管理API

### 4.2 功能层面

**问题1: 记忆检索优化空间大**
- 当前仅使用余弦相似度
- 缺少重排序、混合检索、查询改写

**建议**:
- 引入BM25混合检索
- 实现Cross-Encoder重排序
- 增加Query Expansion

**问题2: 工具系统缺少高级特性**
- 缺少工具依赖管理
- 缺少工具版本控制与灰度发布
- 缺少工具性能监控

**建议**:
- 设计工具依赖图
- 实现工具版本管理API
- 增加工具调用性能分析

**问题3: 知识图谱功能有限**
- 缺少图谱算法支持
- 缺少图谱推理与推断
- 缺少可视化工具

**建议**:
- 集成图计算框架或自研核心算法
- 增加路径查询、社区发现等API
- 提供图谱可视化接口

**问题4: 多模态处理能力有限**
- 缺少本地多模态模型支持
- 缺少跨模态语义对齐
- 缺少多模态缓存优化

**建议**:
- 集成本地CLIP/BLIP模型
- 增加多模态embedding对齐策略
- 优化多媒体缓存策略

### 4.3 性能与可靠性

**问题1: 并发性能优化空间**
- ContextBuilder构建过程可能成为瓶颈
- 缺少请求级别的并发控制

**建议**:
- 增加ContextBuilder缓存
- 实现请求合并与批处理
- 优化相似度计算算法

**问题2: 错误处理机制不够完善**
- 部分模块的错误信息不够详细
- 缺少错误分类与恢复策略

**建议**:
- 增加结构化错误码
- 实现自动重试策略
- 增加错误监控与告警

**问题3: 缺少持久化与容灾**
- 记忆、图谱默认是内存存储
- 缺少数据备份与恢复机制

**建议**:
- 默认启用SQLite/Chroma持久化
- 实现定期备份策略
- 增加数据迁移工具

### 4.4 工程层面

**问题1: 测试覆盖不足**
- demo文件多于测试文件
- 缺少集成测试与性能测试

**建议**:
- 增加单元测试覆盖率
- 编写E2E测试
- 增加性能基准测试

**问题2: 文档完善度不足**
- 部分模块缺少详细的API文档
- 缺少架构图与流程图
- 缺少故障排查指南

**建议**:
- 补充OpenAPI文档
- 绘制系统架构图
- 编写详细的运维手册

**问题3: 缺少开发者工具**
- 缺少CLI的完整功能
- 缺少调试工具与性能分析器
- 缺少迁移工具

**建议**:
- 增强CLI工具(kgmc)
- 开发性能分析工具
- 提供数据迁移脚本

## 五、总体评价

### 5.1 优势
1. **架构设计优秀**: 模块化、可扩展、接口清晰
2. **功能完备度高**: 涵盖记忆、工具、图谱、多模态等核心能力
3. **技术创新性强**: 信任委托、分离式记忆、可审计性等创新设计
4. **兼容性好**: OpenAI兼容层使其可以无缝替换现有服务
5. **本地化能力强**: 支持Ollama/vLLM等本地推理引擎

### 5.2 完备度评估
- **核心推理能力**: ⭐⭐⭐⭐⭐ (95%)
- **记忆管理能力**: ⭐⭐⭐⭐ (80%)
- **多模型管理**: ⭐⭐⭐⭐⭐ (95%)
- **工具系统**: ⭐⭐⭐⭐ (85%)
- **知识图谱**: ⭐⭐⭐ (70%)
- **多模态处理**: ⭐⭐⭐ (75%)
- **系统可观测性**: ⭐⭐⭐⭐ (85%)
- **企业级特性**: ⭐⭐⭐ (60%)

### 5.3 适用场景
- ✅ 个人助手与认知型应用
- ✅ 企业决策支持系统
- ✅ 多模型A/B测试平台
- ✅ 本地化AI应用开发
- ❓ 大规模生产环境(需加强企业级特性)

### 5.4 优先优化建议
1. **短期(1-3个月)**:
   - 完善API认证与授权
   - 增加限流与配额管理
   - 补充测试覆盖

2. **中期(3-6个月)**:
   - 优化记忆检索算法
   - 增强知识图谱推理能力
   - 改进多模态处理

3. **长期(6-12个月)**:
   - 支持分布式部署
   - 增强企业级特性
   - 开发开发者生态

---

**总结**: Yueli-KGM-Computing是一个设计精良、功能丰富的推理引擎,在多模型管理、记忆体系、可审计性方面具有显著优势。虽然在企业级特性、分布式部署等方面还有提升空间,但已经具备成为生产级AI运行时的坚实基础。

## 新增功能：多模型提供商支持

KGM-Computing Runtime 现在支持多种第三方模型提供商和服务：

- **智谱AI (Zhipu)**: 支持 GLM 系列模型
- **Minimax**: 支持 MiniMax 模型系列
- **OpenRouter**: 模型聚合商，支持多种模型提供商
- **NVIDIA**: 支持 NVIDIA 提供的 AI 模型
- **DeepSeek**: 支持 DeepSeek 系列模型
- **Ollama**: 本地推理引擎支持
- **vLLM**: 高性能推理引擎支持
- **Slang**: 专用推理引擎支持

使用 `LlmProviderFactory` 统一管理不同提供商的客户端：

```typescript
import { LlmProviderFactory, ProviderConfigurationManager } from './src/index';

// 方法1: 使用LlmProviderFactory直接创建客户端
const zhipuConfig = {
  type: 'zhipu',
  model: 'glm-4',
  // URL和密钥会自动从环境变量加载
};
const zhipuClient = LlmProviderFactory.createClient(zhipuConfig);

// 方法2: 使用ProviderConfigurationManager管理多个提供商
const configManager = new ProviderConfigurationManager('./config/model-providers.json');
await configManager.loadConfiguration();

// 从配置中获取最适合任务的提供商
const bestProvider = configManager.getBestProviderForTask('需要处理中文内容');
if (bestProvider) {
  const client = LlmProviderFactory.createClient(bestProvider);
}
```

Local deployment (host):

```
npm install
npm run dev:server
```

Mock mode (no external services):

```
KGM_MOCK_MODE=1 KGM_VECTOR_BACKEND=memory npm run dev:server
```

OpenAI-compatible surface:

```
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

Example:

```json
POST /v1/chat/completions
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are a graph-aware assistant." },
    { "role": "user", "content": "search market trends" }
  ],
  "kgm": {
    "capabilities": {
      "includeBuiltinTools": true
    },
    "graph": {
      "enabled": true,
      "entities": ["market", "trend"],
      "triples": [
        { "subject": "market", "predicate": "influences", "object": "trend" }
      ]
    },
    "ops": {
      "deployment": "self_hosted",
      "slaOwner": "self"
    }
  }
}
```

Compatibility notes:

- `/v1/chat/completions` supports non-streaming and SSE streaming; pass-through-safe requests can proxy provider-native SSE directly, while KGM-enriched requests fall back to bridge streaming.
- **`POST /v1/messages`**（Anthropic Messages 子集）：请求经 OpenAI 兼容层桥接；非流式返回 `type: "message"`、`content: [{type:"text",...}]`、`stop_reason`（与 OpenAI `finish_reason` 映射）；流式 SSE **不**追加 `data: [DONE]`。可选请求头 `x-api-key` / `Authorization: Bearer`（默认不强制校验）。
- `/v1/responses` is available as a compatibility bridge with `output`, `output_text`, and tool-call trace items, and now supports the same native-stream or bridge-stream split.
- Tool calls can be server-executed via `kgm.capabilities.executeToolCalls=true`; when enabled, the bridge returns final content and preserves tool trace in `message.tool_calls` plus `kgm.tool_trace`.
- `kgm.ops` is kept for operator metadata and observability, not prompt reasoning.
- `kgm.graph` and `kgm.retrieval` are prompt-visible extensions intended for self-built retrieval / graph-enhanced reasoning.
- `retrieve_subgraph` is now a real built-in capability backed by an in-memory graph store; graph triples can also be ingested via `POST /v1/kgm/graph/triples`.
- 现在新增了 managed model control plane：支持 `POST /v1/kgm/models/pull`、`GET /v1/kgm/models/artifacts`、`POST /v1/kgm/models/runtimes`、`POST /v1/kgm/models/runtimes/:id/start|stop`。
- 新增 `POST /v1/kgm/models/create` 与 `KGMfile` 支持，可用单份模型描述创建 artifact + runtime。
- 新增 `GET /v1/kgm/models`、`GET /v1/kgm/models/running`、`GET /v1/kgm/models/:id/metrics`、`DELETE /v1/kgm/models/:id`。
- KGM 现在会在自身进程内承担受管 runtime 的队列、并发、重试、熔断、prefix-hit 统计与 Prometheus 文本指标输出：`GET /metrics`。
- `GET /v1/models` 现在会同时列出默认模型、已管理 artifact，以及已启动 runtime 暴露出来的模型名。
- 对已启动 runtime 的 `model` 精确命中会优先走 managed runtime，再回退到 provider routing / `KGM_LLM_*`。
- `GET/POST /v1/kgm/sandboxes` plus `/start` and `/stop` provide minimal embedded virtual `computer / browser / mobile` sandbox control.
- Sandbox execution defaults to `simulated`, but `KGM_SANDBOX_*_USE_EMBEDDED=1` can switch the manager to bundled Playwright / Android Emulator / QEMU adapter scripts, or you can still override with explicit external commands and endpoints.
- 主服务现在支持 `ProviderConfigurationManager` 驱动的多 provider 路由；显式设置 `KGM_PROVIDER_ROUTING_ENABLED=1` 后，会优先按 provider 配置路由，失败时默认回退到 `KGM_LLM_*`。
- This runtime is self-hosted:运维、可用性与 SLA 责任默认由部署方承担，不由上游模型协议自动兜底。

Deployment guide: `docs/deployment-and-api.md`
Operations manual: `docs/operations-manual.md`

Release gate（最小）：`npm run build` + `npm run smoke:openai-compat`。

扩展回归（与 `docs/KGM-升级验证-Checklist.md` 一致）：`npm run test:kgm-regression`，或至少包含  
`test:canonical-conversion`、`test:hf-public-configs`、`test:tokenizer-chat-template`、`test:jinja-lite`、`test:pytorch-index-canonical`、`test:gguf-layout-matrix`、`test:anthropic-tool-mapping`，以及 `smoke:native-safetensors` / `smoke:native-gguf`（按环境）。  
包入口另导出 **`native/gguf_layout`**（`analyzeGgufLayoutIssues` 等）与 **`anthropic/compat`**（含 `tool_use` 映射）。

Then configure endpoints:

```
POST /v1/kgm/config
{
  "embedding": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "YOUR_KEY",
    "model": "text-embedding-3-large",
    "path": "/embeddings"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "YOUR_KEY",
    "model": "gpt-4o-mini",
    "path": "/completions",
    "mode": "completions"
  },
  "database": {
    "provider": "sqlite",
    "filePath": "data/kgm.sqlite",
    "journalMode": "WAL"
  },
  "vector": {
    "backend": "chroma",
    "baseUrl": "http://localhost:8000",
    "collection": "kgm_memory"
  }
}
```

Container deployment:

```
export OPENAI_API_KEY=your_key
docker compose up --build
```

Environment variables supported by `src/server/start.ts`:

```
KGM_EMBEDDING_BASE_URL
KGM_EMBEDDING_API_KEY
KGM_EMBEDDING_MODEL
KGM_EMBEDDING_PATH
KGM_EMBEDDING_VERSION
KGM_LLM_BASE_URL
KGM_LLM_API_KEY
KGM_LLM_MODEL
KGM_LLM_PATH
KGM_LLM_CHAT_PATH
KGM_LLM_RESPONSES_PATH
KGM_LLM_MODE
KGM_LLM_TEMPERATURE
KGM_LLM_MAX_TOKENS
KGM_DB_PROVIDER
KGM_DB_PATH
KGM_DB_JOURNAL
KGM_VECTOR_BACKEND
KGM_VECTOR_BASE_URL
KGM_VECTOR_API_PATH
KGM_VECTOR_COLLECTION
KGM_VECTOR_DISTANCE
KGM_ADAPTER_ENABLED
KGM_ADAPTER_BASE_URL
KGM_ADAPTER_SECRET
KGM_ADAPTER_TIMEOUT_MS
KGM_ADAPTER_SEND_PERFORMANCE
KGM_ADAPTER_SEND_CONTEXT_QUALITY
KGM_ADAPTER_PERFORMANCE_PATH
KGM_ADAPTER_CONTEXT_QUALITY_PATH
KGM_MOCK_MODE
KGM_PROVIDER_ROUTING_ENABLED
KGM_PROVIDER_CONFIG_PATH
KGM_PROVIDER_ROUTING_STRICT
KGM_PROVIDER_FORCE_TYPE
KGM_MODEL_STATE_PATH
KGM_MODEL_ARTIFACT_DIR
KGM_MODEL_RUNTIME_TIMEOUT_MS
KGM_MODEL_RUNTIME_RETRY_MAX_RETRIES
KGM_MODEL_RUNTIME_CB_FAILURES
KGM_MODEL_RUNTIME_CB_COOLDOWN_MS
KGM_LLAMA_SERVER_CMD
KGM_OLLAMA_CMD
KGM_OLLAMA_AUTOSTART
KGM_VLLM_CMD
KGM_SGLANG_CMD
HF_TOKEN
GITHUB_TOKEN
MODELSCOPE_API_TOKEN
KGM_SANDBOX_COMPUTER_USE_EMBEDDED
KGM_SANDBOX_COMPUTER_START_CMD
KGM_SANDBOX_COMPUTER_STOP_CMD
KGM_SANDBOX_COMPUTER_STATUS_CMD
KGM_SANDBOX_VM_IMAGE
KGM_SANDBOX_BROWSER_USE_EMBEDDED
KGM_SANDBOX_BROWSER_START_CMD
KGM_SANDBOX_BROWSER_STOP_CMD
KGM_SANDBOX_BROWSER_STATUS_CMD
KGM_SANDBOX_BROWSER_WS_ENDPOINT
KGM_SANDBOX_MOBILE_USE_EMBEDDED
KGM_SANDBOX_MOBILE_START_CMD
KGM_SANDBOX_MOBILE_STOP_CMD
KGM_SANDBOX_MOBILE_STATUS_CMD
KGM_SANDBOX_MOBILE_ENDPOINT
```

API demo:

```
npx tsx src/demo/e2e_api.ts
```

Managed model examples:

```bash
curl http://127.0.0.1:3000/v1/kgm/models/artifacts

curl http://127.0.0.1:3000/v1/kgm/models/pull \
  -H "Content-Type: application/json" \
  -d '{
    "sourceType": "huggingface",
    "sourceUrl": "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct",
    "filePath": "model.safetensors",
    "modelName": "qwen2.5-local"
  }'

curl http://127.0.0.1:3000/v1/kgm/models/runtimes \
  -H "Content-Type: application/json" \
  -d '{
    "artifactId": "<artifact_id>",
    "runtime": "vllm",
    "modelName": "qwen2.5-local"
  }'

curl -X POST http://127.0.0.1:3000/v1/kgm/models/runtimes/<runtime_id>/start

curl http://127.0.0.1:3000/v1/kgm/models
curl http://127.0.0.1:3000/v1/kgm/models/running
curl http://127.0.0.1:3000/v1/kgm/models/<runtime_id>/metrics
curl http://127.0.0.1:3000/metrics
```

CLI examples:

```bash
npm run build
node dist/cli/kgm.js models list
node dist/cli/kgm.js models ps
node dist/cli/kgm.js models pull --source-type huggingface --url https://huggingface.co/your-org/your-model --file-path model.gguf --model-name your-model
node dist/cli/kgm.js models create --kgmfile ./KGMfile
node dist/cli/kgm.js models start <runtime_id>
node dist/cli/kgm.js models stop <runtime_id>
node dist/cli/kgm.js models rm <id>
node dist/cli/kgm.js models metrics <runtime_id>
```

Docs: `docs/openapi.yaml`

Project Supplement (Design Summary):

Goal:
- Build a controllable, auditable user–AI cognitive memory runtime that merges user input, context signals, memory, and tool results into a stable prompt workflow (Render → Completion → Parse).

Thinking:
- LLM only completes tokens; reliability comes from protocol (render), parsing, and tool gating.
- Memory is evidence-driven: keep raw evidence, then abstract traits and cognitive models with traceable confidence.
- Single canonical embedding prevents retrieval drift; other models cannot write into the vector index.

Usage:
- Local mock: `KGM_MOCK_MODE=1 KGM_VECTOR_BACKEND=memory npm run dev:server`
- Configure providers via `/v1/kgm/config`, then call `/v1/kgm/execute`.
- For small apps: SQLite for metadata + Chroma for vectors (configurable).

Use cases:
- Personal assistant with behavioral context (web/app/time/location/weather).
- Enterprise decision support with auditable memory and tool traces.
- Structured tool calling or JSON generation using the output schema guardrails.

OpenAPI: `docs/openapi.yaml`

Storage default:

- SQLite for metadata (recommended for small apps)
- Chroma for vectors

To enable SQLite + Chroma, install `better-sqlite3` and configure:

```
POST /v1/kgm/config
{
  "database": { "provider": "sqlite", "filePath": "data/kgm.sqlite" },
  "vector": { "backend": "chroma", "baseUrl": "http://localhost:8000", "collection": "kgm_memory" }
}
```

Note: `better-sqlite3` builds best on Node.js LTS (20/22).

To stay in-memory only, set `vector.backend` to `memory`.

Runtime helper:

```
import { createRuntimeWithStorage } from "./src/runtime";
```

Example (chroma backend):

```
import { ConfigStore, createRuntimeWithStorage } from "./src/runtime";

const configStore = new ConfigStore({
  vector: { backend: "chroma", baseUrl: "http://localhost:8000", collection: "kgm_memory" },
  database: { provider: "sqlite", filePath: "data/kgm.sqlite" }
});
const runtime = await createRuntimeWithStorage({ configStore });
```

# KGM-Computing Runtime 项目综述

## 项目整体综述

KGM-Computing Runtime 是一个先进的多模型、多模态、多连接互动的AI运行时系统，专为实现长短期记忆管理和ContextBuilder稳定信息流动而设计。该项目通过独特的“Render → Completion → Parse”稳定工作流，解决了传统AI系统中的幻觉、不一致和不可控问题。系统集成了多模型路由策略机制、多模型并行/投票/仲裁机制、模型能力标签与选择器、模型性能监控和自动评估等高级功能。

## 突出特点与创新性

1. **多模型支持与智能路由**：支持多种第三方模型提供商，包括OpenAI、Anthropic、Google、智谱AI、Minimax、OpenRouter、NVIDIA、DeepSeek、Ollama、vLLM、Slang等。通过ModelRouter实现多种路由策略（随机、加权、质量评估、指定模型等），确保最优模型选择。

2. **多模态数据处理能力**：实现MultimodalProcessor，支持图像、音频、视频等多模态数据处理，通过LanguageAsAService中间件实现多模态到文本的转换，提供统一的处理接口。

3. **分离式记忆管理系统**：建立了短期工作记忆与长期记忆的明确分离，通过SeparatedMemoryManager实现自动迁移策略和访问统计，同时引入MemoryDecayMechanism进行记忆保留和撤销管理。

4. **写入门控与版本化管理**：通过WriteGatingMechanism实现多层次门控规则（配额、内容过滤、相似性、版本控制等），确保数据质量和安全。

5. **可审计的计算过程**：通过ContextBuilder构建完整的上下文包（ContextPack），记录所有操作和决策的完整溯源，确保系统的透明度和可信度。

## 核心技术理念

### 信任委托与代理机制

KGM-Computing Runtime 实现了先进的信任委托与代理机制，包含以下几个核心要素：

(1) **丰富的上下文API接口** - 通过多模态数据构建完备信息基础

(2) **语言模型后端改写** - 实现信息标准化与结构化

(3) **知识图谱补全** - 自动识别实体关系，提升信息完备性

(4) **信任委托机制** - 为计算模型提供可靠的情景和效用适配逻辑

(5) **计算过程逻辑清晰可审计** - 确保透明度与可信度

(6) **信任代理服务** - 通过API实现可靠的自动化决策

(7) **上下文丰富性保证** - 通过多源数据融合确保信息完整性

## 系统架构优势

- **可控性**：通过协议和管线而非模型本身保证系统可靠性
- **可审计性**：所有操作和记忆都有完整溯源
- **证据驱动**：保留原始证据，再抽象认知模型和特质
- **单一规范**：防止检索漂移，其他模型不能写入向量索引
- **模块化设计**：支持功能扩展，具有良好的扩展性和维护性

## 主要功能特性

### 模型管理
- 支持多种模型提供商（OpenAI、Anthropic、Google、智谱AI、Minimax、OpenRouter、NVIDIA、DeepSeek、Ollama、vLLM、Slang等）
- 灵活的路由策略（基于能力、性能、成本等）
- 自动性能监控和评估
- 配置文件管理

### 多模态处理
- 支持图像、音频、视频、文档等多种媒体类型
- 统一的文本表示转换
- Language-as-Service中间件

### 记忆管理
- 短期与长期记忆分离
- 自动衰减和撤销机制
- 写入门控和版本管理
- 访问控制和审核

### 扩展性
- 插件式模型提供商架构
- 统一的API接口
- 简单的集成和切换机制

## 技术架构

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client API    │───▶│   HTTP Server   │───▶│   Scheduler     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                      │
                        ┌──────────────────┐         │
                        │ ContextBuilder   │◀────────┤
                        └──────────────────┘         │
                                                      │
                        ┌──────────────────┐         │
                        │  PromptRenderer  │─────────┤
                        └──────────────────┘         │
                                                      │
                        ┌──────────────────┐         │
                        │   LLM Client     │─────────┤
                        └──────────────────┘         │
                                                      │
                        ┌──────────────────┐         │
                        │    Parser        │─────────┘
                        └──────────────────┘
                                                      │
                        ┌──────────────────┐         │
                        │   Tool Runtime   │─────────┘
                        └──────────────────┘
                                                      │
                        ┌──────────────────┐         │
                        │   Memory Store   │─────────┘
                        └──────────────────┘
```

## Playground界面

KGM-Computing Runtime 提供了一个功能强大的Playground界面，支持多模态输入输出，包括文本、图片、音频、视频等，用户可以直观地体验系统的各项功能。

## 运行demo
cd /Users/yr.z/work/Yueli-KGM-Computing && npm run dev:enhanced
# yuelicopilot
