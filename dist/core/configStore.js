import { CANONICAL_EMBEDDING } from "./config.js";
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
        path: "/completions",
        mode: "completions",
        temperature: 0.2,
        maxTokens: 512,
        timeoutMs: 30000,
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
        baseUrl: "http://localhost:8787",
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
                "managed:*": {
                    inputPer1kTokens: 0,
                    outputPer1kTokens: 0,
                    currency: "USD",
                },
            },
        },
        evaluation: {
            enabled: true,
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
}
function mergeConfig(base, patch) {
    return {
        embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
        llm: { ...base.llm, ...(patch.llm ?? {}) },
        database: { ...base.database, ...(patch.database ?? {}) },
        vector: { ...base.vector, ...(patch.vector ?? {}) },
        context: { ...base.context, ...(patch.context ?? {}) },
        adapter: { ...base.adapter, ...(patch.adapter ?? {}) },
        ycb: { ...base.ycb, ...(patch.ycb ?? {}) },
        routing: { ...base.routing, ...(patch.routing ?? {}) },
        autoRouting: mergeAutoRoutingConfig(base.autoRouting, patch.autoRouting),
        playground: mergePlaygroundConfig(base.playground, patch.playground),
    };
}
function mergePlaygroundConfig(base, patch) {
    if (!patch) {
        return base;
    }
    return {
        skills: patch.skills ?? base.skills,
        mcpConnectors: patch.mcpConnectors ?? base.mcpConnectors,
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
    if ("persistPath" in options || "loadFromDisk" in options || "autoPersist" in options) {
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
