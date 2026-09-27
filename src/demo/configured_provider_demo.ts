import { 
  LlmProviderFactory, 
  ProviderConfigurationManager 
} from "../index.js";

async function main(): Promise<void> {
  console.log("=== KGM-Computing Configured Provider Demo ===\n");

  // 1. 创建提供商配置管理器
  console.log("1. Setting up Provider Configuration Manager...");
  const configManager = new ProviderConfigurationManager('./config/model-providers.json');
  
  try {
    // 从配置文件加载配置
    await configManager.loadConfiguration();
    console.log("   Configuration loaded successfully");
  } catch (error) {
    console.log("   Using default configuration (config file not found)");
  }

  // 从环境变量更新敏感信息
  configManager.updateFromEnvironment();
  console.log("   Updated configuration with environment variables");

  // 2. 显示配置摘要
  console.log("\n2. Provider Configuration Summary:");
  console.log(configManager.getProviderConfigSummary());

  // 3. 测试不同任务的最佳提供商选择
  console.log("\n3. Testing Provider Selection for Different Tasks:");

  const tasks = [
    "请用中文回答这个问题",
    "Solve this mathematical equation",
    "Write a Python function",
    "Process this locally without sending to external services"
  ];

  for (const task of tasks) {
    console.log(`\n   Task: "${task}"`);
    const bestProvider = configManager.getBestProviderForTask(task);
    if (bestProvider) {
      console.log(`   Best provider: ${bestProvider.type}:${bestProvider.model}`);
      
      // 尝试创建客户端（仅当API密钥可用时）
      try {
        const client = LlmProviderFactory.createClient(bestProvider);
        console.log(`   Client created successfully for ${bestProvider.type}`);
      } catch (error) {
        console.log(`   Could not create client: ${(error as Error).message}`);
      }
    } else {
      console.log("   No suitable provider found");
    }
  }

  // 4. 列出所有激活的提供商
  console.log("\n4. Active Providers:");
  const activeProviders = configManager.getActiveProviderConfigs();
  for (const provider of activeProviders) {
    console.log(`   - ${provider.type}:${provider.model}`);
  }

  // 5. 演示添加新的路由规则
  console.log("\n5. Adding a new routing rule:");
  configManager.addProviderRoutingRule({
    name: "Creative Writing",
    condition: "creative|story|poem|writing",
    provider: "openai:gpt-4o",
    priority: 5
  });
  console.log("   Added 'Creative Writing' rule for GPT-4");

  // 测试新规则
  const creativeTask = "Write a creative story about AI";
  const creativeProvider = configManager.getBestProviderForTask(creativeTask);
  console.log(`   For task '${creativeTask}', selected: ${creativeProvider?.type}:${creativeProvider?.model || 'None'}`);

  console.log("\n=== Configured Provider Demo Completed ===");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});