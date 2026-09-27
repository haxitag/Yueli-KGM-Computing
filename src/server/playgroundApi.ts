import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { Request, Response, NextFunction } from 'express';
import { extractAutoRoutingTrace } from '../llm/autoRoutingClient.js';
import { HttpLlmClient, type LlmClient } from '../llm/client.js';
import { MultimodalProcessor, type MediaContent, type MediaType } from '../multimodal/processor.js';
import { LanguageAsAService } from '../multimodal/languageService.js';
import { parseSkillMd } from '../playground/skillMd.js';
import { kgmFail } from '../utils/kgmHttpErrors.js';

export const playgroundRouter = express.Router();

/** Injected by combined/enhanced servers so trust-proxy shares HTTP AutoRouting. */
let playgroundLlmClient: LlmClient | undefined;

export function configurePlaygroundApi(options: { llmClient?: LlmClient }): void {
  if (options.llmClient) {
    playgroundLlmClient = options.llmClient;
  }
}

function resolvePlaygroundLlmClient(): LlmClient {
  return playgroundLlmClient ?? createPlaygroundEnvFallbackClient();
}

// 初始化多模态处理器和语言服务 - 信任委托与代理服务
const multimodalProcessor = new MultimodalProcessor();
const langService = new LanguageAsAService(multimodalProcessor, {
  enableCache: true,
  maxCacheSize: 100,
  timeoutMs: 30000,
  maxConcurrency: 3
}, {
  delegationEnabled: true,
  enrichmentLevel: 'comprehensive',
  knowledgeGraphCompletion: true
});

playgroundRouter.post('/parse-skill-md', (req: Request, res: Response) => {
  try {
    const content = typeof (req.body as { content?: string })?.content === 'string'
      ? (req.body as { content: string }).content
      : '';
    if (!content.trim()) {
      res.status(400).json({ error: 'content_required' });
      return;
    }
    res.json(parseSkillMd(content));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

playgroundRouter.get('/native-runtime/defaults', (_req: Request, res: Response) => {
  const defaultModelPath = process.env.KGM_MODEL_PATH?.trim() || '';
  const ollamaModelDirs = [
    path.join(os.homedir(), '.ollama', 'models'),
    '/usr/share/ollama/.ollama/models',
  ].filter((candidate, index, all) => all.indexOf(candidate) === index && fs.existsSync(candidate));
  const ollamaModelRefs = ollamaModelDirs.flatMap((candidate) => listOllamaModelRefs(candidate));
  res.json({
    defaultModelPath,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    ollamaModelDirs,
    ollamaModelRefs,
  });
});

playgroundRouter.get('/filesystem/list', (req: Request, res: Response) => {
  try {
    const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const fallback = process.env.KGM_MODEL_PATH?.trim() || process.cwd();
    const requestedPath = rawPath || fallback;
    const resolvedPath = normalizeFilesystemPath(requestedPath);
    const browsablePath = resolveNearestExistingPath(resolvedPath);
    const stat = fs.statSync(browsablePath);
    const currentPath = stat.isDirectory() ? browsablePath : path.dirname(browsablePath);
    const selectedPath = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile() ? resolvedPath : null;
    const parentPath = path.dirname(currentPath);

    const items = fs.readdirSync(currentPath, { withFileTypes: true })
      .map((entry) => {
        const entryPath = path.join(currentPath, entry.name);
        const entryStat = fs.statSync(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          sizeBytes: entry.isDirectory() ? undefined : entryStat.size,
          mtimeMs: entryStat.mtimeMs,
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return left.name.localeCompare(right.name, 'zh-CN');
      });

    res.json({
      currentPath,
      parentPath: parentPath !== currentPath ? parentPath : null,
      selectedPath,
      requestedPath: resolvedPath,
      items,
    });
  } catch (error) {
    res.status(400).json({
      error: 'filesystem_list_failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

function normalizeFilesystemPath(value: string): string {
  if (value.startsWith('file://')) {
    return decodeURIComponent(new URL(value).pathname);
  }
  return path.resolve(value);
}

function resolveNearestExistingPath(targetPath: string): string {
  let cursor = targetPath;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`path_not_found:${targetPath}`);
    }
    cursor = parent;
  }
  return cursor;
}

function listOllamaModelRefs(storeRoot: string): string[] {
  const manifestRoot = path.join(storeRoot, 'manifests');
  if (!fs.existsSync(manifestRoot)) {
    return [];
  }
  const refs = new Set<string>();
  const queue = [manifestRoot];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      const ref = deriveOllamaModelRef(manifestRoot, entryPath);
      if (ref) {
        refs.add(ref);
      }
    }
  }
  return [...refs].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function deriveOllamaModelRef(manifestRoot: string, manifestPath: string): string | null {
  const relative = path.relative(manifestRoot, manifestPath).split(path.sep).filter(Boolean);
  if (relative.length < 2) {
    return null;
  }
  const tag = relative.pop()!;
  if (relative[0] === 'registry.ollama.ai') {
    relative.shift();
  }
  if (relative[0] === 'library') {
    relative.shift();
  }
  if (relative.length === 0) {
    return null;
  }
  return `${relative.join('/')}:${tag}`;
}

playgroundRouter.post('/trust-proxy-process', async (req: Request, res: Response) => { // 信任委托API端点
  console.log('[Trust Proxy] Processing request with comprehensive context and knowledge graph completion');
  try {
    const { prompt, model, temperature = 0.7, maxTokens = 1024, mediaInputs } = req.body;
    const providerAlias = normalizeProviderAlias(model);
    const requestedModel = providerAlias ? undefined : normalizeRequestedModel(model);
    // Same client as /v1/chat/completions (AutoRouting); stream vs auto stay separate stages.
    const client = resolvePlaygroundLlmClient();
    
    // 添加基本输入
    let finalPrompt = prompt;
    
    // 信任委托 - 通过知识图谱补全和上下文丰富性处理多模态内容
    if (mediaInputs) {
      const mediaContent = await processMediaInputs(mediaInputs);
      
      if (mediaContent.length > 0) {
        // 构建丰富上下文 - 信任委托的基础
        finalPrompt = '[Context Enrichment: Comprehensive]\n' +
                     '[Media Inputs: ' + mediaContent.length + ' items]\n' +
                     mediaContent.join('\n') + '\n\n' +
                     '[User Request]: ' + prompt + '\n\n' +
                     '[Trust Delegation: Active]\n' +
                     '[Knowledge Graph: Enabled]\n' +
                     '[Information Completeness: Enhanced]';
      }
    }

    // 信任代理 - 通过计算模型情景和效用适配逻辑处理请求
    console.log('[Trust Proxy] Executing completion with context-enriched prompt');
    const result = await client.complete(finalPrompt, {
      model: requestedModel,
      temperature,
      maxTokens,
      routing: providerAlias
        ? { target: { provider: providerAlias } }
        : undefined,
      metadata: providerAlias
        ? { provider_preference: providerAlias }
        : undefined,
    });
    
    console.log('[Trust Proxy] Completion result received, applying audit trail');

    // 信任代理 - 生成可审计的响应
    const response = await processOutputBasedOnRequest(prompt, result);
    
    // 添加信任代理元数据
    response._trustMetadata = {
      timestamp: new Date().toISOString(),
      contextEnrichmentLevel: 'comprehensive',
      knowledgeGraphCompletion: true,
      trustDelegationActive: true,
      auditTrail: true,
      providerRouting: extractProviderRouting(result.raw),
      autoRouting: extractAutoRoutingTrace(result.raw),
    };

    res.json(response);
  } catch (error) {
    console.error('Playground API Error:', error);
    const fail = kgmFail(
      'playground_trust_proxy_failed',
      error instanceof Error ? error.message : 'Unknown error',
      500,
      { cause: 'trust-proxy-process' },
    );
    res.status(fail.status).json(fail.body);
  }
});

/**
 * 根据请求内容处理输出
 */
async function processOutputBasedOnRequest(prompt: string, llmResult: any): Promise<any> {
  const lowerPrompt = prompt.toLowerCase();
  
  // 检测请求类型并生成相应输出
  const response: any = {
    text: llmResult?.text || llmResult || '处理完成',
    images: [],
    video: null,
    audio: null,
    unsupportedMediaRequests: []
  };

  // 检查是否请求生成图片
  if (lowerPrompt.includes('生成图片') || 
      lowerPrompt.includes('image') || 
      lowerPrompt.includes('picture') ||
      lowerPrompt.includes('draw')) {
    
    response.unsupportedMediaRequests.push({
      type: 'image',
      reason: 'image_generation_provider_not_configured'
    });
  }
  
  // 检查是否请求生成视频
  if (lowerPrompt.includes('生成视频') || 
      lowerPrompt.includes('video') || 
      lowerPrompt.includes('animate')) {
    
    response.unsupportedMediaRequests.push({
      type: 'video',
      reason: 'video_generation_provider_not_configured'
    });
  }
  
  // 检查是否请求生成音频
  if (lowerPrompt.includes('生成音频') || 
      lowerPrompt.includes('audio') || 
      lowerPrompt.includes('speech') ||
      lowerPrompt.includes('声音')) {
    
    response.unsupportedMediaRequests.push({
      type: 'audio',
      reason: 'audio_generation_provider_not_configured'
    });
  }

  return response;
}

async function processMediaInputs(mediaInputs: unknown): Promise<string[]> {
  const items = normalizeMediaInputs(mediaInputs);
  const processed = await multimodalProcessor.processBatch(items);
  return processed
    .map((item) => item.textRepresentation.trim())
    .filter(Boolean);
}

function normalizeMediaInputs(mediaInputs: unknown): MediaContent[] {
  if (!mediaInputs || typeof mediaInputs !== 'object') {
    return [];
  }
  const record = mediaInputs as Record<string, unknown>;
  return [
    ...normalizeMediaList(record.images, 'image'),
    ...normalizeMediaList(record.audio, 'audio'),
    ...normalizeMediaList(record.video, 'video'),
    ...normalizeMediaList(record.documents, 'document'),
  ];
}

function normalizeMediaList(value: unknown, type: MediaType): MediaContent[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return {
        type: (typeof record.type === 'string' ? record.type : type) as MediaType,
        data: String(record.data ?? record.url ?? record.base64 ?? ''),
        metadata: {
          filename: typeof record.filename === 'string' ? record.filename : undefined,
          mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
        },
      };
    }
    return { type, data: String(item) };
  }).filter((item) => item.data.trim());
}

/** Standalone playgroundServer only — prefer configurePlaygroundApi(llmClient) in production. */
function createPlaygroundEnvFallbackClient(): HttpLlmClient {
  return new HttpLlmClient({
    baseUrl: process.env.KGM_LLM_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.KGM_LLM_MODEL || 'gpt-4o-mini',
    apiKey: process.env.KGM_LLM_API_KEY || process.env.OPENAI_API_KEY,
    path: process.env.KGM_LLM_PATH || '/chat/completions',
    mode: (process.env.KGM_LLM_MODE as 'chat' | 'completions' | undefined) || 'chat',
    timeoutMs: parseNumber(process.env.KGM_LLM_TIMEOUT_MS),
  });
}

function normalizeProviderAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (PROVIDER_ALIASES.has(normalized)) {
    return normalized;
  }
  return undefined;
}

function normalizeRequestedModel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractProviderRouting(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const candidate = (raw as { providerRouting?: Record<string, unknown> }).providerRouting;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

const PROVIDER_ALIASES = new Set([
  'aliyun',
  'aliyun_bailian',
  'anthropic',
  'aws_bedrock',
  'azure_openai',
  'baidu_qianfan',
  'custom',
  'deepseek',
  'ds4',
  'fireworks',
  'gemini',
  'groq',
  'huggingface',
  'koboldcpp',
  'llama_cpp',
  'lmstudio',
  'minimax',
  'mistral',
  'modelscope',
  'moonshot',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'perplexity',
  'sglang',
  'text_generation_webui',
  'together',
  'volcengine_ark',
  'vllm',
  'vmlx',
  'xiaomi',
  'zhipu',
]);

// 云端模型默认定价表（可覆盖）
const DEFAULT_CLOUD_PRICING: Record<string, { inputPer1k: number; outputPer1k: number; currency: string }> = {
  'gpt-5.4': { inputPer1k: 0.005, outputPer1k: 0.015, currency: 'USD' },
  'gpt-5.5': { inputPer1k: 0.01, outputPer1k: 0.03, currency: 'USD' },
  'gpt-oss': { inputPer1k: 0.002, outputPer1k: 0.006, currency: 'USD' },
  'glm-5.0': { inputPer1k: 0.0005, outputPer1k: 0.0005, currency: 'USD' },
  'glm-5.1': { inputPer1k: 0.001, outputPer1k: 0.001, currency: 'USD' },
  'glm-5.2': { inputPer1k: 0.0012, outputPer1k: 0.0012, currency: 'USD' },
  'mimo-v2.5-pro': { inputPer1k: 0.000435, outputPer1k: 0.00087, currency: 'USD' },
  'mimo-v2.5': { inputPer1k: 0.00014, outputPer1k: 0.00028, currency: 'USD' },
  'mimo-2.5': { inputPer1k: 0.0008, outputPer1k: 0.0008, currency: 'USD' },
  'claude-sonnet-4.6': { inputPer1k: 0.003, outputPer1k: 0.015, currency: 'USD' },
  'claude-opus-4.7': { inputPer1k: 0.015, outputPer1k: 0.075, currency: 'USD' },
  'claude-opus-4.8': { inputPer1k: 0.018, outputPer1k: 0.09, currency: 'USD' },
  'claude-fable-5': { inputPer1k: 0.004, outputPer1k: 0.02, currency: 'USD' },
  'kimi-2.5': { inputPer1k: 0.0005, outputPer1k: 0.0005, currency: 'USD' },
  'kimi-2.6': { inputPer1k: 0.001, outputPer1k: 0.001, currency: 'USD' },
  'kimi-2.7': { inputPer1k: 0.0012, outputPer1k: 0.0012, currency: 'USD' },
  'minimax-2.5': { inputPer1k: 0.0008, outputPer1k: 0.0008, currency: 'USD' },
  'minimax-2.6': { inputPer1k: 0.001, outputPer1k: 0.001, currency: 'USD' },
  'minimax-2.7': { inputPer1k: 0.0012, outputPer1k: 0.0012, currency: 'USD' },
  'minimax-3.0': { inputPer1k: 0.0015, outputPer1k: 0.0015, currency: 'USD' },
  'deepseek-3.2': { inputPer1k: 0.00014, outputPer1k: 0.00028, currency: 'USD' },
  'deepseek-v4': { inputPer1k: 0.0003, outputPer1k: 0.0006, currency: 'USD' },
  'qwen-3.5': { inputPer1k: 0.0003, outputPer1k: 0.0006, currency: 'USD' },
  'qwen-3.6': { inputPer1k: 0.0005, outputPer1k: 0.001, currency: 'USD' },
};

// 内存中的定价覆盖（运行时修改）
const pricingOverrides = new Map<string, { inputPer1k: number; outputPer1k: number; currency: string }>();

/**
 * 获取模型定价
 * 支持每1k和每百万两种计价模式
 */
playgroundRouter.get('/pricing', (_req: Request, res: Response) => {
  const mode = (_req.query.mode as string) || 'per1k'; // per1k | per1m
  const result: Record<string, { input: number; output: number; currency: string; mode: string }> = {};
  const multiplier = mode === 'per1m' ? 1000 : 1;

  for (const [model, defaults] of Object.entries(DEFAULT_CLOUD_PRICING)) {
    const override = pricingOverrides.get(model);
    const effective = override ?? defaults;
    result[model] = {
      input: effective.inputPer1k * multiplier,
      output: effective.outputPer1k * multiplier,
      currency: effective.currency,
      mode,
    };
  }

  res.json({
    models: result,
    mode,
    note: '价格为云端推理价格，本地推理不计价',
    updatedAt: new Date().toISOString(),
  });
});

/**
 * 更新模型定价
 */
playgroundRouter.post('/pricing', (req: Request, res: Response) => {
  const body = req.body as {
    model: string;
    inputPrice: number;
    outputPrice: number;
    currency?: string;
    mode?: string; // per1k | per1m
  };

  if (!body.model || typeof body.inputPrice !== 'number' || typeof body.outputPrice !== 'number') {
    res.status(400).json({ error: 'model, inputPrice, outputPrice are required' });
    return;
  }

  const mode = body.mode || 'per1k';
  const divisor = mode === 'per1m' ? 1000 : 1;

  pricingOverrides.set(body.model, {
    inputPer1k: body.inputPrice / divisor,
    outputPer1k: body.outputPrice / divisor,
    currency: body.currency || 'USD',
  });

  res.json({
    model: body.model,
    inputPrice: body.inputPrice,
    outputPrice: body.outputPrice,
    currency: body.currency || 'USD',
    mode,
    updatedAt: new Date().toISOString(),
  });
});

/**
 * 重置模型定价为默认值
 */
playgroundRouter.delete('/pricing/:model', (req: Request, res: Response) => {
  const model = Array.isArray(req.params.model) ? req.params.model[0] : req.params.model;
  const existed = pricingOverrides.delete(model);
  res.json({
    model,
    reset: existed,
    updatedAt: new Date().toISOString(),
  });
});

// 添加CORS中间件支持
playgroundRouter.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

export default playgroundRouter;
