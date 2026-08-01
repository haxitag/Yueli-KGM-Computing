import type { RoutingStrategy, RouteResult } from "../models/router.js";
import { ModelRouter } from "../models/router.js";
import type { ModelRegistry } from "../models/registry.js";

export type BusinessRouteRule = {
  name: string;
  priority: number;
  match: {
    purpose?: string;
    tags?: string[];
    userSegment?: string;
  };
  strategy: RoutingStrategy;
};

export type BusinessRoutingConfig = {
  version: string;
  updatedAt: string;
  baseWeights: Record<string, number>;
  routes: BusinessRouteRule[];
};

export type BusinessRouteInput = {
  purpose?: string;
  tags?: string[];
  userSegment?: string;
};

export type AdapterSuggestion = { model: string; weight_delta: number };

export class BusinessRouter {
  private router: ModelRouter;
  private config: BusinessRoutingConfig;

  constructor(registry: ModelRegistry, config: BusinessRoutingConfig) {
    this.router = new ModelRouter(registry);
    this.config = config;
  }

  route(input: BusinessRouteInput): RouteResult | null {
    const rule = pickRule(this.config.routes, input);
    const strategy = rule?.strategy ?? { type: "weighted", weights: this.config.baseWeights };
    if (strategy.type === "weighted" && !strategy.weights) {
      return this.router.route({ strategy: { ...strategy, weights: this.config.baseWeights } });
    }
    return this.router.route({ strategy });
  }
}

export function applyAdapterSuggestions(
  config: BusinessRoutingConfig,
  suggestions: AdapterSuggestion[],
): BusinessRoutingConfig {
  const next = { ...config, baseWeights: { ...config.baseWeights } };
  for (const s of suggestions) {
    const current = next.baseWeights[s.model] ?? 0;
    next.baseWeights[s.model] = Math.max(0, current + s.weight_delta);
  }
  next.baseWeights = normalizeWeights(next.baseWeights);
  next.updatedAt = new Date().toISOString();
  return next;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return weights;
  }
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    normalized[key] = Number((value / total).toFixed(4));
  }
  return normalized;
}

function pickRule(rules: BusinessRouteRule[], input: BusinessRouteInput): BusinessRouteRule | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (matchesRule(rule, input)) {
      return rule;
    }
  }
  return null;
}

function matchesRule(rule: BusinessRouteRule, input: BusinessRouteInput): boolean {
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
