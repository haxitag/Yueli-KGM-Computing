import { 
  createRuntimeWithStorage,
  ModelRegistry,
  ModelRouter,
  MultiModelOrchestrator,
  ModelCapabilitySelector,
  ModelPerformanceMonitor,
  ModelConfigurationManager,
  MultimodalProcessor,
  LanguageAsAService,
  SeparatedMemoryManager,
  MemoryDecayMechanism,
  WriteGatingMechanism,
  type ModelConfig,
  type ModelCapabilities
} from "../index.js";

async function main(): Promise<void> {
  console.log("=== KGM-Computing Multi-Model & Multi-Modal Demo ===\n");

  // 1. 初始化基础运行时
  console.log("1. Initializing base runtime...");
  const baseRuntime = await createRuntimeWithStorage({});
  
  // 2. 创建模型注册中心
  console.log("2. Setting up Model Registry...");
  const modelRegistry = new ModelRegistry();
  
  // 注册一些示例模型
  const gpt4Config: ModelConfig = {
    name: "gpt-4-turbo",
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    path: "/chat/completions",
    mode: "chat"
  };
  
  const gpt4Caps: ModelCapabilities = {
    name: "gpt-4-turbo",
    provider: "openai",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsFunctionCalling: true,
    supportsMultimodal: true,
    purpose: "general",
    pricing: {
      inputCostPerToken: 0.00001,
      outputCostPerToken: 0.00003
    },
    estimatedLatency: 1500
  };
  
  modelRegistry.register(gpt4Config, gpt4Caps);
  
  // 3. 设置模型路由器
  console.log("3. Setting up Model Router...");
  const modelRouter = new ModelRouter(modelRegistry);
  
  // 4. 创建多模型编排器
  console.log("4. Setting up Multi-Model Orchestrator...");
  const orchestrator = new MultiModelOrchestrator();
  
  // 5. 设置模型能力选择器
  console.log("5. Setting up Model Capability Selector...");
  const selector = new ModelCapabilitySelector(modelRegistry);
  selector.createPresetProfiles(); // 创建预设配置文件
  
  // 6. 初始化性能监控器
  console.log("6. Setting up Performance Monitor...");
  const monitor = new ModelPerformanceMonitor({
    enabled: true,
    evaluationIntervalMinutes: 60,
    sampleSize: 5
  });
  
  // 7. 设置配置管理器
  console.log("7. Setting up Configuration Manager...");
  const configManager = new ModelConfigurationManager(
    modelRegistry,
    modelRouter,
    selector,
    monitor,
    './demo-model-config.json'
  );
  
  // 8. 设置多模态处理器
  console.log("8. Setting up Multimodal Processor...");
  const multimodalProcessor = new MultimodalProcessor();
  
  // 9. 设置Language-as-Service中间件
  console.log("9. Setting up Language-as-Service Middleware...");
  const langService = new LanguageAsAService(multimodalProcessor, {
    enableCache: true,
    maxCacheSize: 100,
    timeoutMs: 30000,
    maxConcurrency: 3
  });
  
  // 10. 设置分离的记忆管理器
  console.log("10. Setting up Separated Memory Manager...");
  // 注意：这里我们使用基础的MemoryStore，实际应用中可能需要更复杂的实现
  const separatedMemory = new SeparatedMemoryManager(
    baseRuntime.memoryStore as any, // 类型适配
    baseRuntime.memoryStore as any, // 类型适配
    baseRuntime.embedder
  );
  
  // 11. 设置记忆衰减机制
  console.log("11. Setting up Memory Decay Mechanism...");
  const decayMechanism = new MemoryDecayMechanism(baseRuntime.memoryStore);
  
  // 12. 设置写入门控机制
  console.log("12. Setting up Write Gating Mechanism...");
  const writeGating = new WriteGatingMechanism(
    baseRuntime.memoryStore,
    baseRuntime.embedder
  );
  
  // 添加一个示例写入规则
  writeGating.addRule({
    name: "Content Filter Rule",
    description: "Filters out certain content patterns",
    condition: { type: 'content_filter', patterns: ['spam', 'junk'] },
    enabled: true,
    priority: 1
  });
  
  console.log("\n=== Demo Operations ===");
  
  // 示例1: 模型路由
  console.log("\n1. Testing Model Routing:");
  const routingResult = modelRouter.route({
    strategy: { type: 'purpose', purpose: 'general' },
    fallbackToDefault: true
  });
  if (routingResult) {
    console.log(`   Selected model: ${routingResult.model.config.name} for general purpose`);
  }
  
  // 示例2: 能力选择
  console.log("\n2. Testing Capability Selection:");
  const selectionResult = selector.selectBestModel('fast_response');
  if (selectionResult) {
    console.log(`   Best model for fast response: ${selectionResult.model.config.name}`);
    console.log(`   Match score: ${selectionResult.matchScore.toFixed(2)}`);
  }
  
  // 示例3: 多模态处理
  console.log("\n3. Testing Multimodal Processing:");
  const mediaContent = {
    type: 'text' as const,
    data: 'This is a sample text to demonstrate multimodal processing capabilities.',
    metadata: {
      filename: 'sample.txt',
      size: 50,
      mimeType: 'text/plain'
    }
  };
  
  try {
    const processed = await langService.processToText(mediaContent);
    console.log(`   Original length: ${mediaContent.data.length}`);
    console.log(`   Processed length: ${processed.textRepresentation.length}`);
    console.log(`   Status: ${processed.status}`);
  } catch (error) {
    console.error('   Error processing media:', error);
  }
  
  // 示例4: 安全写入记忆
  console.log("\n4. Testing Secure Memory Write:");
  const writeResult = await writeGating.secureWrite({
    userId: "user-123",
    text: "This is a test memory entry with normal content.",
    source: "demo-app",
    embedding: await baseRuntime.embedder.embed("This is a test memory entry with normal content."),
    embeddingVersion: "default",
    lastAccessedAt: new Date().toISOString()
  }, "user-123");
  
  console.log(`   Write successful: ${writeResult.success}`);
  if (writeResult.memoryId) {
    console.log(`   Memory ID: ${writeResult.memoryId}`);
  }
  
  // 示例5: 配置摘要
  console.log("\n5. Configuration Summary:");
  console.log(configManager.getModelConfigSummary());
  
  console.log("\n=== Demo Completed Successfully ===");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
