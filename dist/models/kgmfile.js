import { generateId } from "../utils/id.js";
export function parseKgmfile(input) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("kgmfile_empty");
    }
    if (trimmed.startsWith("{")) {
        return normalizeSpec(JSON.parse(trimmed));
    }
    const root = {};
    const stack = [{ indent: -1, target: root }];
    for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.replace(/\t/g, "  ");
        if (!line.trim() || line.trimStart().startsWith("#")) {
            continue;
        }
        const indent = line.length - line.trimStart().length;
        const [rawKey, ...rest] = line.trim().split(":");
        const key = rawKey.trim();
        const rawValue = rest.join(":").trim();
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            stack.pop();
        }
        const current = stack[stack.length - 1].target;
        if (!rawValue) {
            const next = {};
            current[key] = next;
            stack.push({ indent, target: next });
            continue;
        }
        current[key] = parseScalar(rawValue);
    }
    return normalizeSpec(root);
}
export function toModelRequests(spec) {
    const runtimeKind = spec.runtime?.kind ?? inferRuntimeKind(spec);
    const modelName = spec.runtime?.modelName ?? spec.name ?? deriveNameFromSpec(spec);
    return {
        pull: {
            name: spec.name,
            modelName,
            sourceType: spec.source?.type,
            sourceUrl: spec.source?.url,
            sourceRef: spec.source?.ref,
            filePath: spec.source?.filePath,
            revision: spec.source?.revision,
        },
        runtime: {
            name: spec.name,
            modelName,
            runtime: runtimeKind,
            host: spec.runtime?.host,
            port: spec.runtime?.port,
            apiPath: spec.runtime?.apiPath,
            mode: spec.runtime?.mode,
            maxConcurrentRequests: spec.runtime?.maxConcurrentRequests,
            maxQueueSize: spec.runtime?.maxQueueSize,
            retryMaxRetries: spec.runtime?.retryMaxRetries,
            circuitBreakerFailures: spec.runtime?.circuitBreakerFailures,
            circuitBreakerCooldownMs: spec.runtime?.circuitBreakerCooldownMs,
            healthPath: spec.runtime?.healthPath,
        },
    };
}
function normalizeSpec(spec) {
    return {
        id: spec.id ?? generateId("kgmfile"),
        name: spec.name ?? deriveNameFromSpec(spec),
        description: spec.description,
        source: {
            type: spec.source?.type,
            url: spec.source?.url,
            ref: spec.source?.ref,
            filePath: spec.source?.filePath,
            revision: spec.source?.revision,
        },
        runtime: {
            kind: spec.runtime?.kind,
            modelName: spec.runtime?.modelName,
            port: spec.runtime?.port,
            host: spec.runtime?.host,
            apiPath: spec.runtime?.apiPath,
            mode: spec.runtime?.mode,
            maxConcurrentRequests: spec.runtime?.maxConcurrentRequests,
            maxQueueSize: spec.runtime?.maxQueueSize,
            retryMaxRetries: spec.runtime?.retryMaxRetries,
            circuitBreakerFailures: spec.runtime?.circuitBreakerFailures,
            circuitBreakerCooldownMs: spec.runtime?.circuitBreakerCooldownMs,
            healthPath: spec.runtime?.healthPath,
        },
        prompt: spec.prompt,
        metadata: spec.metadata ?? {},
    };
}
function deriveNameFromSpec(spec) {
    const source = spec.source?.ref ?? spec.source?.url ?? "managed-model";
    return source.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "") ?? "managed-model";
}
function inferRuntimeKind(spec) {
    const candidate = `${spec.source?.filePath ?? ""} ${spec.source?.url ?? ""}`.toLowerCase();
    if (candidate.includes(".gguf")) {
        return "llama.cpp";
    }
    if (spec.source?.type === "ollama") {
        return "ollama";
    }
    return "vllm";
}
function parseScalar(value) {
    const trimmed = value.trim();
    if (trimmed === "true")
        return true;
    if (trimmed === "false")
        return false;
    if (trimmed === "null")
        return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed))
        return Number(trimmed);
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
