import { LlmProviderFactory } from "../index.js";

async function main(): Promise<void> {
  console.log("=== KGM-Computing Provider Factory Test ===\n");

  // 显示所有支持的提供商
  console.log("Supported providers:", LlmProviderFactory.getSupportedProviders());

  // 测试配置验证
  console.log("\nTesting config validation:");
  
  // 测试智谱AI配置
  const zhipuValid = LlmProviderFactory.validateConfig({
    type: 'zhipu',
    model: 'glm-4',
    apiKey: 'test-key'
  });
  console.log(`Zhipu config valid: ${zhipuValid}`);
  
  // 测试Minimax配置
  const minimaxValid = LlmProviderFactory.validateConfig({
    type: 'minimax',
    model: 'abab5.5-chat',
    apiKey: 'test-key',
    extraParams: { groupId: 'test-group' }
  });
  console.log(`Minimax config valid: ${minimaxValid}`);
  
  // 测试Ollama配置
  const ollamaValid = LlmProviderFactory.validateConfig({
    type: 'ollama',
    model: 'llama3',
    baseUrl: 'http://localhost:11434/api'
  });
  console.log(`Ollama config valid: ${ollamaValid}`);

  // 尝试从环境变量创建配置
  console.log("\nTrying to create configs from environment:");
  
  const zhipuConfig = LlmProviderFactory.createConfigFromEnv('zhipu');
  console.log(`Zhipu config from env: ${!!zhipuConfig}`);
  
  const minimaxConfig = LlmProviderFactory.createConfigFromEnv('minimax');
  console.log(`Minimax config from env: ${!!minimaxConfig}`);
  
  const openrouterConfig = LlmProviderFactory.createConfigFromEnv('openrouter');
  console.log(`OpenRouter config from env: ${!!openrouterConfig}`);
  
  const nvidiaConfig = LlmProviderFactory.createConfigFromEnv('nvidia');
  console.log(`NVIDIA config from env: ${!!nvidiaConfig}`);
  
  const deepseekConfig = LlmProviderFactory.createConfigFromEnv('deepseek');
  console.log(`DeepSeek config from env: ${!!deepseekConfig}`);
  
  const ollamaConfig = LlmProviderFactory.createConfigFromEnv('ollama');
  console.log(`Ollama config from env: ${!!ollamaConfig}`);
  
  const vllmConfig = LlmProviderFactory.createConfigFromEnv('vllm');
  console.log(`vLLM config from env: ${!!vllmConfig}`);
  
  const sglangConfig = LlmProviderFactory.createConfigFromEnv('sglang');
  console.log(`SGLang config from env: ${!!sglangConfig}`);

  console.log("\n=== Provider Factory Test Completed ===");
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});