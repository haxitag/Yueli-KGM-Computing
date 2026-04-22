import { ModelRouter } from "../models/router.js";
export class BusinessRouter {
    router;
    config;
    constructor(registry, config) {
        this.router = new ModelRouter(registry);
        this.config = config;
    }
    route(input) {
        const rule = pickRule(this.config.routes, input);
        const strategy = rule?.strategy ?? { type: "weighted", weights: this.config.baseWeights };
        if (strategy.type === "weighted" && !strategy.weights) {
            return this.router.route({ strategy: { ...strategy, weights: this.config.baseWeights } });
        }
        return this.router.route({ strategy });
    }
}
export function applyAdapterSuggestions(config, suggestions) {
    const next = { ...config, baseWeights: { ...config.baseWeights } };
    for (const s of suggestions) {
        const current = next.baseWeights[s.model] ?? 0;
        next.baseWeights[s.model] = Math.max(0, current + s.weight_delta);
    }
    next.baseWeights = normalizeWeights(next.baseWeights);
    next.updatedAt = new Date().toISOString();
    return next;
}
function normalizeWeights(weights) {
    const total = Object.values(weights).reduce((sum, v) => sum + v, 0);
    if (total <= 0) {
        return weights;
    }
    const normalized = {};
    for (const [key, value] of Object.entries(weights)) {
        normalized[key] = Number((value / total).toFixed(4));
    }
    return normalized;
}
function pickRule(rules, input) {
    const sorted = [...rules].sort((a, b) => b.priority - a.priority);
    for (const rule of sorted) {
        if (matchesRule(rule, input)) {
            return rule;
        }
    }
    return null;
}
function matchesRule(rule, input) {
    if (rule.match.purpose && rule.match.purpose !== input.purpose) {
        return false;
    }
    if (rule.match.userSegment && rule.match.userSegment !== input.userSegment) {
        return false;
    }
    if (rule.match.tags && rule.match.tags.length > 0) {
        const inputTags = new Set(input.tags ?? []);
        for (const tag of rule.match.tags) {
            if (!inputTags.has(tag)) {
                return false;
            }
        }
    }
    return true;
}
