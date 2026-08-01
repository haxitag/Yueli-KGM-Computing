import { 
  ModelRegistry,
  ModelRouter,
  ModelCapabilitySelector,
  ModelPerformanceMonitor,
  ModelConfigurationManager,
  MultimodalProcessor,
  LanguageAsAService,
  MemoryDecayMechanism,
  WriteGatingMechanism,
  type ModelConfig,
  type ModelCapabilities
} from "../index.js";

async function main(): Promise<void> {
  console.log("=== KGM-Computing Simplified Multi-Model Test ===\n");

  // 1. 创建模型注册中心
  console.log("1. Setting up Model Registry...");
  const modelRegistry = new ModelRegistry();
  
  // 注册一个示例模型
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
  
  // 2. 设置模型路由器
  console.log("2. Setting up Model Router...");
  const modelRouter = new ModelRouter(modelRegistry);
  
  // 3. 设置模型能力选择器
  console.log("3. Setting up Model Capability Selector...");
  const selector = new ModelCapabilitySelector(modelRegistry);
  selector.createPresetProfiles(); // 创建预设配置文件
  
  // 4. 初始化性能监控器
  console.log("4. Setting up Performance Monitor...");
  const monitor = new ModelPerformanceMonitor({
    enabled: true,
    evaluationIntervalMinutes: 60,
    sampleSize: 5
  });
  
  // 5. 设置配置管理器
  console.log("5. Setting up Configuration Manager...");
  const configManager = new ModelConfigurationManager(
    modelRegistry,
    modelRouter,
    selector,
    monitor,
    './test-model-config.json'
  );
  
  // 6. 设置多模态处理器
  console.log("6. Setting up Multimodal Processor...");
  const multimodalProcessor = new MultimodalProcessor();
  
  // 7. 设置Language-as-Service中间件
  console.log("7. Setting up Language-as-Service Middleware...");
  const langService = new LanguageAsAService(multimodalProcessor, {
    enableCache: true,
    maxCacheSize: 100,
    timeoutMs: 30000,
    maxConcurrency: 3
  });
  
  // 8. 设置记忆衰减机制
  console.log("8. Setting up Memory Decay Mechanism...");
  // 注意：这里我们使用一个简单的内存存储模拟
  const dummyStore: any = {
    async add(chunk: any) { console.log(`Memory added: ${chunk.id}`); },
    async search(userId: string, query: string, embedder: any, topK: number) { return []; }
  };
  const decayMechanism = new MemoryDecayMechanism(dummyStore);
  
  // 9. 设置写入门控机制
  console.log("9. Setting up Write Gating Mechanism...");
  const dummyEmbedder: any = {
    async embed(text: string) { return Array(1536).fill(0.1); }
  };
  const writeGating = new WriteGatingMechanism(dummyStore, dummyEmbedder);
  
  // 添加一个示例写入规则
  writeGating.addRule({
    name: "Content Filter Rule",
    description: "Filters out certain content patterns",
    condition: { type: 'content_filter', patterns: ['spam', 'junk'] },
    enabled: true,
    priority: 1
  });
  
  console.log("\n=== Test Operations ===");
  
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
  
  // 示例4: 配置摘要
  console.log("\n4. Configuration Summary:");
  console.log(configManager.getModelConfigSummary());
  
  // 清理资源
  decayMechanism.close();
  
  console.log("\n=== Test Completed Successfully ===");
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});