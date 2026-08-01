import { 
  LlmProviderFactory,
  ZhipuLlmClient,
  MinimaxLlmClient,
  OpenRouterLlmClient,
  NvidiaLlmClient,
  DeepSeekLlmClient,
  OllamaLlmClient,
  VllmLlmClient,
  SglangLlmClient
} from "../index.js";

async function main(): Promise<void> {
  console.log("=== KGM-Computing Third Party Models Demo ===\n");

  // 显示所有支持的提供商
  console.log("Supported providers:", LlmProviderFactory.getSupportedProviders());

  // 示例1: 使用工厂创建智谱AI客户端
  console.log("\n1. Testing Zhipu AI GLM model:");
  try {
    const zhipuConfig = LlmProviderFactory.createConfigFromEnv('zhipu');
    if (zhipuConfig) {
      const zhipuClient = LlmProviderFactory.createClient(zhipuConfig);
      const zhipuResult = await zhipuClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   Zhipu response: ${zhipuResult.text.substring(0, 100)}...`);
    } else {
      console.log("   Zhipu API key not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   Zhipu test failed:", error);
  }

  // 示例2: 使用工厂创建Minimax客户端
  console.log("\n2. Testing Minimax model:");
  try {
    const minimaxConfig = LlmProviderFactory.createConfigFromEnv('minimax');
    if (minimaxConfig) {
      const minimaxClient = LlmProviderFactory.createClient(minimaxConfig);
      const minimaxResult = await minimaxClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   Minimax response: ${minimaxResult.text.substring(0, 100)}...`);
    } else {
      console.log("   Minimax API key not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   Minimax test failed:", error);
  }

  // 示例3: 使用工厂创建OpenRouter客户端
  console.log("\n3. Testing OpenRouter model:");
  try {
    const openrouterConfig = LlmProviderFactory.createConfigFromEnv('openrouter');
    if (openrouterConfig) {
      const openrouterClient = LlmProviderFactory.createClient(openrouterConfig);
      const openrouterResult = await openrouterClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   OpenRouter response: ${openrouterResult.text.substring(0, 100)}...`);
    } else {
      console.log("   OpenRouter API key not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   OpenRouter test failed:", error);
  }

  // 示例4: 使用工厂创建NVIDIA客户端
  console.log("\n4. Testing NVIDIA model:");
  try {
    const nvidiaConfig = LlmProviderFactory.createConfigFromEnv('nvidia');
    if (nvidiaConfig) {
      const nvidiaClient = LlmProviderFactory.createClient(nvidiaConfig);
      const nvidiaResult = await nvidiaClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   NVIDIA response: ${nvidiaResult.text.substring(0, 100)}...`);
    } else {
      console.log("   NVIDIA API key not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   NVIDIA test failed:", error);
  }

  // 示例5: 使用工厂创建DeepSeek客户端
  console.log("\n5. Testing DeepSeek model:");
  try {
    const deepseekConfig = LlmProviderFactory.createConfigFromEnv('deepseek');
    if (deepseekConfig) {
      const deepseekClient = LlmProviderFactory.createClient(deepseekConfig);
      const deepseekResult = await deepseekClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   DeepSeek response: ${deepseekResult.text.substring(0, 100)}...`);
    } else {
      console.log("   DeepSeek API key not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   DeepSeek test failed:", error);
  }

  // 示例6: 使用工厂创建Ollama客户端
  console.log("\n6. Testing Ollama model:");
  try {
    const ollamaConfig = LlmProviderFactory.createConfigFromEnv('ollama');
    if (ollamaConfig) {
      const ollamaClient = LlmProviderFactory.createClient(ollamaConfig);
      const ollamaResult = await ollamaClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   Ollama response: ${ollamaResult.text.substring(0, 100)}...`);
    } else {
      console.log("   Ollama base URL not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   Ollama test failed:", error);
  }

  // 示例7: 使用工厂创建vLLM客户端
  console.log("\n7. Testing vLLM model:");
  try {
    const vllmConfig = LlmProviderFactory.createConfigFromEnv('vllm');
    if (vllmConfig) {
      const vllmClient = LlmProviderFactory.createClient(vllmConfig);
      const vllmResult = await vllmClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   vLLM response: ${vllmResult.text.substring(0, 100)}...`);
    } else {
      console.log("   vLLM base URL not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   vLLM test failed:", error);
  }

  // 示例8: 使用工厂创建 SGLang 客户端
  console.log("\n8. Testing SGLang model:");
  try {
    const sglangConfig = LlmProviderFactory.createConfigFromEnv('sglang');
    if (sglangConfig) {
      const sglangClient = LlmProviderFactory.createClient(sglangConfig);
      const sglangResult = await sglangClient.complete("你好，请介绍一下自己", { maxTokens: 100 });
      console.log(`   SGLang response: ${sglangResult.text.substring(0, 100)}...`);
    } else {
      console.log("   SGLang base URL not found in environment, skipping test");
    }
  } catch (error) {
    console.error("   SGLang test failed:", error);
  }

  // 示例9: 直接使用客户端类（不通过工厂）
  console.log("\n9. Testing direct client instantiation:");
  try {
    // 注意：这只是一个示例，实际使用时需要真实的API密钥和配置
    console.log("   Clients available: ZhipuLlmClient, MinimaxLlmClient, OpenRouterLlmClient, NvidiaLlmClient, DeepSeekLlmClient, OllamaLlmClient, VllmLlmClient, SglangLlmClient");
  } catch (error) {
    console.error("   Direct client test failed:", error);
  }

  console.log("\n=== Third Party Models Demo Completed ===");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});