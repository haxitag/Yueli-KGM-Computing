import { CANONICAL_EMBEDDING } from "./config.js";
import { REDACTED_CONFIG_SECRET } from "./publicConfig.js";
import fs from "node:fs";
import path from "node:path";
const defaultConfig = {
    embedding: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: CANONICAL_EMBEDDING.modelName,
        path: "/embeddings",
        version: CANONICAL_EMBEDDING.version,
        timeoutMs: 15000,
    },
    llm: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        path: "/chat/completions",
        mode: "chat",
        temperature: 0.2,
        maxTokens: 512,
        timeoutMs: 30000,
    },
    media: {
        image: { baseUrl: "", path: "/images/generations" },
        speech: { baseUrl: "", path: "/audio/speech" },
        transcription: { baseUrl: "", path: "/audio/transcriptions" },
        video: {
            baseUrl: "",
            path: "/videos/generations",
            maxDurationSec: 30,
            resultMode: "url",
            maxConcurrent: 2,
        },
        rerank: { baseUrl: "", path: "/rerank" },
        providers: [],
        modelPresets: [],
    },
    database: {
        provider: "sqlite",
        filePath: "data/kgm.sqlite",
        journalMode: "WAL",
    },
    vector: {
        backend: "chroma",
        baseUrl: "http://localhost:8000",
        apiPath: "/api/v1",
        collection: "kgm_memory",
        distance: "cosine",
        timeoutMs: 15000,
    },
    context: {
        artifactDir: "data/artifacts",
        sessionDir: "data/sessions",
        maxToolOutputChars: 2000,
        maxEvidenceChars: 800,
        artifactPreviewChars: 240,
        sessionPreviewChars: 240,
        retrievalCacheTtlMs: 0,
        enableArtifactTool: true,
        enableSessionTool: true,
        enableToolCatalogTool: true,
        toolDescriptorMode: "names",
        includeSkillNames: true,
    },
    adapter: {
        enabled: false,
        baseUrl: "http://localhost:7200",
        secret: "",
        timeoutMs: 3000,
        sendPerformance: false,
        sendContextQuality: false,
        performancePath: "/v1/ingest/kgm/performance",
        contextQualityPath: "/v1/ingest/kgm/context-quality",
    },
    ycb: {
        enabled: false,
        baseUrl: "http://localhost:58692",
        path: "/api/v1/context/for-kgm",
        apiKey: "",
        timeoutMs: 5000,
        failOpen: true,
        requireBuildRef: false,
    },
    routing: {
        version: "route-2026-02-09",
        updatedAt: "2026-02-09T00:00:00Z",
        baseWeights: {
            "openrouter/free": 0.5,
            "moonshotai/kimi-k2.5": 0.5,
        },
        routes: [
            {
                name: "coding_high_accuracy",
                priority: 100,
                match: { purpose: "coding" },
                strategy: {
                    type: "weighted",
                    weights: { "openrouter/free": 0.2, "moonshotai/kimi-k2.5": 0.8 },
                },
            },
            {
                name: "general_default",
                priority: 10,
                match: { purpose: "general" },
                strategy: { type: "weighted" },
            },
        ],
    },
    autoRouting: {
        enabled: true,
        allowDynamicSelection: true,
        defaultProfile: "quality_first",
        defaultTaskType: "general",
        preferVerifiableTasks: true,
        auditEnabled: true,
        thresholds: {
            maxCandidateCount: 6,
            maxCostPerRequest: 0.15,
            targetLatencyMs: 3500,
            minSampleCount: 3,
        },
        weights: {
            successRate: 0.24,
            quality: 0.2,
            latency: 0.12,
            cost: 0.14,
            trust: 0.18,
            verification: 0.12,
        },
        pricing: {
            default: {
                inputPer1kTokens: 0,
                outputPer1kTokens: 0,
                currency: "USD",
            },
            overrides: {
                "default:openai:gpt-4o-mini": {
                    inputPer1kTokens: 0.00015,
                    outputPer1kTokens: 0.0006,
                    currency: "USD",
                },
                "provider:zhipu:glm-4": {
                    inputPer1kTokens: 0.0005,
                    outputPer1kTokens: 0.0005,
                    currency: "USD",
                },
                // OpenAI 新模型
                "default:openai:gpt-5.4": {
                    inputPer1kTokens: 0.005,
                    outputPer1kTokens: 0.015,
                    currency: "USD",
                },
                "default:openai:gpt-5.5": {
                    inputPer1kTokens: 0.01,
                    outputPer1kTokens: 0.03,
                    currency: "USD",
                },
                "default:openai:gpt-oss": {
                    inputPer1kTokens: 0.002,
                    outputPer1kTokens: 0.006,
                    currency: "USD",
                },
                // Zhipu 新模型
                "default:zhipu:glm-5.0": {
                    inputPer1kTokens: 0.0005,
                    outputPer1kTokens: 0.0005,
                    currency: "USD",
                },
                "default:zhipu:glm-5.1": {
                    inputPer1kTokens: 0.001,
                    outputPer1kTokens: 0.001,
                    currency: "USD",
                },
                // Xiaomi MiMo OpenAPI (https://mimo.mi.com) — V2.5 series
                "default:xiaomi:mimo-v2.5-pro": {
                    inputPer1kTokens: 0.000435,
                    outputPer1kTokens: 0.00087,
                    currency: "USD",
                },
                "default:xiaomi:mimo-v2.5": {
                    inputPer1kTokens: 0.00014,
                    outputPer1kTokens: 0.00028,
                    currency: "USD",
                },
                "default:xiaomi:mimo-v2.5-pro-ultraspeed": {
                    inputPer1kTokens: 0.001305,
                    outputPer1kTokens: 0.00261,
                    currency: "USD",
                },
                "default:xiaomi:mimo-2.5": {
                    inputPer1kTokens: 0.0008,
                    outputPer1kTokens: 0.0008,
                    currency: "USD",
                },
                // Google Gemini 新模型
                "default:gemini:gemini-3.0": {
                    inputPer1kTokens: 0.0001,
                    outputPer1kTokens: 0.0004,
                    currency: "USD",
                },
                "default:gemini:gemini-3.1": {
                    inputPer1kTokens: 0.0015,
                    outputPer1kTokens: 0.006,
                    currency: "USD",
                },
                // Anthropic 新模型
                "default:anthropic:claude-sonnet-4.6": {
                    inputPer1kTokens: 0.003,
                    outputPer1kTokens: 0.015,
                    currency: "USD",
                },
                "default:anthropic:claude-opus-4.7": {
                    inputPer1kTokens: 0.015,
                    outputPer1kTokens: 0.075,
                    currency: "USD",
                },
                // 阿里云百炼新模型
                "default:aliyun:qwen-max": {
                    inputPer1kTokens: 0.0005,
                    outputPer1kTokens: 0.001,
                    currency: "USD",
                },
                "default:aliyun:qwen-plus": {
                    inputPer1kTokens: 0.0003,
                    outputPer1kTokens: 0.0006,
                    currency: "USD",
                },
                // ModelScope 新模型
                "default:modelscope:deepseek-r1": {
                    inputPer1kTokens: 0.0002,
                    outputPer1kTokens: 0.0008,
                    currency: "USD",
                },
                "default:modelscope:llama3-70b": {
                    inputPer1kTokens: 0.0004,
                    outputPer1kTokens: 0.0008,
                    currency: "USD",
                },
                // Moonshot / Kimi 新模型
                "default:moonshot:kimi-2.5": {
                    inputPer1kTokens: 0.0005,
                    outputPer1kTokens: 0.0005,
                    currency: "USD",
                },
                "default:moonshot:kimi-2.6": {
                    inputPer1kTokens: 0.001,
                    outputPer1kTokens: 0.001,
                    currency: "USD",
                },
                // Minimax 新模型
                "default:minimax:minimax-2.5": {
                    inputPer1kTokens: 0.0008,
                    outputPer1kTokens: 0.0008,
                    currency: "USD",
                },
                "default:minimax:minimax-2.7": {
                    inputPer1kTokens: 0.0012,
                    outputPer1kTokens: 0.0012,
                    currency: "USD",
                },
                // DeepSeek 新模型
                "default:deepseek:deepseek-3.2": {
                    inputPer1kTokens: 0.00014,
                    outputPer1kTokens: 0.00028,
                    currency: "USD",
                },
                "default:deepseek:deepseek-v4": {
                    inputPer1kTokens: 0.0003,
                    outputPer1kTokens: 0.0006,
                    currency: "USD",
                },
                // Qwen 新模型
                "default:qwen:qwen-3.5": {
                    inputPer1kTokens: 0.0003,
                    outputPer1kTokens: 0.0006,
                    currency: "USD",
                },
                "default:qwen:qwen-3.6": {
                    inputPer1kTokens: 0.0005,
                    outputPer1kTokens: 0.001,
                    currency: "USD",
                },
                "managed:*": {
                    inputPer1kTokens: 0,
                    outputPer1kTokens: 0,
                    currency: "USD",
                },
            },
        },
        evaluation: {
            enabled: false,
            fallbackToHeuristics: true,
            judge: {
                enabled: true,
                target: {},
                maxTokens: 240,
                temperature: 0,
                timeoutMs: 12000,
            },
            verifier: {
                enabled: true,
                target: {},
                maxTokens: 240,
                temperature: 0,
                timeoutMs: 12000,
            },
        },
        taskRoutes: [
            {
                id: "task-route-code",
                name: "代码任务优先高质量模型",
                enabled: true,
                priority: 100,
                taskType: "code_generation",
                target: {
                    provider: "zhipu",
                    model: "glm-4",
                },
                note: "可在 Playground 中切换或覆盖。",
            },
            {
                id: "task-route-structured",
                name: "结构化输出优先可验证模型",
                enabled: true,
                priority: 90,
                taskType: "structured_output",
                target: {
                    model: "gpt-4o-mini",
                },
            },
        ],
    },
    yueliai: {
        enabled: false,
        host: "https://www.yueli.com",
        apiKey: "",
        upstreamPrefix: "/api",
        timeoutMs: 120_000,
    },
    workers: {
        llamaCpp: {
            enabled: "auto",
            command: "llama-server",
            installHint: "Install llama.cpp llama-server; set workers.llamaCpp.command or KGM_LLAMA_SERVER_CMD; KGM_LLAMA_CPP_ENABLED=on|off|auto",
        },
        ds4: {
            enabled: "auto",
            command: "ds4-server",
            installHint: "Build antirez/ds4 ds4-server; set workers.ds4.command or KGM_DS4_SERVER_CMD; KGM_DS4_ENABLED=on|off|auto. Kernels stay in ds4 — not KGM native-gpu.",
        },
        tokenspeed: {
            enabled: "off",
            command: "tokenspeed",
            installHint: "Optional: TokenSpeed OpenAI-compat worker (like Ollama). Prefer KGM_TOKENSPEED_BASE_URL attach; set KGM_TOKENSPEED_ENABLED=auto|on. Default off — not intent/skills layer.",
            port: 8095,
            enablePrefixCaching: true,
        },
    },
    sandboxAdapters: {
        computer: {},
        browser: {},
        mobile: {},
    },
    playground: {
        skills: [
            {
                id: "skill-weather-demo",
                name: "weather_demo",
                description: "演示技能：串联 get_weather 工具；invoke_skill 的 input 需包含 location",
                steps: [{ id: "w", tool: "get_weather", input: { location: "{{input.location}}" } }],
                systemPromptAddon: '当用户问天气时，优先返回 JSON：{"type":"invoke_skill","skill":"weather_demo","input":{"location":"城市名"}}',
            },
        ],
        mcpConnectors: [],
        outputTemplates: [
            {
                id: "tpl-md",
                name: "Markdown 直通",
                kind: "markdown",
                template: "{{content}}",
                slots: ["content"],
            },
            {
                id: "tpl-html-report",
                name: "HTML 报告（插槽）",
                kind: "html",
                template: '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>{{title}}</title></head><body><article><h1>{{title}}</h1><div class="kgm-body">{{body}}</div><footer>{{meta}}</footer></article></body></html>',
                slots: ["title", "body", "meta", "content"],
            },
        ],
        activeSkillIds: [],
        activeMcpIds: [],
        activeOutputTemplateId: "tpl-md",
    },
};
export class ConfigStore {
    config;
    persistPath;
    autoPersist;
    constructor(options) {
        const resolved = normalizeOptions(options);
        const diskPatch = resolved.persistPath && resolved.loadFromDisk
            ? readConfigFile(resolved.persistPath)
            : undefined;
        let config = mergeConfig(defaultConfig, diskPatch ?? {});
        config = mergeConfig(config, resolved.initial ?? {});
        this.config = config;
        this.persistPath = resolved.persistPath;
        this.autoPersist = resolved.autoPersist ?? true;
        if (this.persistPath && resolved.loadFromDisk && !fs.existsSync(this.persistPath)) {
            this.persist();
        }
    }
    get() {
        return this.config;
    }
    update(next, options) {
        this.config = mergeConfig(this.config, next);
        if (this.persistPath && (options?.persist ?? this.autoPersist)) {
            this.persist();
        }
        return this.config;
    }
    persist() {
        if (!this.persistPath)
            return;
        const dir = path.dirname(this.persistPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.persistPath, JSON.stringify(this.config, null, 2));
    }
    /**
     * 从 `persistPath` 对应文件重新加载配置（与构造时磁盘加载语义一致：defaultConfig + 文件 patch）。
     * 无持久路径或文件不存在时返回 `undefined` 且不修改内存配置。
     */
    reloadFromDisk() {
        if (!this.persistPath) {
            return undefined;
        }
        const diskPatch = readConfigFile(this.persistPath);
        if (diskPatch === undefined) {
            return undefined;
        }
        this.config = mergeConfig(defaultConfig, diskPatch);
        return this.config;
    }
}
function mergeConfig(base, patch) {
    return {
        embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
        llm: { ...base.llm, ...(patch.llm ?? {}) },
        media: {
            image: { ...base.media.image, ...(patch.media?.image ?? {}) },
            speech: { ...base.media.speech, ...(patch.media?.speech ?? {}) },
            transcription: { ...base.media.transcription, ...(patch.media?.transcription ?? {}) },
            video: { ...base.media.video, ...(patch.media?.video ?? {}) },
            rerank: { ...base.media.rerank, ...(patch.media?.rerank ?? {}) },
            providers: patch.media?.providers ?? base.media.providers ?? [],
            modelPresets: patch.media?.modelPresets ?? base.media.modelPresets ?? [],
        },
        database: { ...base.database, ...(patch.database ?? {}) },
        vector: { ...base.vector, ...(patch.vector ?? {}) },
        context: { ...base.context, ...(patch.context ?? {}) },
        adapter: { ...base.adapter, ...(patch.adapter ?? {}) },
        ycb: { ...base.ycb, ...(patch.ycb ?? {}) },
        routing: { ...base.routing, ...(patch.routing ?? {}) },
        autoRouting: mergeAutoRoutingConfig(base.autoRouting, patch.autoRouting),
        yueliai: mergeYueliAiGatewayConfig(base.yueliai, patch.yueliai),
        workers: mergeWorkersConfig(base.workers, patch.workers),
        sandboxAdapters: mergeSandboxAdaptersConfig(base.sandboxAdapters, patch.sandboxAdapters),
        playground: mergePlaygroundConfig(base.playground, patch.playground),
    };
}
function mergeSandboxAdaptersConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        computer: mergeSandboxKindConfig(base.computer, patch.computer),
        browser: mergeSandboxKindConfig(base.browser, patch.browser),
        mobile: mergeSandboxKindConfig(base.mobile, patch.mobile),
    };
}
function mergeSandboxKindConfig(base, patch) {
    if (!patch) {
        return base;
    }
    const next = { ...base };
    if (patch.startCommand !== undefined)
        next.startCommand = patch.startCommand;
    if (patch.stopCommand !== undefined)
        next.stopCommand = patch.stopCommand;
    if (patch.statusCommand !== undefined)
        next.statusCommand = patch.statusCommand;
    if (patch.endpoint !== undefined)
        next.endpoint = patch.endpoint;
    if (patch.hint !== undefined)
        next.hint = patch.hint;
    if (Object.prototype.hasOwnProperty.call(patch, "useEmbedded")) {
        if (patch.useEmbedded == null) {
            delete next.useEmbedded;
        }
        else {
            next.useEmbedded = patch.useEmbedded;
        }
    }
    return next;
}
function mergeWorkersConfig(base, patch) {
    if (!patch?.llamaCpp && !patch?.ds4 && !patch?.tokenspeed) {
        return base;
    }
    return {
        llamaCpp: patch?.llamaCpp
            ? {
                ...base.llamaCpp,
                ...patch.llamaCpp,
                enabled: patch.llamaCpp.enabled ?? base.llamaCpp.enabled,
                command: patch.llamaCpp.command?.trim() || base.llamaCpp.command,
                installHint: patch.llamaCpp.installHint ?? base.llamaCpp.installHint,
            }
            : base.llamaCpp,
        ds4: patch?.ds4
            ? {
                ...base.ds4,
                ...patch.ds4,
                enabled: patch.ds4.enabled ?? base.ds4.enabled,
                command: patch.ds4.command?.trim() || base.ds4.command,
                installHint: patch.ds4.installHint ?? base.ds4.installHint,
                chdir: patch.ds4.chdir ?? base.ds4.chdir,
            }
            : base.ds4,
        tokenspeed: patch?.tokenspeed
            ? {
                ...base.tokenspeed,
                ...patch.tokenspeed,
                enabled: patch.tokenspeed.enabled ?? base.tokenspeed.enabled,
                command: patch.tokenspeed.command?.trim() || base.tokenspeed.command,
                installHint: patch.tokenspeed.installHint ?? base.tokenspeed.installHint,
                baseUrl: patch.tokenspeed.baseUrl ?? base.tokenspeed.baseUrl,
                port: patch.tokenspeed.port ?? base.tokenspeed.port,
                attach: patch.tokenspeed.attach ?? base.tokenspeed.attach,
                toolCallParser: patch.tokenspeed.toolCallParser ?? base.tokenspeed.toolCallParser,
                reasoningParser: patch.tokenspeed.reasoningParser ?? base.tokenspeed.reasoningParser,
                enablePrefixCaching: patch.tokenspeed.enablePrefixCaching ?? base.tokenspeed.enablePrefixCaching,
                extraArgs: patch.tokenspeed.extraArgs ?? base.tokenspeed.extraArgs,
            }
            : base.tokenspeed,
    };
}
function mergeYueliAiGatewayConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        ...base,
        ...patch,
        host: patch.host?.trim() || base.host,
        upstreamPrefix: patch.upstreamPrefix !== undefined ? patch.upstreamPrefix : base.upstreamPrefix,
        timeoutMs: patch.timeoutMs !== undefined && Number.isFinite(patch.timeoutMs) && patch.timeoutMs > 0
            ? patch.timeoutMs
            : base.timeoutMs,
    };
}
function mergePlaygroundConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        skills: patch.skills ?? base.skills,
        mcpConnectors: patch.mcpConnectors
            ? patch.mcpConnectors.map((connector) => {
                if (!connector.headers) {
                    return connector;
                }
                const previous = base.mcpConnectors.find((item) => item.id === connector.id);
                const headers = Object.fromEntries(Object.entries(connector.headers)
                    .map(([key, value]) => {
                    if (value !== REDACTED_CONFIG_SECRET) {
                        return [key, value];
                    }
                    const restored = previous?.headers?.[key];
                    // Never persist the public redaction placeholder as a real secret.
                    return restored !== undefined ? [key, restored] : null;
                })
                    .filter((entry) => entry !== null));
                return {
                    ...connector,
                    headers: Object.keys(headers).length > 0 ? headers : undefined,
                };
            })
            : base.mcpConnectors,
        outputTemplates: patch.outputTemplates ?? base.outputTemplates,
        activeSkillIds: patch.activeSkillIds ?? base.activeSkillIds,
        activeMcpIds: patch.activeMcpIds ?? base.activeMcpIds,
        activeOutputTemplateId: patch.activeOutputTemplateId !== undefined ? patch.activeOutputTemplateId : base.activeOutputTemplateId,
    };
}
function mergeAutoRoutingConfig(base, patch) {
    if (!patch) {
        return base;
    }
    const pricingOverrides = { ...base.pricing.overrides };
    for (const [key, override] of Object.entries(patch.pricing?.overrides ?? {})) {
        pricingOverrides[key] = {
            ...(pricingOverrides[key] ?? base.pricing.default),
            ...override,
        };
    }
    return {
        ...base,
        ...patch,
        thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
        weights: { ...base.weights, ...(patch.weights ?? {}) },
        pricing: {
            default: { ...base.pricing.default, ...(patch.pricing?.default ?? {}) },
            overrides: pricingOverrides,
        },
        evaluation: mergeAutoRoutingEvaluationConfig(base.evaluation, patch.evaluation),
        taskRoutes: patch.taskRoutes ?? base.taskRoutes,
    };
}
function mergeAutoRoutingEvaluationConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        ...base,
        ...patch,
        judge: mergeAutoRoutingEvaluatorConfig(base.judge, patch.judge),
        verifier: mergeAutoRoutingEvaluatorConfig(base.verifier, patch.verifier),
    };
}
function mergeAutoRoutingEvaluatorConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        ...base,
        ...patch,
        target: {
            ...base.target,
            ...(patch.target ?? {}),
        },
    };
}
function normalizeOptions(options) {
    if (!options) {
        return {};
    }
    if ("persistPath" in options ||
        "loadFromDisk" in options ||
        "autoPersist" in options ||
        "initial" in options) {
        return options;
    }
    return { initial: options };
}
function readConfigFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
        return undefined;
    }
    return JSON.parse(raw);
}
