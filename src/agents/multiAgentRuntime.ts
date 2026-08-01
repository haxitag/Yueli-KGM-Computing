/**
 * Bounded multi-agent runtime: supervisor + specialists.
 * Not an unbounded swarm. Reuses Scheduler for each hop.
 */

import { createHash, randomUUID } from "node:crypto";
import type { KgmRequest, KgmResponse } from "../core/types.js";
import { classifyIntentSync } from "../frontstation/factory.js";
import { enrichAgenticMetadata, enrichRoutingHints } from "../agentic/routingPreferences.js";
import { recordAgenticRound } from "../agentic/metrics.js";
import type { Scheduler } from "../scheduler/fsm.js";

export type MultiAgentRole = "supervisor" | "specialist";

export type MultiAgentSpec = {
  id: string;
  name: string;
  role: MultiAgentRole;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  taskType?: string;
};

export type MultiAgentHandoff = {
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  at: string;
};

export type MultiAgentStep = {
  hop: number;
  agentId: string;
  agentName: string;
  role: MultiAgentRole;
  input: string;
  output: string;
  metadata?: Record<string, unknown>;
  at: string;
};

export type MultiAgentRunStatus = "queued" | "running" | "completed" | "failed";

export type MultiAgentRun = {
  id: string;
  status: MultiAgentRunStatus;
  strategy: "supervisor";
  goal: string;
  sessionId: string;
  agents: MultiAgentSpec[];
  steps: MultiAgentStep[];
  handoffs: MultiAgentHandoff[];
  finalAnswer?: string;
  error?: string;
  maxAgentHops: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type MultiAgentRunRequest = {
  goal: string;
  sessionId?: string;
  strategy?: "supervisor";
  maxAgentHops?: number;
  agents?: Array<{
    id?: string;
    name: string;
    role?: MultiAgentRole;
    system_prompt?: string;
    systemPrompt?: string;
    model?: string;
    tools?: string[];
    task_type?: string;
    taskType?: string;
  }>;
  /** Optional collaborateWith agent ids from AgentStore */
  collaborateWith?: string[];
};

export type MultiAgentRuntimeDeps = {
  scheduler: Scheduler;
  /** Resolve registered agents by id (HTTP AgentStore) */
  resolveAgent?: (id: string) =>
    | {
        id: string;
        name: string;
        model?: string;
        systemPrompt?: string;
        tools?: string[];
      }
    | undefined;
};

const DEFAULT_MAX_HOPS = 4;

export function defaultMultiAgentTeam(): MultiAgentSpec[] {
  return [
    {
      id: "supervisor",
      name: "supervisor",
      role: "supervisor",
      systemPrompt:
        "You are the supervisor. Decompose the goal, pick the best specialist, and synthesize a final answer. Keep handoffs concise.",
      taskType: "reasoning",
    },
    {
      id: "coding",
      name: "coding_specialist",
      role: "specialist",
      systemPrompt:
        "You are a coding specialist. Prefer concrete code, tests, and tool use for implementation tasks.",
      taskType: "code_generation",
      tools: [],
    },
    {
      id: "general",
      name: "general_specialist",
      role: "specialist",
      systemPrompt: "You are a general specialist for research, explanation, and synthesis support.",
      taskType: "reasoning",
    },
  ];
}

export class MultiAgentRuntime {
  private runs = new Map<string, MultiAgentRun>();
  private deps: MultiAgentRuntimeDeps;

  constructor(deps: MultiAgentRuntimeDeps) {
    this.deps = deps;
  }

  listRuns(): MultiAgentRun[] {
    return Array.from(this.runs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): MultiAgentRun | undefined {
    return this.runs.get(id);
  }

  async start(request: MultiAgentRunRequest): Promise<MultiAgentRun> {
    const run = this.createRun(request);
    this.runs.set(run.id, run);
    try {
      await this.execute(run);
    } catch (error) {
      run.status = "failed";
      run.error = String(error);
      run.updatedAt = new Date().toISOString();
      run.completedAt = run.updatedAt;
      this.runs.set(run.id, run);
    }
    return run;
  }

  private createRun(request: MultiAgentRunRequest): MultiAgentRun {
    const now = new Date().toISOString();
    const agents = this.resolveTeam(request);
    const sessionId =
      request.sessionId?.trim() ||
      `mas_${createHash("sha1").update(`${request.goal}:${now}`).digest("hex").slice(0, 16)}`;
    return {
      id: `arun_${randomUUID()}`,
      status: "queued",
      strategy: "supervisor",
      goal: request.goal,
      sessionId,
      agents,
      steps: [],
      handoffs: [],
      maxAgentHops: Math.max(1, Math.min(request.maxAgentHops ?? DEFAULT_MAX_HOPS, 8)),
      createdAt: now,
      updatedAt: now,
    };
  }

  private resolveTeam(request: MultiAgentRunRequest): MultiAgentSpec[] {
    const fromPayload: MultiAgentSpec[] = (request.agents ?? []).map((item, index) => {
      const role: MultiAgentRole =
        item.role === "supervisor" || item.role === "specialist"
          ? item.role
          : index === 0
            ? "supervisor"
            : "specialist";
      return {
        id: item.id?.trim() || `agent_${index}`,
        name: item.name,
        role,
        systemPrompt: item.systemPrompt ?? item.system_prompt,
        model: item.model,
        tools: item.tools,
        taskType: item.taskType ?? item.task_type,
      };
    });

    for (const id of request.collaborateWith ?? []) {
      const registered = this.deps.resolveAgent?.(id);
      if (!registered) continue;
      if (fromPayload.some((a) => a.id === registered.id)) continue;
      fromPayload.push({
        id: registered.id,
        name: registered.name,
        role: "specialist",
        systemPrompt: registered.systemPrompt,
        model: registered.model,
        tools: registered.tools,
      });
    }

    if (fromPayload.length === 0) {
      return defaultMultiAgentTeam();
    }
    if (!fromPayload.some((a) => a.role === "supervisor")) {
      fromPayload.unshift(defaultMultiAgentTeam()[0]!);
    }
    return fromPayload;
  }

  private async execute(run: MultiAgentRun): Promise<void> {
    run.status = "running";
    run.updatedAt = new Date().toISOString();

    const supervisor = run.agents.find((a) => a.role === "supervisor") ?? run.agents[0]!;
    const specialists = run.agents.filter((a) => a.role === "specialist");
    const selected = this.pickSpecialist(run.goal, specialists) ?? specialists[0] ?? supervisor;

    // Hop 1: specialist work (session continuity via shared sessionId)
    const specialistInput = [
      `Goal: ${run.goal}`,
      selected.systemPrompt ? `Role: ${selected.systemPrompt}` : "",
      "Produce the best concrete result for your specialty. Be concise.",
    ]
      .filter(Boolean)
      .join("\n");

    const specialistResponse = await this.runAgent(run, selected, specialistInput, 0);
    run.handoffs.push({
      fromAgentId: supervisor.id,
      toAgentId: selected.id,
      summary: truncate(specialistResponse.content, 400),
      at: new Date().toISOString(),
    });

    let finalContent = specialistResponse.content;
    if (run.maxAgentHops > 1 && selected.id !== supervisor.id) {
      const synthInput = [
        `Original goal: ${run.goal}`,
        `Specialist (${selected.name}) result:`,
        specialistResponse.content,
        supervisor.systemPrompt ? `Supervisor role: ${supervisor.systemPrompt}` : "",
        "Synthesize the final answer for the user. Do not invent tools.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const synth = await this.runAgent(run, supervisor, synthInput, 1);
      finalContent = synth.content;
      run.handoffs.push({
        fromAgentId: selected.id,
        toAgentId: supervisor.id,
        summary: truncate(synth.content, 400),
        at: new Date().toISOString(),
      });
    }

    run.finalAnswer = finalContent;
    run.status = "completed";
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    recordAgenticRound({
      profile: selected.taskType === "code_generation" ? "coding" : "tool_heavy",
      taskType: selected.taskType,
      rounds: run.steps.length,
      toolInterrupts: run.steps.reduce(
        (acc, step) => acc + (Array.isArray(step.metadata?.toolResults) ? (step.metadata!.toolResults as unknown[]).length : 0),
        0,
      ),
      prefixChars: run.goal.length + finalContent.length,
      agentHops: run.steps.length,
    });
    this.runs.set(run.id, run);
  }

  private pickSpecialist(goal: string, specialists: MultiAgentSpec[]): MultiAgentSpec | undefined {
    if (specialists.length === 0) return undefined;
    const intent = classifyIntentSync(goal).intent;
    if (intent === "code_generation") {
      return (
        specialists.find((s) => s.taskType === "code_generation" || /code|coding/i.test(s.name)) ??
        specialists[0]
      );
    }
    return specialists.find((s) => s.taskType !== "code_generation") ?? specialists[0];
  }

  private async runAgent(
    run: MultiAgentRun,
    agent: MultiAgentSpec,
    input: string,
    hop: number,
  ): Promise<KgmResponse> {
    const metadata = enrichAgenticMetadata(
      {
        agentId: agent.id,
        agentName: agent.name,
        multi_agent_run_id: run.id,
        multi_agent_hop: hop,
        tools: agent.tools,
        mode: agent.systemPrompt ? "reasoning" : "chat",
        system_prompt_addon: agent.systemPrompt,
      },
      {
        taskType: agent.taskType,
        input,
        toolCount: agent.tools?.length ?? 0,
        sessionId: run.sessionId,
      },
    );
    const routing = enrichRoutingHints(
      agent.taskType ? { taskType: agent.taskType } : undefined,
      metadata,
    );
    const request: KgmRequest = {
      userId: run.sessionId,
      sessionId: run.sessionId,
      input,
      model: agent.model,
      metadata,
      routing,
      toolPolicy:
        agent.tools && agent.tools.length > 0
          ? { allowed: agent.tools, maxRounds: 3 }
          : undefined,
      kgm: agent.systemPrompt
        ? { playground: { extraSystemPrompt: agent.systemPrompt } }
        : undefined,
    };
    const response = await this.deps.scheduler.run(request);
    run.steps.push({
      hop,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      input,
      output: response.content,
      metadata: {
        ...response.metadata,
        toolResults: response.toolResults,
      },
      at: new Date().toISOString(),
    });
    run.updatedAt = new Date().toISOString();
    this.runs.set(run.id, run);
    return response;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
