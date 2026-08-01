import type { ContextBuilder } from "../context/contextBuilder.js";
import type { Constraints, Evidence, KgmRequest } from "../core/types.js";
import type { ArtifactRef } from "../context/artifactStore.js";
import type { SessionStoreRef } from "../context/sessionStore.js";
import type { Embedder } from "../embedding/canonical.js";
import type { GraphEdge, GraphStore, GraphSubgraph } from "../graph/store.js";
import type { LlmClient } from "../llm/client.js";
import type { MemoryStore } from "../memory/store.js";
import { generateId } from "../utils/id.js";
import { fuseDualTrackConfidence, type DualTrackScoreResult } from "./confidenceFusion.js";
import { getFrontStation } from "../frontstation/factory.js";

export type KceMode = "fast" | "balanced" | "quality";

export type KceComputeRequest = KgmRequest & {
  kce?: {
    mode?: KceMode;
    llm?: {
      enabled?: boolean;
      evidenceCompression?: boolean;
    };
    graphLimit?: number;
    memoryTopK?: number;
    maxParallel?: number;
  };
};

export type KceLogicalEntity = {
  type: string;
  name: string;
  source: "hint" | "query" | "llm";
};

export type KceLogicalConstraint = {
  type: string;
  value: string;
};

export type KceLogicalForm = {
  intent: string;
  entities: KceLogicalEntity[];
  relations: string[];
  constraints: KceLogicalConstraint[];
  parser: "heuristic" | "heuristic+llm" | "frontstation" | "frontstation+llm";
  confidence: number;
};

export type KceEvidenceNode = {
  id: string;
  type: "entity" | "memory";
  name: string;
  source: string;
  score?: number;
  text?: string;
  properties?: Record<string, unknown>;
};

export type KceEvidenceEdge = {
  id: string;
  from: string;
  to: string;
  relation: string;
  source: string;
  weight?: number;
};

export type KceSubgraph = {
  id: string;
  nodes: KceEvidenceNode[];
  edges: KceEvidenceEdge[];
  evidence: Evidence[];
  graph: GraphSubgraph;
};

export type KcePlanNode = {
  id: string;
  type: "graph_op" | "retrieval_op" | "llm_op" | "logic_op" | "frontstation_op";
  operator: string;
  depends_on: string[];
  required?: boolean;
  timeout_ms?: number;
  config?: Record<string, unknown>;
};

export type KcePlanEdge = {
  from: string;
  to: string;
};

export type KceExecutionPlan = {
  strategy: "deterministic";
  nodes: KcePlanNode[];
  edges: KcePlanEdge[];
};

export type KceTraceItem = {
  step: string;
  status: "start" | "complete" | "error";
  timestamp: number;
  data?: unknown;
};

export type KceValidationCheck = {
  name: string;
  passed: boolean;
  confidence: number;
  details?: string;
};

export type KceValidationResult = {
  passed: boolean;
  checks: KceValidationCheck[];
  confidence: number;
  /** Explicit formal × retrieval × LLM dual-track breakdown */
  dual_track?: DualTrackScoreResult;
};

export type KceExecutionStep = {
  node_id: string;
  operator: string;
  type: string;
  status: "completed" | "error";
  required: boolean;
  batch: number;
  duration_ms: number;
  output: Record<string, unknown>;
};

export type KceComputeResponse = {
  request_id?: string;
  session_id?: string;
  trace_id?: string;
  answer: string;
  logical_form: KceLogicalForm;
  session_ref?: SessionStoreRef;
  artifacts?: {
    request?: ArtifactRef;
    trace?: ArtifactRef;
    response?: ArtifactRef;
  };
  evidence: {
    nodes: KceEvidenceNode[];
    edges: KceEvidenceEdge[];
    subgraph_id: string;
    memory: Evidence[];
  };
  reasoning_trace: KceTraceItem[];
  execution_plan: KceExecutionPlan;
  validation: KceValidationResult;
  confidence: number;
  metrics: {
    total_latency_ms: number;
    steps_executed: number;
    execution_batches: number;
    llm_calls: number;
    graph_triples: number;
    memory_evidence: number;
    validation_passed: boolean;
  };
};

type KceExecutionResult = {
  answer: string;
  steps: KceExecutionStep[];
  results: Record<string, Record<string, unknown>>;
  batches: number;
};

export class KceExecutionFailure extends Error {
  readonly code = "kce_execution_failed" as const;
  readonly status = 500;
  readonly step?: KceExecutionStep;

  constructor(message: string, step?: KceExecutionStep) {
    super(message);
    this.name = "KceExecutionFailure";
    this.step = step;
  }
}

type KceOperatorState = {
  request: KceComputeRequest;
  logicalForm: KceLogicalForm;
  subgraph: KceSubgraph;
  dependencies: Record<string, Record<string, unknown>>;
};

type KceOperator = (state: KceOperatorState) => Promise<Record<string, unknown>>;

type KceEngineDeps = {
  contextBuilder: ContextBuilder;
  graphStore?: GraphStore;
  memoryStore?: MemoryStore;
  embedder?: Embedder;
  llmClient?: LlmClient;
};

export class KceEngine {
  private deps: KceEngineDeps;
  private trace: KceTraceItem[] = [];
  private llmCalls = 0;
  private operators: Map<string, KceOperator>;

  constructor(deps: KceEngineDeps) {
    this.deps = deps;
    this.operators = new Map<string, KceOperator>([
      ["retrieve_graph", this.retrieveGraphOperator.bind(this)],
      ["retrieve_memory", this.retrieveMemoryOperator.bind(this)],
      ["reason_over_graph", this.reasonOverGraphOperator.bind(this)],
      ["extractive_summary", this.extractiveSummaryOperator.bind(this)],
      ["synthesize_answer", this.synthesizeAnswerOperator.bind(this)],
      ["validate_answer", this.validateAnswerOperator.bind(this)],
    ]);
  }

  async compute(request: KceComputeRequest): Promise<KceComputeResponse> {
    if (!request.requestId) {
      request.requestId = generateId("kce");
    }
    const startedAt = Date.now();
    this.trace = [];
    this.llmCalls = 0;

    const logicalForm = await this.withTrace("semantic_parse", async () => this.parse(request));
    const subgraph = await this.withTrace("knowledge_projection", async () => this.projectKnowledge(request, logicalForm));
    const plan = await this.withTrace("plan_generation", async () => this.generatePlan(request, logicalForm, subgraph));
    const executionResult = await this.withTrace("dag_execution", async () =>
      this.executePlan(plan, request, logicalForm, subgraph),
    );
    const validation = await this.withTrace("verification", async () =>
      this.validate(executionResult, plan, logicalForm, subgraph, request.constraints ?? {}),
    );

    const totalLatency = Date.now() - startedAt;
    return {
      answer: executionResult.answer,
      logical_form: logicalForm,
      evidence: {
        nodes: subgraph.nodes,
        edges: subgraph.edges,
        subgraph_id: subgraph.id,
        memory: subgraph.evidence,
      },
      reasoning_trace: this.trace,
      execution_plan: plan,
      validation,
      confidence: validation.confidence,
      metrics: {
        total_latency_ms: totalLatency,
        steps_executed: executionResult.steps.length,
        execution_batches: executionResult.batches,
        llm_calls: this.llmCalls,
        graph_triples: subgraph.graph.triples.length,
        memory_evidence: subgraph.evidence.length,
        validation_passed: validation.passed,
      },
    };
  }

  private async withTrace<T>(step: string, fn: () => Promise<T>): Promise<T> {
    this.addTrace(step, "start");
    try {
      const result = await fn();
      this.addTrace(step, "complete", summarize(result));
      return result;
    } catch (error) {
      this.addTrace(step, "error", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private addTrace(step: string, status: KceTraceItem["status"], data?: unknown): void {
    this.trace.push({
      step,
      status,
      timestamp: Date.now(),
      data,
    });
  }

  private async parse(request: KceComputeRequest): Promise<KceLogicalForm> {
    const heuristic = await buildHeuristicLogicalForm(request);
    const llmEnabled = request.kce?.llm?.enabled === true;
    if (!llmEnabled || !this.deps.llmClient) {
      return heuristic;
    }

    const prompt = [
      "Return a JSON object with keys intent, entities, relations, constraints.",
      "Do not include markdown.",
      `User query: ${request.input}`,
    ].join("\n");
    const completion = await this.deps.llmClient.complete(prompt, {
      maxTokens: 300,
      temperature: 0,
      taskType: "kce.semantic_parse",
      taskInput: request.input,
    });
    this.llmCalls += 1;

    const parsed = extractJsonObject(completion.text);
    if (!parsed) {
      return heuristic;
    }

    const merged = mergeLogicalForms(heuristic, parsed);
    merged.parser = heuristic.parser === "frontstation" ? "frontstation+llm" : "heuristic+llm";
    merged.confidence = Math.max(merged.confidence, 0.8);
    return merged;
  }

  private async projectKnowledge(
    request: KceComputeRequest,
    logicalForm: KceLogicalForm,
  ): Promise<KceSubgraph> {
    const context = await this.deps.contextBuilder.build({
      ...request,
      kgm: {
        ...request.kgm,
        graph: {
          ...request.kgm?.graph,
          enabled: request.kgm?.graph?.enabled ?? true,
        },
      },
    });

    const graphLimit = clamp(request.kce?.graphLimit ?? 8, 1, 32);
    const graph = this.deps.graphStore
      ? await this.deps.graphStore.querySubgraph({
          entities: logicalForm.entities.map((item) => item.name),
          relations: logicalForm.relations,
          query: request.input,
          limit: graphLimit,
          namespace: request.userId,
        })
      : { triples: [], entities: [], relations: [] };

    const nodeMap = new Map<string, KceEvidenceNode>();
    for (const entity of logicalForm.entities) {
      const nodeId = `entity:${entity.name.toLowerCase()}`;
      nodeMap.set(nodeId, {
        id: nodeId,
        type: "entity",
        name: entity.name,
        source: entity.source,
        properties: { entityType: entity.type },
      });
    }

    for (const entity of graph.entities) {
      const nodeId = `entity:${entity.toLowerCase()}`;
      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          type: "entity",
          name: entity,
          source: "graph",
        });
      }
    }

    const evidence = context.evidence.slice(0, clamp(request.kce?.memoryTopK ?? context.evidence.length, 0, 16));
    evidence.forEach((item) => {
      nodeMap.set(`memory:${item.id}`, {
        id: `memory:${item.id}`,
        type: "memory",
        name: item.source,
        source: item.source,
        score: item.score,
        text: item.text,
      });
    });

    const edges = graph.triples.map((triple) => ({
      id: triple.id,
      from: `entity:${triple.subject.toLowerCase()}`,
      to: `entity:${triple.object.toLowerCase()}`,
      relation: triple.predicate,
      source: triple.source,
      weight: triple.weight,
    }));

    return {
      id: `kce_subgraph_${Date.now()}`,
      nodes: Array.from(nodeMap.values()),
      edges,
      evidence,
      graph,
    };
  }

  private async generatePlan(
    request: KceComputeRequest,
    logicalForm: KceLogicalForm,
    subgraph: KceSubgraph,
  ): Promise<KceExecutionPlan> {
    const nodes: KcePlanNode[] = [];

    if (subgraph.graph.triples.length > 0 || logicalForm.entities.length > 0) {
      nodes.push({
        id: "graph_retrieval",
        type: "graph_op",
        operator: "retrieve_graph",
        depends_on: [],
        required: true,
        timeout_ms: 3000,
      });
    }

    if (subgraph.evidence.length > 0) {
      nodes.push({
        id: "memory_retrieval",
        type: "retrieval_op",
        operator: "retrieve_memory",
        depends_on: [],
        required: false,
        timeout_ms: 3000,
      });
    }

    if (
      subgraph.graph.triples.length > 0 &&
      logicalForm.intent !== "summary" &&
      (logicalForm.entities.length > 0 || subgraph.graph.entities.length > 0)
    ) {
      nodes.push({
        id: "graph_reasoning",
        type: "graph_op",
        operator: "reason_over_graph",
        depends_on: ["graph_retrieval"],
        required: logicalForm.intent === "path_analysis",
        timeout_ms: 4000,
      });
    }

    // 摘要意图：前站 extractive 原子算子（encoder 轨，不进 decoder-only Native）
    if (logicalForm.intent === "summary") {
      nodes.push({
        id: "extractive_summary",
        type: "frontstation_op",
        operator: "extractive_summary",
        depends_on: nodes.map((node) => node.id),
        required: true,
        timeout_ms: 4000,
      });
    }

    nodes.push({
      id: "synthesis",
      type: "llm_op",
      operator: "synthesize_answer",
      depends_on: nodes.map((node) => node.id),
      required: true,
      timeout_ms: 3000,
    });

    nodes.push({
      id: "validation",
      type: "logic_op",
      operator: "validate_answer",
      depends_on: ["synthesis"],
      required: true,
      timeout_ms: 2000,
    });

    const dedupedNodes = nodes.map((node) =>
      node.id === "synthesis"
        ? { ...node, depends_on: Array.from(new Set(node.depends_on.filter((dep) => dep !== "synthesis"))) }
        : node,
    );
    const edges = buildPlanEdges(dedupedNodes);

    if (request.kce?.mode === "quality" && this.deps.llmClient) {
      return {
        strategy: "deterministic",
        nodes: dedupedNodes,
        edges,
      };
    }

    return {
      strategy: "deterministic",
      nodes: dedupedNodes,
      edges,
    };
  }

  private async executePlan(
    plan: KceExecutionPlan,
    request: KceComputeRequest,
    logicalForm: KceLogicalForm,
    subgraph: KceSubgraph,
  ): Promise<KceExecutionResult> {
    const nodeMap = new Map(plan.nodes.map((node) => [node.id, node]));
    for (const node of plan.nodes) {
      for (const dep of node.depends_on) {
        if (!nodeMap.has(dep)) {
          throw new Error(`kce_plan_missing_dependency:${node.id}:${dep}`);
        }
      }
    }

    const pendingDeps = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of plan.nodes) {
      pendingDeps.set(node.id, node.depends_on.length);
      for (const dep of node.depends_on) {
        const list = dependents.get(dep) ?? [];
        list.push(node.id);
        dependents.set(dep, list);
      }
    }

    const ready = plan.nodes
      .filter((node) => node.depends_on.length === 0)
      .map((node) => node.id);
    const results = new Map<string, Record<string, unknown>>();
    const steps: KceExecutionStep[] = [];
    let batches = 0;
    const maxParallel = clamp(request.kce?.maxParallel ?? 4, 1, 8);

    while (ready.length > 0) {
      const batchIds = ready.splice(0, maxParallel);
      batches += 1;
      const batchResults = await Promise.all(
        batchIds.map(async (nodeId) => {
          const node = nodeMap.get(nodeId)!;
          const startedAt = Date.now();
          const dependencies = Object.fromEntries(
            node.depends_on.map((dep) => [dep, results.get(dep) ?? {}]),
          );
          try {
            const output = await this.executeNode(node, {
              request,
              logicalForm,
              subgraph,
              dependencies,
            });
            return {
              node,
              step: {
                node_id: node.id,
                operator: node.operator,
                type: node.type,
                status: "completed" as const,
                required: node.required !== false,
                batch: batches,
                duration_ms: Date.now() - startedAt,
                output,
              },
            };
          } catch (error) {
            return {
              node,
              step: {
                node_id: node.id,
                operator: node.operator,
                type: node.type,
                status: "error" as const,
                required: node.required !== false,
                batch: batches,
                duration_ms: Date.now() - startedAt,
                output: {
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            };
          }
        }),
      );

      for (const item of batchResults) {
        if (item.step.status === "error" && item.step.required) {
          steps.push(item.step);
          throw new KceExecutionFailure(
            `kce_required_node_failed:${item.node.id}`,
            item.step,
          );
        }
        results.set(item.node.id, item.step.output);
        steps.push(item.step);
        for (const next of dependents.get(item.node.id) ?? []) {
          pendingDeps.set(next, (pendingDeps.get(next) ?? 0) - 1);
        }
      }

      for (const [nodeId, count] of pendingDeps.entries()) {
        if (count === 0 && !results.has(nodeId) && !ready.includes(nodeId)) {
          ready.push(nodeId);
        }
      }
    }

    if (steps.length !== plan.nodes.length) {
      throw new Error("kce_plan_cycle_detected");
    }

    const answer =
      (results.get("synthesis")?.answer as string | undefined) ??
      "Insufficient evidence to produce a KCE answer.";
    return {
      answer,
      steps,
      results: Object.fromEntries(results),
      batches,
    };
  }

  private async executeNode(node: KcePlanNode, state: KceOperatorState): Promise<Record<string, unknown>> {
    const operator = this.operators.get(node.operator);
    if (!operator) {
      throw new Error(`kce_operator_not_found:${node.operator}`);
    }
    return withTimeout(
      operator(state),
      node.timeout_ms ?? 3000,
      `kce_node_timeout:${node.id}`,
    );
  }

  private async retrieveGraphOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    return {
      triples: state.subgraph.graph.triples.slice(0, 12).map((triple) => ({
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
      })),
      entities: state.subgraph.graph.entities,
      relations: state.subgraph.graph.relations,
      count: state.subgraph.graph.triples.length,
    };
  }

  private async retrieveMemoryOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    return {
      evidence: state.subgraph.evidence.map((item) => ({
        id: item.id,
        score: Number(item.score.toFixed(4)),
        source: item.source,
        text: truncate(item.text, 180),
      })),
      count: state.subgraph.evidence.length,
    };
  }

  private async reasonOverGraphOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    const entityNames = Array.from(
      new Set([
        ...state.logicalForm.entities.map((item) => item.name),
        ...state.subgraph.graph.entities,
      ]),
    );
    if (entityNames.length >= 2 && this.deps.graphStore?.shortestPath) {
      const path = await this.deps.graphStore.shortestPath({
        from: entityNames[0]!,
        to: entityNames[1]!,
        maxHops: 6,
        namespace: state.request.userId,
      });
      if (path) {
        return {
          mode: "shortest_path",
          path: path.path,
          edges: path.edges.map(serializeGraphEdge),
        };
      }
    }

    if (entityNames.length >= 1 && this.deps.graphStore?.reasonExpand) {
      const expanded = await this.deps.graphStore.reasonExpand({
        entity: entityNames[0]!,
        maxDepth: 2,
        relations: state.logicalForm.relations,
        namespace: state.request.userId,
      });
      if (expanded) {
        return {
          mode: "expand",
          center: expanded.center,
          entities: expanded.entities,
          triples: expanded.triples.map(serializeGraphEdge),
        };
      }
    }

    return {
      mode: "fallback",
      triples: state.subgraph.graph.triples.slice(0, 6).map(serializeGraphEdge),
    };
  }

  private async extractiveSummaryOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    const memoryResult = state.dependencies.memory_retrieval;
    const graphResult = state.dependencies.graph_retrieval;
    const evidenceBits: string[] = [];
    if (Array.isArray(memoryResult?.evidence)) {
      for (const item of memoryResult.evidence as Array<Record<string, unknown>>) {
        if (typeof item.text === "string" && item.text.trim()) {
          evidenceBits.push(item.text.trim());
        }
      }
    }
    if (Array.isArray(graphResult?.triples)) {
      for (const triple of graphResult.triples as Array<Record<string, unknown>>) {
        evidenceBits.push(`${triple.subject} ${triple.predicate} ${triple.object}`);
      }
    }
    const corpus = [state.request.input, ...evidenceBits].filter(Boolean).join("\n");
    const summarized = await getFrontStation().summarizer.summarize(corpus, {
      maxSentences: 4,
      maxChars: 600,
      languageHint: state.request.constraints?.language,
    });
    return {
      summary: summarized.summary,
      sentences: summarized.sentences.slice(0, 8),
      backend: summarized.backend,
      latency_ms: summarized.latencyMs,
      track: "encoder_frontstation",
    };
  }

  private async synthesizeAnswerOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    const graphResult = state.dependencies.graph_retrieval;
    const memoryResult = state.dependencies.memory_retrieval;
    const reasoningResult = state.dependencies.graph_reasoning;
    const extractive = state.dependencies.extractive_summary;

    // 前站抽取式摘要优先作为答案（summary 意图），不调用生成式 decoder
    if (state.logicalForm.intent === "summary" && typeof extractive?.summary === "string" && extractive.summary.trim()) {
      return {
        answer: extractive.summary,
        citations: {
          graph_triples: state.subgraph.graph.triples.length,
          memory_items: state.subgraph.evidence.length,
          extractive_backend: extractive.backend,
          track: "encoder_frontstation",
        },
      };
    }

    // Quality mode with evidence compression enabled
    let compressedEvidence = memoryResult;
    if (
      state.request.kce?.mode === "quality" &&
      state.request.kce?.llm?.evidenceCompression === true &&
      this.deps.llmClient &&
      Array.isArray(memoryResult?.evidence) &&
      memoryResult.evidence.length > 3
    ) {
      try {
        compressedEvidence = await this.compressEvidenceWithLLM(
          state.request.input,
          memoryResult.evidence as Array<Record<string, unknown>>,
        );
        this.llmCalls += 1;
      } catch (error) {
        // Fallback to original evidence if compression fails
        console.warn("Evidence compression failed, using original:", error);
      }
    }

    const answer = buildDeterministicAnswer({
      query: state.request.input,
      logicalForm: state.logicalForm,
      graphResult,
      memoryResult: compressedEvidence,
      reasoningResult,
      constraints: state.request.constraints,
    });

    return {
      answer,
      citations: {
        graph_triples: state.subgraph.graph.triples.length,
        memory_items: state.subgraph.evidence.length,
        compressed: compressedEvidence !== memoryResult,
      },
    };
  }

  private async compressEvidenceWithLLM(
    query: string,
    evidence: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const evidenceText = evidence
      .slice(0, 8)
      .map((item) => `[${item.source}] ${item.text}`)
      .join("\n");

    const prompt = [
      "Compress and rewrite the following evidence to be more concise while preserving key information relevant to the query.",
      "Return a JSON array with objects having 'source' and 'text' fields.",
      "Do not include markdown.",
      `Query: ${query}`,
      `Evidence:\n${evidenceText}`,
    ].join("\n");

    const completion = await this.deps.llmClient!.complete(prompt, {
      maxTokens: 400,
      temperature: 0.1,
      taskType: "kce.evidence_compression",
      taskInput: query,
    });

    const parsed = extractJsonObject(completion.text);
    if (parsed && Array.isArray(parsed) && parsed.length > 0) {
      const compressed = parsed
        .slice(0, 5)
        .map((item: unknown) => {
          if (item && typeof item === "object" && "text" in item) {
            const itemObj = item as Record<string, unknown>;
            return {
              id: `compressed_${Math.random().toString(36).slice(2, 9)}`,
              source: typeof itemObj.source === "string" ? itemObj.source : "compressed",
              text: String(itemObj.text).slice(0, 200),
              score: 0.9,
            };
          }
          return null;
        })
        .filter(Boolean) as Array<Record<string, unknown>>;

      if (compressed.length > 0) {
        return {
          evidence: compressed,
          count: compressed.length,
          compressed: true,
        };
      }
    }

    // Fallback to original if parsing fails
    return { evidence, count: evidence.length, compressed: false };
  }

  private async validateAnswerOperator(state: KceOperatorState): Promise<Record<string, unknown>> {
    const answer = String(state.dependencies.synthesis?.answer ?? "");
    return {
      answer_non_empty: answer.trim().length > 0,
      graph_support: state.subgraph.graph.triples.length > 0,
      memory_support: state.subgraph.evidence.length > 0,
    };
  }

  private async validate(
    executionResult: KceExecutionResult,
    plan: KceExecutionPlan,
    logicalForm: KceLogicalForm,
    subgraph: KceSubgraph,
    constraints: Constraints,
  ): Promise<KceValidationResult> {
    const checks: KceValidationCheck[] = [];
    const successfulSteps = executionResult.steps.filter((step) => step.status === "completed").length;
    const failedSteps = executionResult.steps.filter((step) => step.status === "error");
    const answer = executionResult.answer.trim();

    checks.push({
      name: "answer_non_empty",
      passed: answer.length > 0,
      confidence: answer.length > 0 ? 1 : 0.1,
      details: answer.length > 0 ? "ok" : "empty answer",
    });

    checks.push({
      name: "plan_complete",
      passed: successfulSteps === plan.nodes.length && failedSteps.length === 0,
      confidence: successfulSteps === plan.nodes.length && failedSteps.length === 0 ? 0.95 : 0.15,
      details: `${successfulSteps}/${plan.nodes.length} steps completed, failed=${failedSteps.length}`,
    });

    const hasEvidence = subgraph.graph.triples.length > 0 || subgraph.evidence.length > 0;
    checks.push({
      name: "evidence_grounding",
      passed: hasEvidence,
      confidence: hasEvidence ? 0.95 : 0.2,
      details: `graph=${subgraph.graph.triples.length}, memory=${subgraph.evidence.length}`,
    });

    const entityCoverage = logicalForm.entities.some((entity) => answer.includes(entity.name));
    checks.push({
      name: "entity_coverage",
      passed: logicalForm.entities.length === 0 || entityCoverage,
      confidence: logicalForm.entities.length === 0 || entityCoverage ? 0.9 : 0.35,
      details:
        logicalForm.entities.length === 0
          ? "no explicit entities"
          : entityCoverage
            ? "answer mentions requested entity"
            : "answer misses requested entity",
    });

    const reasoningResult = executionResult.results.graph_reasoning;
    const pathSatisfied =
      logicalForm.intent !== "path_analysis" ||
      (Array.isArray(reasoningResult?.path) && (reasoningResult.path as unknown[]).length >= 2);
    checks.push({
      name: "intent_specific_grounding",
      passed: pathSatisfied,
      confidence: pathSatisfied ? 0.9 : 0.2,
      details:
        logicalForm.intent !== "path_analysis"
          ? "no extra grounding required"
          : pathSatisfied
            ? "path evidence present"
            : "path evidence missing",
    });

    const evidenceTerms = new Set<string>();
    for (const triple of subgraph.graph.triples) {
      evidenceTerms.add(triple.subject.toLowerCase());
      evidenceTerms.add(triple.object.toLowerCase());
      evidenceTerms.add(triple.predicate.toLowerCase());
    }
    for (const item of subgraph.evidence) {
      tokenize(item.text).slice(0, 24).forEach((token) => evidenceTerms.add(token.toLowerCase()));
    }
    const answerTokens = tokenize(answer);
    const groundedTokens = answerTokens.filter((token) => token.length > 1 && evidenceTerms.has(token.toLowerCase()));
    checks.push({
      name: "answer_grounded_tokens",
      passed: !hasEvidence || groundedTokens.length > 0,
      confidence: !hasEvidence || groundedTokens.length > 0 ? 0.88 : 0.2,
      details: `grounded_tokens=${groundedTokens.length}`,
    });

    if (constraints.language?.toLowerCase().startsWith("zh")) {
      const hasChinese = /[\u4e00-\u9fff]/.test(answer);
      checks.push({
        name: "language_constraint",
        passed: hasChinese,
        confidence: hasChinese ? 0.95 : 0.3,
        details: hasChinese ? "zh content present" : "zh content missing",
      });
    }

    const heuristicConfidence = Number(
      (checks.reduce((sum, item) => sum + item.confidence, 0) / Math.max(checks.length, 1)).toFixed(4),
    );

    const symbolicScore = Number(
      (
        (logicalForm.confidence * 0.45 +
          (checks.find((c) => c.name === "evidence_grounding")?.confidence ?? 0.2) * 0.3 +
          (checks.find((c) => c.name === "intent_specific_grounding")?.confidence ?? 0.2) * 0.25)
      ).toFixed(4),
    );
    const retrievalScore = Number(
      (
        clamp01(
          (subgraph.evidence.length > 0 ? 0.35 : 0.1) +
            Math.min(0.55, subgraph.evidence.reduce((s, e) => s + (e.score ?? 0), 0) / Math.max(subgraph.evidence.length, 1)) +
            (subgraph.graph.triples.length > 0 ? 0.1 : 0),
        )
      ).toFixed(4),
    );
    const llmUsed = this.llmCalls > 0 || Boolean(executionResult.results.synthesize_answer);
    const llmScore = Number(
      clamp01(
        llmUsed
          ? 0.35 * heuristicConfidence +
              0.35 * (checks.find((c) => c.name === "answer_non_empty")?.confidence ?? 0) +
              0.3 * (checks.find((c) => c.name === "answer_grounded_tokens")?.confidence ?? 0)
          : heuristicConfidence * 0.55 + retrievalScore * 0.45,
      ).toFixed(4),
    );
    const dual_track = fuseDualTrackConfidence({
      symbolic: symbolicScore,
      retrieval: retrievalScore,
      llm: llmScore,
    });

    return {
      passed: checks.every((item) => item.passed),
      checks,
      confidence: dual_track.fused,
      dual_track,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

async function buildHeuristicLogicalForm(request: KceComputeRequest): Promise<KceLogicalForm> {
  const input = request.input ?? "";
  const classified = await getFrontStation().intent.classify(input);
  const intent = classified.kceIntent;
  const entityMap = new Map<string, KceLogicalEntity>();
  const relationSet = new Set<string>();

  for (const entity of request.kgm?.graph?.entities ?? []) {
    const trimmed = String(entity).trim();
    if (trimmed) {
      entityMap.set(trimmed.toLowerCase(), {
        type: "graph_entity",
        name: trimmed,
        source: "hint",
      });
    }
  }

  for (const triple of request.kgm?.graph?.triples ?? []) {
    for (const value of [triple.subject, triple.object]) {
      const trimmed = String(value).trim();
      if (trimmed) {
        entityMap.set(trimmed.toLowerCase(), {
          type: "graph_entity",
          name: trimmed,
          source: "hint",
        });
      }
    }
    if (triple.predicate.trim()) {
      relationSet.add(triple.predicate.trim());
    }
  }

  for (const relation of request.kgm?.graph?.relations ?? []) {
    const trimmed = String(relation).trim();
    if (trimmed) {
      relationSet.add(trimmed);
    }
  }

  for (const value of extractQuotedTerms(input)) {
    entityMap.set(value.toLowerCase(), {
      type: "quoted_term",
      name: value,
      source: "query",
    });
  }

  for (const value of extractAsciiEntities(input)) {
    entityMap.set(value.toLowerCase(), {
      type: "named_entity",
      name: value,
      source: "query",
    });
  }

  const constraints: KceLogicalConstraint[] = [];
  if (request.constraints?.language) {
    constraints.push({ type: "language", value: request.constraints.language });
  }
  if (request.constraints?.style) {
    constraints.push({ type: "style", value: request.constraints.style });
  }
  if (request.constraints?.riskLevel) {
    constraints.push({ type: "risk", value: request.constraints.riskLevel });
  }

  const baseConf = entityMap.size > 0 || relationSet.size > 0 ? 0.72 : 0.58;
  return {
    intent,
    entities: Array.from(entityMap.values()),
    relations: Array.from(relationSet),
    constraints,
    parser: classified.backend === "heuristic" ? "heuristic" : "frontstation",
    confidence: Math.max(baseConf, classified.confidence * 0.85 + 0.15),
  };
}

function mergeLogicalForms(base: KceLogicalForm, parsed: Record<string, unknown>): KceLogicalForm {
  const entities = new Map<string, KceLogicalEntity>();
  for (const entity of base.entities) {
    entities.set(entity.name.toLowerCase(), entity);
  }

  const parsedEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  for (const entity of parsedEntities) {
    if (!entity || typeof entity !== "object") {
      continue;
    }
    const name = typeof entity.name === "string" ? entity.name.trim() : "";
    if (!name) {
      continue;
    }
    entities.set(name.toLowerCase(), {
      type: typeof entity.type === "string" && entity.type.trim() ? entity.type.trim() : "llm_entity",
      name,
      source: "llm",
    });
  }

  const relations = new Set(base.relations);
  const parsedRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
  for (const relation of parsedRelations) {
    if (typeof relation === "string" && relation.trim()) {
      relations.add(relation.trim());
    }
  }

  const constraints = [...base.constraints];
  const parsedConstraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
  for (const constraint of parsedConstraints) {
    if (!constraint || typeof constraint !== "object") {
      continue;
    }
    const type = typeof constraint.type === "string" ? constraint.type.trim() : "";
    const value = typeof constraint.value === "string" ? constraint.value.trim() : "";
    if (type && value) {
      constraints.push({ type, value });
    }
  }

  return {
    intent:
      typeof parsed.intent === "string" && parsed.intent.trim() ? parsed.intent.trim() : base.intent,
    entities: Array.from(entities.values()),
    relations: Array.from(relations),
    constraints,
    parser: base.parser,
    confidence: base.confidence,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const normalized = stripCodeFence(text.trim());
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }
  return text.replace(/^```[a-zA-Z]*\n/, "").replace(/```$/, "").trim();
}

function extractQuotedTerms(input: string): string[] {
  const matches = input.match(/["'“”‘’]([^"'“”‘’]{1,40})["'“”‘’]/g) ?? [];
  return matches
    .map((item) => item.slice(1, -1).trim())
    .filter(Boolean);
}

function extractAsciiEntities(input: string): string[] {
  return Array.from(
    new Set(
      (input.match(/\b[A-Z][A-Za-z0-9_.-]{1,31}\b/g) ?? []).filter(
        (item) => item.length >= 2 && item.toLowerCase() !== item,
      ),
    ),
  );
}

function buildPlanEdges(nodes: KcePlanNode[]): KcePlanEdge[] {
  const edges: KcePlanEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      edges.push({ from: dep, to: node.id });
    }
  }
  return edges;
}

function buildDeterministicAnswer(params: {
  query: string;
  logicalForm: KceLogicalForm;
  graphResult?: Record<string, unknown>;
  memoryResult?: Record<string, unknown>;
  reasoningResult?: Record<string, unknown>;
  constraints?: Constraints;
}): string {
  const lines: string[] = [];
  const useChinese =
    params.constraints?.language?.toLowerCase().startsWith("zh") ||
    /[\u4e00-\u9fff]/.test(params.query);

  if (useChinese) {
    lines.push(`查询意图：${params.logicalForm.intent}`);
  } else {
    lines.push(`Intent: ${params.logicalForm.intent}`);
  }

  const triples = Array.isArray(params.graphResult?.triples)
    ? (params.graphResult?.triples as Array<Record<string, unknown>>)
    : [];
  if (triples.length > 0) {
    const summary = triples
      .slice(0, 6)
      .map((triple) => `${triple.subject} - ${triple.predicate} -> ${triple.object}`)
      .join(useChinese ? "；" : "; ");
    lines.push(useChinese ? `图谱关系：${summary}` : `Graph support: ${summary}`);
  }

  if (params.reasoningResult?.mode === "shortest_path" && Array.isArray(params.reasoningResult.path)) {
    lines.push(
      useChinese
        ? `关系路径：${(params.reasoningResult.path as string[]).join(" -> ")}`
        : `Reasoning path: ${(params.reasoningResult.path as string[]).join(" -> ")}`,
    );
  } else if (params.reasoningResult?.mode === "expand" && Array.isArray(params.reasoningResult.entities)) {
    lines.push(
      useChinese
        ? `邻域展开：${(params.reasoningResult.entities as string[]).slice(0, 8).join("、")}`
        : `Neighborhood: ${(params.reasoningResult.entities as string[]).slice(0, 8).join(", ")}`,
    );
  }

  const evidence = Array.isArray(params.memoryResult?.evidence)
    ? (params.memoryResult?.evidence as Array<Record<string, unknown>>)
    : [];
  if (evidence.length > 0) {
    const summary = evidence
      .slice(0, 3)
      .map((item) => `${item.source}: ${item.text}`)
      .join(useChinese ? "；" : "; ");
    lines.push(useChinese ? `检索证据：${summary}` : `Memory evidence: ${summary}`);
  }

  if (lines.length === 1) {
    lines.push(
      useChinese
        ? "当前上下文中缺少足够的图谱或记忆证据，建议补充实体、关系或历史资料后重试。"
        : "The current context does not contain enough graph or memory evidence. Add entities, relations, or prior evidence and retry.",
    );
  }

  return lines.join("\n");
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function serializeGraphEdge(edge: GraphEdge): Record<string, unknown> {
  return {
    subject: edge.subject,
    predicate: edge.predicate,
    object: edge.object,
    weight: edge.weight,
  };
}

function summarize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return { items: value.length };
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    if (text.length > 800) {
      return { bytes: text.length };
    }
  }
  return value;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
