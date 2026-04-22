import path from "node:path";

import type {
  AutoRoutingConfig,
  AutoRoutingEvaluationTargetConfig,
  AutoRoutingEvaluatorConfig,
  ConfigStore,
  ModelPricingConfig,
} from "../core/configStore.js";
import type { RoutingHints, RoutingProfile } from "../core/types.js";
import type { ManagedModelSummary, ManagedModelManager, ManagedRuntimeMetrics } from "../models/modelManager.js";
import { ProviderConfigurationManager } from "../models/providerConfigManager.js";
import { parseIntent } from "../parse/parser.js";
import {
  AutoRoutingAuditStore,
  type AutoRoutingCandidateSnapshot,
  type AutoRoutingEvaluationRecord,
  type AutoRoutingEvaluationSource,
  type AutoRoutingEvaluationStageRecord,
  type AutoRoutingVerificationSource,
} from "../routing/autoRoutingAuditStore.js";
import { LlmProviderFactory, type ProviderConfig } from "./providerFactory.js";
import { streamCompletion } from "./client.js";
import type { CompletionOptions, CompletionResult, CompletionStreamEvent, LlmClient } from "./client.js";

type RoutingCandidate = {
  routeKey: string;
  label: string;
  source: "managed" | "provider" | "default";
  model: string;
  provider?: string;
  runtimeId?: string;
  runtimeMetrics?: ManagedRuntimeMetrics;
  providerConfig?: ProviderConfig;
  estimatedCost: number;
  latencyMs: number;
  successRate: number;
  quality: number;
  trust: number;
  verification: number;
  score: number;
};

type RoutingSelection = {
  profile: RoutingProfile;
  taskType: string;
  taskName?: string;
  complexity: number;
  verifiable: boolean;
  candidates: RoutingCandidate[];
  selected: RoutingCandidate;
  matchedRuleId?: string;
};

type EvaluationExecutionTarget = {
  routeKey: string;
  label: string;
  source: RoutingCandidate["source"];
  model: string;
  provider?: string;
  runtimeId?: string;
  providerConfig?: ProviderConfig;
};

type EvaluationExecutionResult = {
  target: EvaluationExecutionTarget;
  text: string;
  raw: unknown;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
};

type EvaluationOutcome = {
  qualityScore: number;
  confidence: number;
  verificationPassed: boolean;
  verificationAttempted: boolean;
  evaluation: AutoRoutingEvaluationRecord;
};

export type AutoRoutingTrace = {
  enabled: boolean;
  profile: RoutingProfile;
  taskType: string;
  taskName?: string;
  complexity: number;
  verifiable: boolean;
  matchedRuleId?: string;
  selected: AutoRoutingCandidateSnapshot;
  candidates: AutoRoutingCandidateSnapshot[];
  evaluation?: AutoRoutingEvaluationRecord & {
    qualityScore: number;
    confidence: number;
    verificationPassed: boolean;
  };
};

export class AutoRoutingLlmClient implements LlmClient {
  private fallback: LlmClient;
  private manager: ManagedModelManager;
  private configStore: ConfigStore;
  private providerConfigPath: string;
  private auditStore: AutoRoutingAuditStore;
  private providerManager?: ProviderConfigurationManager;
  private providerLoadPromise?: Promise<void>;

  constructor(params: {
    fallback: LlmClient;
    manager: ManagedModelManager;
    configStore: ConfigStore;
    providerConfigPath?: string;
    auditStore?: AutoRoutingAuditStore;
  }) {
    this.fallback = params.fallback;
    this.manager = params.manager;
    this.configStore = params.configStore;
    this.providerConfigPath =
      params.providerConfigPath ?? process.env.KGM_PROVIDER_CONFIG_PATH ?? "config/model-providers.json";
    this.auditStore = params.auditStore ?? new AutoRoutingAuditStore();
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const selection = await this.selectCandidate(prompt, options);
    const startedAt = Date.now();
    try {
      const result = await this.executeCandidate(selection.selected, prompt, options);
      return await this.wrapResult(result, selection, prompt, options, Date.now() - startedAt);
    } catch (error) {
      const fallbackCandidate = selection.candidates.find((item) => item.source === "default");
      if (!fallbackCandidate || fallbackCandidate.routeKey === selection.selected.routeKey) {
        this.recordAudit(selection, prompt, options, Date.now() - startedAt, {
          success: false,
          error: String(error),
          promptTokens: estimateTokens(prompt),
          completionTokens: 0,
          totalTokens: estimateTokens(prompt),
          actualCost: selection.selected.estimatedCost,
          evaluationPromptTokens: 0,
          evaluationCompletionTokens: 0,
          evaluationTotalTokens: 0,
          evaluationCost: 0,
          qualityScore: 0,
          confidence: 0,
          verificationAttempted: false,
          verificationPassed: false,
          evaluation: createHeuristicEvaluationRecord(selection.verifiable ? "heuristic" : "not_applicable"),
        });
        throw error;
      }

      const result = await this.executeCandidate(fallbackCandidate, prompt, options);
      const effective = {
        ...selection,
        selected: fallbackCandidate,
      };
      return await this.wrapResult(
        {
          text: result.text,
          raw: {
            fallbackFrom: selection.selected.routeKey,
            error: String(error),
            result: result.raw,
          },
        },
        effective,
        prompt,
        options,
        Date.now() - startedAt,
      );
    }
  }

  async *streamComplete(prompt: string, options?: CompletionOptions): AsyncIterable<CompletionStreamEvent> {
    const selection = await this.selectCandidate(prompt, options);
    yield {
      type: "started",
      model: selection.selected.model,
    };

    const startedAt = Date.now();
    let output = "";
    let finalResult: CompletionResult | undefined;

    try {
      for await (const event of this.executeCandidateStream(selection.selected, prompt, options)) {
        if (event.type === "token") {
          output += event.text;
        }
        if (event.type === "finished") {
          finalResult = await this.wrapResult(event.result, selection, prompt, options, Date.now() - startedAt);
          yield {
            type: "finished",
            result: finalResult,
          };
          return;
        }
        if (event.type !== "started") {
          yield event;
        }
      }

      const synthetic = await this.wrapResult(
        finalResult ?? { text: output, raw: {} },
        selection,
        prompt,
        options,
        Date.now() - startedAt,
      );
      yield {
        type: "finished",
        result: synthetic,
      };
    } catch (error) {
      this.recordAudit(selection, prompt, options, Date.now() - startedAt, {
        success: false,
        error: String(error),
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(output),
        totalTokens: estimateTokens(prompt) + estimateTokens(output),
        actualCost: selection.selected.estimatedCost,
        evaluationPromptTokens: 0,
        evaluationCompletionTokens: 0,
        evaluationTotalTokens: 0,
        evaluationCost: 0,
        qualityScore: 0,
        confidence: 0,
        verificationAttempted: false,
        verificationPassed: false,
        evaluation: createHeuristicEvaluationRecord(selection.verifiable ? "heuristic" : "not_applicable"),
      });
      throw error;
    }
  }

  getAuditSummary(limit?: number) {
    return this.auditStore.summarize(limit);
  }

  listAuditEntries(limit?: number) {
    return this.auditStore.list(limit);
  }

  private async selectCandidate(prompt: string, options?: CompletionOptions): Promise<RoutingSelection> {
    const config = this.configStore.get().autoRouting;
    const hints = normalizeHints(options?.routing, options?.metadata);
    const profile = normalizeProfile(hints.profile ?? config.defaultProfile);
    const taskInput = options?.taskInput ?? prompt;
    const taskType = options?.taskType ?? hints.taskType ?? detectTaskType(taskInput, config.defaultTaskType);
    const taskName = options?.taskName ?? hints.taskName;
    const verifiable = hints.verificationExpected ?? isVerifiableTask(taskInput, taskType, prompt);
    const complexity = estimateComplexity(taskInput);
    const candidates = await this.buildCandidates(prompt, options, {
      profile,
      taskInput,
      taskType,
      verifiable,
      complexity,
    });

    const explicitTarget = options?.model
      ? { model: options.model }
      : hints.target?.model || hints.target?.provider || hints.target?.runtimeId
        ? hints.target
        : undefined;
    if (explicitTarget) {
      const matched = this.selectByTarget(candidates, explicitTarget, profile);
      if (matched) {
        return {
          profile,
          taskType,
          taskName,
          complexity,
          verifiable,
          candidates,
          selected: matched,
        };
      }
      const directTarget = this.createDirectTargetCandidate(candidates, explicitTarget);
      if (directTarget) {
        return {
          profile,
          taskType,
          taskName,
          complexity,
          verifiable,
          candidates: [directTarget, ...candidates],
          selected: directTarget,
        };
      }
    }

    const matchedRule = this.findMatchedRule(config, {
      taskInput,
      taskType,
      taskName,
    });
    if (matchedRule) {
      const matched = this.selectByTarget(candidates, matchedRule.target, profile);
      if (matched) {
        return {
          profile,
          taskType,
          taskName,
          complexity,
          verifiable,
          candidates,
          selected: matched,
          matchedRuleId: matchedRule.id,
        };
      }
    }

    const selected = config.enabled && config.allowDynamicSelection
      ? [...candidates].sort((a, b) => b.score - a.score)[0] ?? candidates[0]
      : candidates.find((item) => item.source === "default") ?? candidates[0];

    if (!selected) {
      throw new Error("auto_routing_no_candidate_available");
    }

    return {
      profile,
      taskType,
      taskName,
      complexity,
      verifiable,
      candidates,
      selected,
      matchedRuleId: matchedRule?.id,
    };
  }

  private async buildCandidates(
    prompt: string,
    options: CompletionOptions | undefined,
    route: {
      profile: RoutingProfile;
      taskInput: string;
      taskType: string;
      verifiable: boolean;
      complexity: number;
    },
  ): Promise<RoutingCandidate[]> {
    const config = this.configStore.get();
    const autoRouting = config.autoRouting;
    const promptTokens = estimateTokens(prompt);
    const expectedOutputTokens = Math.max(64, Math.min(options?.maxTokens ?? config.llm.maxTokens, 512));
    const maxCost = options?.routing?.maxCostPerRequest ?? autoRouting.thresholds.maxCostPerRequest;
    const candidates: RoutingCandidate[] = [];
    const defaultCandidate = this.scoreCandidate(
      {
        routeKey: `default:${config.llm.provider}:${config.llm.model}`,
        label: `${config.llm.provider}:${config.llm.model}`,
        source: "default",
        model: config.llm.model,
        provider: config.llm.provider,
        estimatedCost: 0,
        latencyMs: autoRouting.thresholds.targetLatencyMs,
        successRate: 0.7,
        quality: defaultQualityForTask(route.taskType),
        trust: 0.65,
        verification: route.verifiable ? 0.72 : 0.55,
      },
      route.profile,
      autoRouting,
      maxCost,
      this.resolveEstimatedCost({
        routeKey: `default:${config.llm.provider}:${config.llm.model}`,
        source: "default",
        model: config.llm.model,
        provider: config.llm.provider,
      }, promptTokens, expectedOutputTokens),
    );

    candidates.push(defaultCandidate);

    for (const runtime of this.manager.listRunningModels()) {
      const metrics = runtime.runtimeId ? this.manager.getRuntimeMetrics(runtime.runtimeId) : runtime.metrics;
      const stats = this.auditStore.getCandidateStats(`managed:${runtime.modelName}`, route.taskType);
      candidates.push(
        this.scoreCandidate(
          {
            routeKey: `managed:${runtime.modelName}`,
            label: runtime.runtime ? `${runtime.runtime}:${runtime.modelName}` : runtime.modelName,
            source: "managed",
            model: runtime.modelName,
            runtimeId: runtime.runtimeId,
            provider: runtime.runtime,
            runtimeMetrics: metrics,
            estimatedCost: 0,
            latencyMs: stats?.avgLatencyMs ?? metrics?.avgLatencyMs ?? autoRouting.thresholds.targetLatencyMs * 0.85,
            successRate: stats?.successRate ?? deriveRuntimeSuccess(metrics) ?? 0.8,
            quality: stats?.avgQuality ?? defaultQualityForTask(route.taskType, 0.08),
            trust: stats?.avgConfidence ?? 0.78,
            verification: route.verifiable ? stats?.verificationPassRate ?? 0.82 : 0.6,
          },
          route.profile,
          autoRouting,
          maxCost,
          0,
        ),
      );
    }

    if (this.isProviderRoutingEnabled()) {
      await this.ensureProviderManager();
      const providers = this.providerManager?.getActiveProviderConfigs() ?? [];
      for (const provider of providers) {
        const routeKey = `provider:${provider.type}:${provider.model}`;
        const stats = this.auditStore.getCandidateStats(routeKey, route.taskType);
        const estimatedCost = this.resolveEstimatedCost(
          {
            routeKey,
            source: "provider",
            model: provider.model,
            provider: provider.type,
          },
          promptTokens,
          expectedOutputTokens,
        );
        candidates.push(
          this.scoreCandidate(
            {
              routeKey,
              label: `${provider.type}:${provider.model}`,
              source: "provider",
              model: provider.model,
              provider: provider.type,
              providerConfig: provider,
              estimatedCost,
              latencyMs: stats?.avgLatencyMs ?? autoRouting.thresholds.targetLatencyMs,
              successRate: stats?.successRate ?? 0.68,
              quality: stats?.avgQuality ?? defaultQualityForTask(route.taskType, 0.02),
              trust: stats?.avgConfidence ?? 0.62,
              verification: route.verifiable ? stats?.verificationPassRate ?? 0.7 : 0.54,
            },
            route.profile,
            autoRouting,
            maxCost,
            estimatedCost,
          ),
        );
      }
    }

    const deduped = new Map<string, RoutingCandidate>();
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
      const current = deduped.get(candidate.routeKey);
      if (!current || candidate.score > current.score) {
        deduped.set(candidate.routeKey, candidate);
      }
    }
    const collapsed = Array.from(deduped.values()).sort((a, b) => b.score - a.score);
    const limited = collapsed.slice(0, autoRouting.thresholds.maxCandidateCount);
    if (!limited.some((item) => item.routeKey === defaultCandidate.routeKey)) {
      limited.push(defaultCandidate);
    }
    return limited.sort((a, b) => b.score - a.score);
  }

  private scoreCandidate(
    candidate: Omit<RoutingCandidate, "score" | "estimatedCost"> & { estimatedCost: number },
    profile: RoutingProfile,
    config: AutoRoutingConfig,
    maxCost: number,
    estimatedCost: number,
  ): RoutingCandidate {
    const bias = profile === "cost_first"
      ? { cost: 0.12, latency: 0.1, quality: -0.05, trust: -0.04 }
      : profile === "quality_first"
        ? { cost: -0.06, latency: -0.03, quality: 0.09, trust: 0.05 }
        : { cost: 0, latency: 0, quality: 0, trust: 0 };
    const latencyScore = 1 - normalizeScore(candidate.latencyMs, config.thresholds.targetLatencyMs * 2);
    const costScore = 1 - normalizeScore(estimatedCost, Math.max(maxCost, 0.0001));
    const score =
      (config.weights.successRate * candidate.successRate) +
      ((config.weights.quality + bias.quality) * candidate.quality) +
      ((config.weights.trust + bias.trust) * candidate.trust) +
      (config.weights.verification * candidate.verification) +
      ((config.weights.latency + bias.latency) * latencyScore) +
      ((config.weights.cost + bias.cost) * costScore);
    return {
      ...candidate,
      estimatedCost,
      score,
    };
  }

  private selectByTarget(
    candidates: RoutingCandidate[],
    target: { model?: string; provider?: string; runtimeId?: string },
    profile: RoutingProfile,
  ): RoutingCandidate | undefined {
    const exact = candidates.find((candidate) => {
      if (target.runtimeId && candidate.runtimeId !== target.runtimeId) {
        return false;
      }
      if (target.provider && candidate.provider !== target.provider) {
        return false;
      }
      if (target.model && candidate.model !== target.model) {
        return false;
      }
      return true;
    });
    if (exact) {
      return exact;
    }
    const filtered = candidates.filter((candidate) => {
      if (target.runtimeId) {
        return candidate.runtimeId === target.runtimeId;
      }
      if (target.provider && target.model) {
        return candidate.provider === target.provider && candidate.model === target.model;
      }
      if (target.provider) {
        return candidate.provider === target.provider;
      }
      if (target.model) {
        return candidate.model === target.model;
      }
      return false;
    });
    if (filtered.length === 0) {
      return undefined;
    }
    return [...filtered].sort((a, b) => {
      if (profile === "cost_first") {
        return a.estimatedCost - b.estimatedCost;
      }
      return b.score - a.score;
    })[0];
  }

  private createDirectTargetCandidate(
    candidates: RoutingCandidate[],
    target: { model?: string; provider?: string; runtimeId?: string },
  ): RoutingCandidate | undefined {
    if (!target.model && !target.provider) {
      return undefined;
    }
    const config = this.configStore.get().llm;
    const fallback = candidates.find((item) => item.source === "default");
    return {
      ...(fallback ?? {
        routeKey: `default:${config.provider}:${config.model}`,
        label: `${config.provider}:${config.model}`,
        source: "default" as const,
        model: config.model,
        provider: config.provider,
        estimatedCost: 0,
        latencyMs: this.configStore.get().autoRouting.thresholds.targetLatencyMs,
        successRate: 0.7,
        quality: 0.68,
        trust: 0.65,
        verification: 0.55,
        score: 0.5,
      }),
      source: "default",
      routeKey: `default:${target.provider ?? fallback?.provider ?? config.provider}:${target.model ?? fallback?.model ?? config.model}`,
      label: `${target.provider ?? fallback?.provider ?? config.provider}:${target.model ?? fallback?.model ?? config.model}`,
      provider: target.provider ?? fallback?.provider ?? config.provider,
      model: target.model ?? fallback?.model ?? config.model,
      runtimeId: undefined,
    };
  }

  private findMatchedRule(
    config: AutoRoutingConfig,
    route: { taskInput: string; taskType: string; taskName?: string },
  ) {
    const input = route.taskInput.toLowerCase();
    return [...config.taskRoutes]
      .filter((rule) => rule.enabled)
      .sort((a, b) => b.priority - a.priority)
      .find((rule) => {
        if (rule.taskType && rule.taskType !== route.taskType) {
          return false;
        }
        if (rule.taskName && rule.taskName !== route.taskName) {
          return false;
        }
        if (!rule.keywords?.length) {
          return true;
        }
        return rule.keywords.some((keyword) => input.includes(keyword.toLowerCase()));
      });
  }

  private async executeCandidate(
    candidate: RoutingCandidate,
    prompt: string,
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    if (candidate.source === "managed") {
      const managed = await this.manager.completeWithManagedRuntime(candidate.model, prompt, {
        ...options,
        model: candidate.model,
      });
      if (!managed) {
        throw new Error(`managed_runtime_unavailable:${candidate.model}`);
      }
      return managed;
    }
    if (candidate.source === "provider" && candidate.providerConfig) {
      const client = LlmProviderFactory.createClient(candidate.providerConfig);
      return client.complete(prompt, {
        ...options,
        model: candidate.model,
      });
    }
    return this.fallback.complete(prompt, {
      ...options,
      model: candidate.model,
    });
  }

  private executeCandidateStream(
    candidate: RoutingCandidate,
    prompt: string,
    options?: CompletionOptions,
  ): AsyncIterable<CompletionStreamEvent> {
    if (candidate.source === "managed") {
      const managed = this.manager.streamWithManagedRuntime(candidate.model, prompt, {
        ...options,
        model: candidate.model,
      });
      if (!managed) {
        throw new Error(`managed_runtime_unavailable:${candidate.model}`);
      }
      return managed;
    }
    if (candidate.source === "provider" && candidate.providerConfig) {
      const client = LlmProviderFactory.createClient(candidate.providerConfig);
      return streamCompletion(client, prompt, {
        ...options,
        model: candidate.model,
      });
    }
    return streamCompletion(this.fallback, prompt, {
      ...options,
      model: candidate.model,
    });
  }

  private async wrapResult(
    result: CompletionResult,
    selection: RoutingSelection,
    prompt: string,
    options: CompletionOptions | undefined,
    elapsedMs: number,
  ): Promise<CompletionResult> {
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(result.text);
    const actualCost = this.resolveEstimatedCost(selection.selected, promptTokens, completionTokens);
    const evaluation = await this.evaluateResult(selection, prompt, result.text, options);

    const trace: AutoRoutingTrace = {
      enabled: true,
      profile: selection.profile,
      taskType: selection.taskType,
      taskName: selection.taskName,
      complexity: selection.complexity,
      verifiable: selection.verifiable,
      matchedRuleId: selection.matchedRuleId,
      selected: toSnapshot(selection.selected),
      candidates: selection.candidates.map(toSnapshot),
      evaluation: {
        ...evaluation.evaluation,
        qualityScore: evaluation.qualityScore,
        confidence: evaluation.confidence,
        verificationPassed: evaluation.verificationPassed,
      },
    };

    this.recordAudit(selection, prompt, options, elapsedMs, {
      success: true,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      actualCost,
      evaluationPromptTokens: sumEvaluationTokens(evaluation.evaluation, "promptTokens"),
      evaluationCompletionTokens: sumEvaluationTokens(evaluation.evaluation, "completionTokens"),
      evaluationTotalTokens: sumEvaluationTokens(evaluation.evaluation, "totalTokens"),
      evaluationCost: sumEvaluationCosts(evaluation.evaluation),
      qualityScore: evaluation.qualityScore,
      confidence: evaluation.confidence,
      verificationAttempted: evaluation.verificationAttempted,
      verificationPassed: evaluation.verificationPassed,
      evaluation: evaluation.evaluation,
    });

    return {
      text: result.text,
      raw: {
        autoRouting: trace,
        result: result.raw,
      },
    };
  }

  private async evaluateResult(
    selection: RoutingSelection,
    prompt: string,
    output: string,
    options?: CompletionOptions,
  ): Promise<EvaluationOutcome> {
    const evaluationConfig = this.configStore.get().autoRouting.evaluation;
    const taskInput = options?.taskInput ?? prompt;
    const heuristicVerification = verifyResult(selection.taskType, output, selection.verifiable);
    const heuristicQuality = deriveQualityScore(output, heuristicVerification);
    const heuristicConfidence = clamp(
      (selection.selected.trust * 0.5) + (heuristicQuality * 0.3) + (heuristicVerification ? 0.2 : 0),
    );
    const heuristicEvaluation = createHeuristicEvaluationRecord(
      selection.verifiable ? "heuristic" : "not_applicable",
    );

    if (!evaluationConfig.enabled) {
      return {
        qualityScore: heuristicQuality,
        confidence: heuristicConfidence,
        verificationPassed: heuristicVerification,
        verificationAttempted: false,
        evaluation: heuristicEvaluation,
      };
    }

    const judge = evaluationConfig.judge.enabled
      ? await this.runJudgeEvaluation(selection, taskInput, output, options)
      : {
          enabled: false,
          attempted: false,
          latencyMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cost: 0,
        } satisfies AutoRoutingEvaluationStageRecord;

    const verifier = selection.verifiable && evaluationConfig.verifier.enabled
      ? await this.runVerifierEvaluation(selection, taskInput, output, options)
      : {
          enabled: evaluationConfig.verifier.enabled,
          attempted: false,
          latencyMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cost: 0,
        } satisfies AutoRoutingEvaluationStageRecord;

    const onlineQuality = combineOnlineQuality(judge, verifier);
    const onlineConfidence = combineOnlineConfidence(judge, verifier);
    const qualitySource = resolveOnlineQualitySource(judge, verifier);
    const confidenceSource = resolveOnlineConfidenceSource(judge, verifier);
    const verificationSource = verifier.attempted ? "verifier" : selection.verifiable ? "heuristic" : "not_applicable";
    const mode = judge.attempted || verifier.attempted ? "online" : "heuristic";

    return {
      qualityScore:
        typeof onlineQuality === "number"
          ? onlineQuality
          : evaluationConfig.fallbackToHeuristics ? heuristicQuality : clamp(selection.selected.trust),
      confidence:
        typeof onlineConfidence === "number"
          ? onlineConfidence
          : evaluationConfig.fallbackToHeuristics ? heuristicConfidence : clamp(selection.selected.trust),
      verificationPassed:
        typeof verifier.passed === "boolean"
          ? verifier.passed
          : evaluationConfig.fallbackToHeuristics ? heuristicVerification : !selection.verifiable,
      verificationAttempted: verifier.attempted,
      evaluation: {
        mode,
        qualitySource:
          typeof onlineQuality === "number" ? qualitySource : evaluationConfig.fallbackToHeuristics ? "heuristic" : qualitySource,
        confidenceSource:
          typeof onlineConfidence === "number"
            ? confidenceSource
            : evaluationConfig.fallbackToHeuristics ? "heuristic" : confidenceSource,
        verificationSource:
          typeof verifier.passed === "boolean" ? verificationSource : evaluationConfig.fallbackToHeuristics ? heuristicEvaluation.verificationSource : verificationSource,
        judge,
        verifier,
      },
    };
  }

  private async runJudgeEvaluation(
    selection: RoutingSelection,
    taskInput: string,
    output: string,
    options?: CompletionOptions,
  ): Promise<AutoRoutingEvaluationStageRecord> {
    const config = this.configStore.get().autoRouting.evaluation.judge;
    try {
      const execution = await this.executeEvaluationPrompt(
        config,
        selection,
        buildJudgePrompt(selection.taskType, selection.taskName, taskInput, output),
        options,
      );
      const parsed = parseEvaluationPayload(execution.text);
      const score = clamp(readNumberField(parsed, "score", 0.5));
      const confidence = clamp(readNumberField(parsed, "confidence", score));
      return {
        ...toEvaluationStageRecord(execution, true),
        score,
        confidence,
        rationale: readStringField(parsed, "rationale") ?? readStringField(parsed, "verdict"),
        issues: readStringArrayField(parsed, "issues"),
      };
    } catch (error) {
      return failedEvaluationStageRecord(config, error);
    }
  }

  private async runVerifierEvaluation(
    selection: RoutingSelection,
    taskInput: string,
    output: string,
    options?: CompletionOptions,
  ): Promise<AutoRoutingEvaluationStageRecord> {
    const config = this.configStore.get().autoRouting.evaluation.verifier;
    try {
      const execution = await this.executeEvaluationPrompt(
        config,
        selection,
        buildVerifierPrompt(selection.taskType, selection.taskName, taskInput, output),
        options,
      );
      const parsed = parseEvaluationPayload(execution.text);
      const passed = readBooleanField(parsed, "passed", false);
      const score = clamp(readNumberField(parsed, "score", passed ? 0.9 : 0.2));
      const confidence = clamp(readNumberField(parsed, "confidence", passed ? 0.85 : 0.35));
      return {
        ...toEvaluationStageRecord(execution, true),
        passed,
        score,
        confidence,
        rationale: readStringField(parsed, "rationale") ?? readStringField(parsed, "verdict"),
        issues: readStringArrayField(parsed, "issues"),
      };
    } catch (error) {
      return failedEvaluationStageRecord(config, error);
    }
  }

  private async executeEvaluationPrompt(
    config: AutoRoutingEvaluatorConfig,
    selection: RoutingSelection,
    prompt: string,
    options?: CompletionOptions,
  ): Promise<EvaluationExecutionResult> {
    const targets = await this.resolveEvaluationTargets(config.target, selection);
    let lastError: unknown = new Error("evaluation_target_unavailable");
    for (const target of targets) {
      try {
        const startedAt = Date.now();
        const result = await this.executeEvaluationTarget(target, prompt, config, options);
        const usage = extractUsageMetrics(result.raw);
        const promptTokens = usage.promptTokens ?? estimateTokens(prompt);
        const completionTokens = usage.completionTokens ?? estimateTokens(result.text);
        const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
        return {
          target,
          text: result.text,
          raw: result.raw,
          latencyMs: Math.max(0, Date.now() - startedAt),
          promptTokens,
          completionTokens,
          totalTokens,
          cost: this.resolveEstimatedCost(target, promptTokens, completionTokens),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async resolveEvaluationTargets(
    target: AutoRoutingEvaluationTargetConfig,
    selection: RoutingSelection,
  ): Promise<EvaluationExecutionTarget[]> {
    const resolved: EvaluationExecutionTarget[] = [];
    const seen = new Set<string>();
    const push = (candidate?: EvaluationExecutionTarget) => {
      if (!candidate) {
        return;
      }
      const key = [candidate.routeKey, candidate.provider ?? "", candidate.model, candidate.runtimeId ?? ""].join(":");
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      resolved.push(candidate);
    };

    if (target.runtimeId || target.provider || target.model) {
      push(await this.resolveEvaluationTarget(target, selection));
    }

    const defaultCandidate = selection.candidates.find((item) => item.source === "default");
    push(defaultCandidate ? toEvaluationTarget(defaultCandidate) : undefined);
    push(toEvaluationTarget(selection.selected));
    return resolved;
  }

  private async resolveEvaluationTarget(
    target: AutoRoutingEvaluationTargetConfig,
    selection: RoutingSelection,
  ): Promise<EvaluationExecutionTarget | undefined> {
    const matchedCandidate = this.selectByTarget(selection.candidates, target, "quality_first");
    if (matchedCandidate) {
      return toEvaluationTarget(matchedCandidate);
    }

    if (target.runtimeId) {
      const runtime = this.manager.listRunningModels().find((item) => item.runtimeId === target.runtimeId);
      if (runtime) {
        return {
          routeKey: `managed:${runtime.modelName}`,
          label: runtime.runtime ? `${runtime.runtime}:${runtime.modelName}` : runtime.modelName,
          source: "managed",
          model: runtime.modelName,
          provider: runtime.runtime,
          runtimeId: runtime.runtimeId,
        };
      }
    }

    if (target.provider) {
      await this.ensureProviderManager();
      const providerConfig = this.providerManager?.getAllProviderConfigs()
        .find((item) => item.type === target.provider && (!target.model || item.model === target.model));
      if (providerConfig) {
        return {
          routeKey: `provider:${providerConfig.type}:${providerConfig.model}`,
          label: `${providerConfig.type}:${providerConfig.model}`,
          source: "provider",
          model: providerConfig.model,
          provider: providerConfig.type,
          providerConfig,
        };
      }
    }

    if (target.model || target.provider) {
      const llm = this.configStore.get().llm;
      return {
        routeKey: `default:${target.provider ?? llm.provider}:${target.model ?? llm.model}`,
        label: `${target.provider ?? llm.provider}:${target.model ?? llm.model}`,
        source: "default",
        model: target.model ?? llm.model,
        provider: target.provider ?? llm.provider,
      };
    }

    return undefined;
  }

  private async executeEvaluationTarget(
    target: EvaluationExecutionTarget,
    prompt: string,
    config: AutoRoutingEvaluatorConfig,
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    if (target.source === "managed") {
      const managed = await this.manager.completeWithManagedRuntime(target.model, prompt, {
        model: target.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        metadata: {
          ...(options?.metadata ?? {}),
          auto_routing_evaluation: true,
        },
      });
      if (!managed) {
        throw new Error(`managed_runtime_unavailable:${target.model}`);
      }
      return managed;
    }
    if (target.source === "provider" && target.providerConfig) {
      const client = LlmProviderFactory.createClient(target.providerConfig);
      return client.complete(prompt, {
        model: target.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        metadata: {
          ...(options?.metadata ?? {}),
          auto_routing_evaluation: true,
        },
      });
    }
    return this.fallback.complete(prompt, {
      model: target.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      metadata: {
        ...(options?.metadata ?? {}),
        auto_routing_evaluation: true,
      },
    });
  }

  private recordAudit(
    selection: RoutingSelection,
    prompt: string,
    options: CompletionOptions | undefined,
    elapsedMs: number,
    outcome: {
      success: boolean;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      actualCost: number;
      evaluationPromptTokens: number;
      evaluationCompletionTokens: number;
      evaluationTotalTokens: number;
      evaluationCost: number;
      qualityScore: number;
      confidence: number;
      verificationAttempted: boolean;
      verificationPassed: boolean;
      evaluation: AutoRoutingEvaluationRecord;
      error?: string;
    },
  ) {
    if (!this.configStore.get().autoRouting.auditEnabled) {
      return;
    }
    this.auditStore.record({
      requestId: options?.requestId,
      sessionId: options?.sessionId,
      profile: selection.profile,
      taskType: selection.taskType,
      taskName: selection.taskName,
      inputPreview: truncate(options?.taskInput ?? prompt, 280),
      complexity: selection.complexity,
      verifiable: selection.verifiable,
      selected: toSnapshot(selection.selected),
      candidates: selection.candidates.map(toSnapshot),
      success: outcome.success,
      latencyMs: Math.max(0, elapsedMs),
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      totalTokens: outcome.totalTokens,
      evaluationPromptTokens: outcome.evaluationPromptTokens,
      evaluationCompletionTokens: outcome.evaluationCompletionTokens,
      evaluationTotalTokens: outcome.evaluationTotalTokens,
      totalTokensWithEvaluation: outcome.totalTokens + outcome.evaluationTotalTokens,
      estimatedCost: selection.selected.estimatedCost,
      actualCost: outcome.actualCost,
      evaluationCost: outcome.evaluationCost,
      totalCost: outcome.actualCost + outcome.evaluationCost,
      verificationAttempted: outcome.verificationAttempted,
      verificationPassed: outcome.verificationPassed,
      qualityScore: outcome.qualityScore,
      confidence: outcome.confidence,
      evaluation: outcome.evaluation,
      error: outcome.error,
    });
  }

  private resolveEstimatedCost(
    candidate: { routeKey: string; source: "managed" | "provider" | "default"; model: string; provider?: string },
    promptTokens: number,
    completionTokens: number,
  ): number {
    const pricing = this.resolvePricing(candidate);
    return (promptTokens / 1000) * pricing.inputPer1kTokens + (completionTokens / 1000) * pricing.outputPer1kTokens;
  }

  private resolvePricing(candidate: {
    routeKey: string;
    source: "managed" | "provider" | "default";
    model: string;
    provider?: string;
  }): ModelPricingConfig {
    const pricing = this.configStore.get().autoRouting.pricing;
    const keys = [
      candidate.routeKey,
      candidate.provider ? `provider:${candidate.provider}:${candidate.model}` : undefined,
      candidate.provider ? `provider:${candidate.provider}:*` : undefined,
      candidate.source === "managed" ? `managed:${candidate.model}` : undefined,
      candidate.source === "managed" ? "managed:*" : undefined,
      `model:${candidate.model}`,
    ];
    for (const key of keys) {
      if (!key) continue;
      const found = pricing.overrides[key];
      if (found) {
        return found;
      }
    }
    return pricing.default;
  }

  private async ensureProviderManager(): Promise<void> {
    if (this.providerManager) {
      return;
    }
    if (!this.providerLoadPromise) {
      this.providerLoadPromise = (async () => {
        const resolvedPath = path.resolve(this.providerConfigPath);
        const manager = new ProviderConfigurationManager(resolvedPath);
        await manager.loadConfiguration();
        manager.updateFromEnvironment();
        this.providerManager = manager;
      })();
    }
    await this.providerLoadPromise;
  }

  private isProviderRoutingEnabled(): boolean {
    return (
      Boolean(process.env.KGM_PROVIDER_CONFIG_PATH) ||
      process.env.KGM_PROVIDER_ROUTING_ENABLED === "1" ||
      process.env.KGM_PROVIDER_ROUTING_ENABLED === "true"
    );
  }
}

export function extractAutoRoutingTrace(raw: unknown): AutoRoutingTrace | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const trace = raw.autoRouting;
  return isRecord(trace) ? (trace as AutoRoutingTrace) : undefined;
}

export function extractResolvedModel(raw: unknown): string | undefined {
  const trace = extractAutoRoutingTrace(raw);
  if (trace?.selected.model) {
    return trace.selected.model;
  }
  if (isRecord(raw)) {
    const managedRuntime = raw.managedRuntime;
    if (isRecord(managedRuntime) && typeof managedRuntime.model === "string") {
      return managedRuntime.model;
    }
    const providerRouting = raw.providerRouting;
    if (isRecord(providerRouting) && typeof providerRouting.model === "string") {
      return providerRouting.model;
    }
  }
  return undefined;
}

function toSnapshot(candidate: RoutingCandidate): AutoRoutingCandidateSnapshot {
  return {
    routeKey: candidate.routeKey,
    label: candidate.label,
    source: candidate.source,
    model: candidate.model,
    provider: candidate.provider,
    runtimeId: candidate.runtimeId,
    score: round(candidate.score),
    estimatedCost: round(candidate.estimatedCost, 6),
    successRate: round(candidate.successRate),
    quality: round(candidate.quality),
    trust: round(candidate.trust),
    latencyMs: round(candidate.latencyMs, 1),
    verification: round(candidate.verification),
  };
}

function normalizeHints(
  hints?: RoutingHints,
  metadata?: Record<string, unknown>,
): RoutingHints {
  const target = {
    model: hints?.target?.model,
    provider: hints?.target?.provider,
    runtimeId: hints?.target?.runtimeId,
  };
  if (!target.provider && typeof metadata?.provider_preference === "string") {
    target.provider = metadata.provider_preference;
  }
  if (!target.model && typeof metadata?.target_model === "string") {
    target.model = metadata.target_model;
  }
  return {
    enabled: hints?.enabled,
    profile: normalizeProfile(
      hints?.profile ?? (typeof metadata?.routing_profile === "string" ? metadata.routing_profile : undefined),
    ),
    taskType: hints?.taskType ?? (typeof metadata?.task_type === "string" ? metadata.task_type : undefined),
    taskName: hints?.taskName ?? (typeof metadata?.task_name === "string" ? metadata.task_name : undefined),
    privacyLevel:
      hints?.privacyLevel ??
      (typeof metadata?.privacy_level === "string" ? (metadata.privacy_level as RoutingHints["privacyLevel"]) : undefined),
    verificationExpected:
      hints?.verificationExpected ??
      (typeof metadata?.verification_expected === "boolean" ? metadata.verification_expected : undefined),
    maxCostPerRequest:
      hints?.maxCostPerRequest ??
      (typeof metadata?.max_cost_per_request === "number" ? metadata.max_cost_per_request : undefined),
    target,
  };
}

function normalizeProfile(value?: string): RoutingProfile {
  return value === "cost_first" || value === "manual" ? value : "quality_first";
}

function detectTaskType(input: string, fallback: string): string {
  const value = input.toLowerCase();
  if (/(typescript|javascript|python|sql|bug|代码|编程|函数|class|api)/.test(value)) {
    return "code_generation";
  }
  if (/(json|schema|结构化|yaml|xml|csv)/.test(value)) {
    return "structured_output";
  }
  if (/(math|equation|calculate|solve|数学|方程|证明)/.test(value)) {
    return "math_reasoning";
  }
  if (/(translate|translation|翻译)/.test(value)) {
    return "translation";
  }
  if (/(analy|reason|推理|分析|strategy|plan|design)/.test(value)) {
    return "reasoning";
  }
  return fallback;
}

function isVerifiableTask(input: string, taskType: string, prompt: string): boolean {
  if (taskType === "code_generation" || taskType === "structured_output" || taskType === "math_reasoning") {
    return true;
  }
  const value = `${input}\n${prompt}`.toLowerCase();
  return /(json|schema|test|assert|compile|运行|校验|验证)/.test(value);
}

function estimateComplexity(input: string): number {
  const lengthScore = Math.min(input.length / 1200, 1);
  const keywordScore = /(reason|multi-step|推理|分析|设计|架构|tradeoff|性能|优化)/i.test(input) ? 0.2 : 0;
  return clamp(0.25 + lengthScore * 0.55 + keywordScore);
}

function defaultQualityForTask(taskType: string, bonus = 0): number {
  const base =
    taskType === "code_generation" ? 0.78
      : taskType === "structured_output" ? 0.75
        : taskType === "math_reasoning" ? 0.74
          : taskType === "reasoning" ? 0.72
            : 0.68;
  return clamp(base + bonus);
}

function deriveRuntimeSuccess(metrics?: ManagedRuntimeMetrics): number | undefined {
  if (!metrics || metrics.requestsTotal === 0) {
    return undefined;
  }
  return clamp(metrics.successesTotal / metrics.requestsTotal);
}

function deriveQualityScore(output: string, verificationPassed: boolean): number {
  const intent = parseIntent(output);
  if (!output.trim()) {
    return 0;
  }
  if (intent.type === "final") {
    const contentScore = intent.content.trim().length > 0 ? 0.72 : 0.35;
    return clamp(contentScore + (verificationPassed ? 0.16 : 0));
  }
  return clamp(0.7 + (verificationPassed ? 0.12 : 0));
}

function verifyResult(taskType: string, output: string, verifiable: boolean): boolean {
  if (!verifiable) {
    return true;
  }
  const intent = parseIntent(output);
  if (taskType === "structured_output") {
    return intent.type === "final" && intent.content.trim().length > 0;
  }
  if (taskType === "code_generation" || taskType === "math_reasoning") {
    return intent.type === "final" && intent.content.trim().length > 0;
  }
  return Boolean(intent);
}

function toEvaluationTarget(candidate: RoutingCandidate): EvaluationExecutionTarget {
  return {
    routeKey: candidate.routeKey,
    label: candidate.label,
    source: candidate.source,
    model: candidate.model,
    provider: candidate.provider,
    runtimeId: candidate.runtimeId,
    providerConfig: candidate.providerConfig,
  };
}

function toEvaluationStageRecord(
  execution: EvaluationExecutionResult,
  attempted: boolean,
): AutoRoutingEvaluationStageRecord {
  return {
    enabled: true,
    attempted,
    routeKey: execution.target.routeKey,
    label: execution.target.label,
    source: execution.target.source,
    model: execution.target.model,
    provider: execution.target.provider,
    runtimeId: execution.target.runtimeId,
    latencyMs: execution.latencyMs,
    promptTokens: execution.promptTokens,
    completionTokens: execution.completionTokens,
    totalTokens: execution.totalTokens,
    cost: execution.cost,
  };
}

function failedEvaluationStageRecord(
  config: AutoRoutingEvaluatorConfig,
  error: unknown,
): AutoRoutingEvaluationStageRecord {
  return {
    enabled: config.enabled,
    attempted: true,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    error: String(error),
  };
}

function createHeuristicEvaluationRecord(
  verificationSource: AutoRoutingVerificationSource,
): AutoRoutingEvaluationRecord {
  return {
    mode: "heuristic",
    qualitySource: "heuristic",
    confidenceSource: "heuristic",
    verificationSource,
  };
}

function sumEvaluationTokens(
  evaluation: AutoRoutingEvaluationRecord,
  key: "promptTokens" | "completionTokens" | "totalTokens",
): number {
  return (evaluation.judge?.[key] ?? 0) + (evaluation.verifier?.[key] ?? 0);
}

function sumEvaluationCosts(evaluation: AutoRoutingEvaluationRecord): number {
  return (evaluation.judge?.cost ?? 0) + (evaluation.verifier?.cost ?? 0);
}

function buildJudgePrompt(
  taskType: string,
  taskName: string | undefined,
  taskInput: string,
  output: string,
): string {
  return [
    "You are the judge for KGM auto-routing evaluation.",
    "Evaluate the assistant answer for correctness, completeness, usefulness, and task fit.",
    "Return JSON only with this schema:",
    '{"score":0.0,"confidence":0.0,"verdict":"short summary","issues":["issue"]}',
    "Use scores between 0 and 1.",
    `Task type: ${taskType}`,
    `Task name: ${taskName ?? "n/a"}`,
    "User task:",
    truncate(taskInput, 3200),
    "Assistant answer:",
    truncate(output, 4200),
  ].join("\n");
}

function buildVerifierPrompt(
  taskType: string,
  taskName: string | undefined,
  taskInput: string,
  output: string,
): string {
  return [
    "You are the verifier for KGM auto-routing evaluation.",
    "Check whether the assistant answer satisfies the task and is internally consistent.",
    "Return JSON only with this schema:",
    '{"passed":true,"score":0.0,"confidence":0.0,"verdict":"short summary","issues":["issue"]}',
    "Use scores between 0 and 1.",
    `Task type: ${taskType}`,
    `Task name: ${taskName ?? "n/a"}`,
    "User task:",
    truncate(taskInput, 3200),
    "Assistant answer:",
    truncate(output, 4200),
  ].join("\n");
}

function parseEvaluationPayload(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("evaluation_payload_missing_json");
  }
  const parsed = JSON.parse(match[0]) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("evaluation_payload_invalid");
  }
  return parsed;
}

function readNumberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBooleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function combineOnlineQuality(
  judge: AutoRoutingEvaluationStageRecord,
  verifier: AutoRoutingEvaluationStageRecord,
): number | undefined {
  const judgeScore = typeof judge.score === "number" ? judge.score : undefined;
  const verifierScore = typeof verifier.score === "number" ? verifier.score : undefined;
  if (typeof judgeScore === "number" && typeof verifierScore === "number") {
    return clamp((judgeScore * 0.7) + (verifierScore * 0.3));
  }
  if (typeof judgeScore === "number") {
    return clamp(judgeScore);
  }
  if (typeof verifierScore === "number") {
    return clamp(verifierScore);
  }
  return undefined;
}

function combineOnlineConfidence(
  judge: AutoRoutingEvaluationStageRecord,
  verifier: AutoRoutingEvaluationStageRecord,
): number | undefined {
  const judgeConfidence = typeof judge.confidence === "number" ? judge.confidence : undefined;
  const verifierConfidence = typeof verifier.confidence === "number" ? verifier.confidence : undefined;
  if (typeof judgeConfidence === "number" && typeof verifierConfidence === "number") {
    return clamp((judgeConfidence * 0.6) + (verifierConfidence * 0.4));
  }
  if (typeof judgeConfidence === "number") {
    return clamp(judgeConfidence);
  }
  if (typeof verifierConfidence === "number") {
    return clamp(verifierConfidence);
  }
  return undefined;
}

function resolveOnlineQualitySource(
  judge: AutoRoutingEvaluationStageRecord,
  verifier: AutoRoutingEvaluationStageRecord,
): AutoRoutingEvaluationSource {
  const hasJudge = typeof judge.score === "number";
  const hasVerifier = typeof verifier.score === "number";
  if (hasJudge && hasVerifier) {
    return "judge_and_verifier";
  }
  if (hasJudge) {
    return "judge";
  }
  if (hasVerifier) {
    return "verifier";
  }
  return "heuristic";
}

function resolveOnlineConfidenceSource(
  judge: AutoRoutingEvaluationStageRecord,
  verifier: AutoRoutingEvaluationStageRecord,
): AutoRoutingEvaluationSource {
  const hasJudge = typeof judge.confidence === "number";
  const hasVerifier = typeof verifier.confidence === "number";
  if (hasJudge && hasVerifier) {
    return "judge_and_verifier";
  }
  if (hasJudge) {
    return "judge";
  }
  if (hasVerifier) {
    return "verifier";
  }
  return "heuristic";
}

function extractUsageMetrics(raw: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  if (!isRecord(raw)) {
    return {};
  }
  const usage = isRecord(raw.usage) ? raw.usage : undefined;
  if (!usage) {
    return {};
  }
  const promptTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens
      : typeof usage.input_tokens === "number" ? usage.input_tokens
        : undefined;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens
      : typeof usage.output_tokens === "number" ? usage.output_tokens
        : undefined;
  const totalTokens =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : typeof promptTokens === "number" && typeof completionTokens === "number"
        ? promptTokens + completionTokens
        : undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeScore(value: number, ceiling: number): number {
  if (ceiling <= 0) {
    return 0;
  }
  return clamp(value / ceiling);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
