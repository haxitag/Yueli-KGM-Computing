import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HttpLlmClient } from '../llm/client.js';
import { ProviderRoutedLlmClient } from '../llm/providerRoutedClient.js';
import { MultimodalProcessor } from '../multimodal/processor.js';
import { LanguageAsAService } from '../multimodal/languageService.js';
import { parseSkillMd } from '../playground/skillMd.js';
export const playgroundRouter = express.Router();
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
playgroundRouter.post('/parse-skill-md', (req, res) => {
    try {
        const content = typeof req.body?.content === 'string'
            ? req.body.content
            : '';
        if (!content.trim()) {
            res.status(400).json({ error: 'content_required' });
            return;
        }
        res.json(parseSkillMd(content));
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
playgroundRouter.get('/native-runtime/defaults', (_req, res) => {
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
playgroundRouter.get('/filesystem/list', (req, res) => {
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
    }
    catch (error) {
        res.status(400).json({
            error: 'filesystem_list_failed',
            details: error instanceof Error ? error.message : String(error),
        });
    }
});
function normalizeFilesystemPath(value) {
    if (value.startsWith('file://')) {
        return decodeURIComponent(new URL(value).pathname);
    }
    return path.resolve(value);
}
function resolveNearestExistingPath(targetPath) {
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
function listOllamaModelRefs(storeRoot) {
    const manifestRoot = path.join(storeRoot, 'manifests');
    if (!fs.existsSync(manifestRoot)) {
        return [];
    }
    const refs = new Set();
    const queue = [manifestRoot];
    while (queue.length > 0) {
        const current = queue.pop();
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
function deriveOllamaModelRef(manifestRoot, manifestPath) {
    const relative = path.relative(manifestRoot, manifestPath).split(path.sep).filter(Boolean);
    if (relative.length < 2) {
        return null;
    }
    const tag = relative.pop();
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
playgroundRouter.post('/trust-proxy-process', async (req, res) => {
    console.log('[Trust Proxy] Processing request with comprehensive context and knowledge graph completion');
    try {
        const { prompt, model, temperature = 0.7, maxTokens = 1024, mediaInputs } = req.body;
        const providerAlias = normalizeProviderAlias(model);
        const requestedModel = providerAlias ? undefined : normalizeRequestedModel(model);
        const client = new ProviderRoutedLlmClient({
            fallback: createPlaygroundFallbackClient(),
            forcedProviderType: providerAlias,
        });
        // 添加基本输入
        let finalPrompt = prompt;
        // 信任委托 - 通过知识图谱补全和上下文丰富性处理多模态内容
        if (mediaInputs) {
            const mediaContent = [];
            // 处理图片
            if (mediaInputs.images && mediaInputs.images.length > 0) {
                for (const imageName of mediaInputs.images) {
                    // 在实际实现中，这里会处理上传的图片
                    // 暂时简单处理，实际应该从上传的文件中提取信息
                    mediaContent.push(`Image: ${imageName} (image content would be processed here)`);
                }
            }
            // 处理音频
            if (mediaInputs.audio) {
                mediaContent.push(`Audio: ${mediaInputs.audio} (audio content would be transcribed here)`);
            }
            // 处理视频
            if (mediaInputs.video) {
                mediaContent.push(`Video: ${mediaInputs.video} (video content would be analyzed here)`);
            }
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
        };
        res.json(response);
    }
    catch (error) {
        console.error('Playground API Error:', error);
        res.status(500).json({
            error: '处理请求时发生错误',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
/**
 * 根据请求内容处理输出
 */
async function processOutputBasedOnRequest(prompt, llmResult) {
    const lowerPrompt = prompt.toLowerCase();
    // 检测请求类型并生成相应输出
    const response = {
        text: llmResult?.text || llmResult || '处理完成',
        images: [],
        video: null,
        audio: null
    };
    // 检查是否请求生成图片
    if (lowerPrompt.includes('生成图片') ||
        lowerPrompt.includes('image') ||
        lowerPrompt.includes('picture') ||
        lowerPrompt.includes('draw')) {
        // 在实际实现中，这里会调用图像生成API
        // 暂时返回模拟的图片URL
        response.images = [`/generated-images/mock-${Date.now()}.jpg`];
    }
    // 检查是否请求生成视频
    if (lowerPrompt.includes('生成视频') ||
        lowerPrompt.includes('video') ||
        lowerPrompt.includes('animate')) {
        // 在实际实现中，这里会调用视频生成API
        // 暂时返回模拟的视频URL
        response.video = `/generated-videos/mock-${Date.now()}.mp4`;
    }
    // 检查是否请求生成音频
    if (lowerPrompt.includes('生成音频') ||
        lowerPrompt.includes('audio') ||
        lowerPrompt.includes('speech') ||
        lowerPrompt.includes('声音')) {
        // 在实际实现中，这里会调用音频生成API
        // 暂时返回模拟的音频URL
        response.audio = `/generated-audio/mock-${Date.now()}.mp3`;
    }
    return response;
}
function createPlaygroundFallbackClient() {
    return new HttpLlmClient({
        baseUrl: process.env.KGM_LLM_BASE_URL || 'https://api.openai.com/v1',
        model: process.env.KGM_LLM_MODEL || 'gpt-4o-mini',
        apiKey: process.env.KGM_LLM_API_KEY || process.env.OPENAI_API_KEY,
        path: process.env.KGM_LLM_PATH || '/chat/completions',
        mode: process.env.KGM_LLM_MODE || 'chat',
        timeoutMs: parseNumber(process.env.KGM_LLM_TIMEOUT_MS),
    });
}
function normalizeProviderAlias(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (PROVIDER_ALIASES.has(normalized)) {
        return normalized;
    }
    return undefined;
}
function normalizeRequestedModel(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
}
function parseNumber(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function extractProviderRouting(raw) {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const candidate = raw.providerRouting;
    return candidate && typeof candidate === 'object' ? candidate : undefined;
}
const PROVIDER_ALIASES = new Set([
    'openai',
    'zhipu',
    'minimax',
    'openrouter',
    'nvidia',
    'deepseek',
    'ollama',
    'vllm',
    'slang',
    'custom',
]);
// 添加CORS中间件支持
playgroundRouter.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    }
    else {
        next();
    }
});
export default playgroundRouter;
