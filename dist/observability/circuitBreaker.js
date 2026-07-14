import CircuitBreaker from "opossum";
import { logger } from "./logger.js";
import { getEnv } from "../config/envValidation.js";
import { KgmStructuredError } from "../errors/structuredError.js";
export function createCircuitBreaker(action, options, name) {
    const env = getEnv();
    const breakerName = name || "default";
    const timeout = options?.timeout !== undefined
        ? options.timeout
        : (env.KGM_CIRCUIT_BREAKER_TIMEOUT_MS > 0 ? env.KGM_CIRCUIT_BREAKER_TIMEOUT_MS : false);
    const breakerOptions = {
        timeout,
        errorThresholdPercentage: options?.errorThresholdPercentage ??
            (Number.isFinite(env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD) &&
                env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD > 100
                ? 50
                : Math.min(100, Math.max(1, env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD || 50))),
        resetTimeout: options?.resetTimeout ?? env.KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        rollingCountTimeout: options?.rollingCountTimeout ?? 10_000,
        rollingCountBuckets: options?.rollingCountBuckets ?? 10,
        volumeThreshold: options?.volumeThreshold ?? 5,
        name: breakerName,
    };
    // 若 env threshold 设计为「连续失败次数」语义（≤20），映射为 volumeThreshold + 50% 失败率
    if (options?.errorThresholdPercentage === undefined &&
        env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD > 0 &&
        env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD <= 20) {
        breakerOptions.volumeThreshold = env.KGM_CIRCUIT_BREAKER_ERROR_THRESHOLD;
        breakerOptions.errorThresholdPercentage = 50;
    }
    const breaker = new CircuitBreaker(action, breakerOptions);
    breaker.on("open", () => {
        logger.warn({ circuit: breakerName }, "Circuit breaker opened");
    });
    breaker.on("halfOpen", () => {
        logger.info({ circuit: breakerName }, "Circuit breaker half-open");
    });
    breaker.on("close", () => {
        logger.info({ circuit: breakerName }, "Circuit breaker closed");
    });
    breaker.on("reject", (error) => {
        logger.warn({ circuit: breakerName, error: error?.message }, "Circuit breaker rejected request");
    });
    breaker.on("timeout", (error) => {
        logger.warn({ circuit: breakerName, error: error?.message }, "Circuit breaker timeout");
    });
    breaker.on("failure", (error) => {
        logger.error({ circuit: breakerName, error: error?.message }, "Circuit breaker failure");
    });
    return breaker;
}
export function createCircuitBreakerGroup() {
    const breakers = new Map();
    return {
        get(name) {
            return breakers.get(name);
        },
        set(name, breaker) {
            breakers.set(name, breaker);
        },
        getAll() {
            return breakers;
        },
        getAllStates() {
            const states = {};
            breakers.forEach((breaker, n) => {
                states[n] = breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed";
            });
            return states;
        },
        clear() {
            for (const b of breakers.values()) {
                b.shutdown();
            }
            breakers.clear();
        },
    };
}
export const circuitBreakerGroup = createCircuitBreakerGroup();
function breakerHostKey(url) {
    try {
        return `llm:${new URL(url).host}`;
    }
    catch {
        return `llm:${url}`;
    }
}
/**
 * 将 LLM 上游 fetch 纳入 opossum 熔断（按 host 分桶）。
 * 仅保护「建连 + HTTP 响应头」；流式读 body 不经 breaker timeout。
 */
export async function protectedFetch(url, init, opts) {
    if (typeof fetch !== "function") {
        throw new Error("fetch is not available in this runtime");
    }
    const name = opts?.name ?? breakerHostKey(url);
    let breaker = circuitBreakerGroup.get(name);
    if (!breaker) {
        breaker = createCircuitBreaker(async (u, i) => fetch(u, i), {
            timeout: opts?.enableBreakerTimeout ? undefined : false,
        }, name);
        circuitBreakerGroup.set(name, breaker);
    }
    try {
        return (await breaker.fire(url, init));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (lower.includes("breaker is open") ||
            (lower.includes("circuit") && lower.includes("open")) ||
            lower.includes("breakeropenerror")) {
            throw new KgmStructuredError({
                code: "CIRCUIT_BREAKER_OPEN",
                message: `LLM upstream circuit open for ${name}: ${message}`,
                type: "kgm_upstream_error",
                status: 503,
                stage: "inference.llm_provider",
                path: "llmProvider",
                routeAttempted: true,
                suggestedFix: "Upstream failures tripped the circuit breaker. Check KGM_LLM_BASE_URL health, wait for reset (KGM_CIRCUIT_BREAKER_RESET_TIMEOUT_MS), or inspect /v1/runtime/diagnostics.",
                affectedFeatures: ["chat", "completions", "responses"],
                details: { circuit: name },
            });
        }
        throw error;
    }
}
