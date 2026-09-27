import type { ContextPack, KgmRequest, KgmResponse, LlmIntent, ToolResult } from "../core/types.js";
import type { Embedder } from "../embedding/canonical.js";
import type { MemoryStore } from "../memory/store.js";
import { buildMemoryChunk } from "../memory/store.js";
import { renderPrompt } from "../prompt/renderer.js";
import { resolveCompletionIntent, toOpenAiFunctionTools } from "../parse/nativeToolCalls.js";
import { validateAgainstSchema } from "../schema/validator.js";
import type { LlmClient } from "../llm/client.js";
import { extractAutoRoutingTrace, extractResolvedModel } from "../llm/autoRoutingClient.js";
import { ToolRegistry } from "../tools/registry.js";
import type { SchemaRecord } from "../schema/registry.js";
import { SkillRuntime } from "../skills/runtime.js";
import type { ConfigStore } from "../core/configStore.js";
import { collectPlaygroundSystemAddons } from "../playground/systemAddons.js";
import type { ArtifactStore } from "../context/artifactStore.js";
import type { SessionStore } from "../context/sessionStore.js";
import { applyHaxiTagAssembly } from "../protocol/haxiTagAssembly.js";
import {
  enrichAgenticMetadata,
  enrichRoutingHints,
} from "../agentic/routingPreferences.js";
import { recordAgenticRound } from "../agentic/metrics.js";

/**
 * Scheduler resource ownership (cross-round):
 * - sessionId: owned by caller; SessionStore appends; do not rotate mid-run
 * - nativeRuntimeId / routing target: carried via request.metadata / routing for worker affinity
 * - sandbox PID / MCP connectors: owned by SandboxManager / ConfigStore.playground, not cleared per tool round
 * - toolResults: accumulated on ContextPack for prefix continuity
 */
export type SchedulerDeps = {
  contextBuilder: { build(request: KgmRequest): Promise<ContextPack> };
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  outputSchema: Record<string, unknown>;
  schemaRecord?: SchemaRecord;
  memoryStore?: MemoryStore;
  embedder?: Embedder;
  skillRuntime?: SkillRuntime;
  configStore?: ConfigStore;
  artifactStore?: ArtifactStore;
  sessionStore?: SessionStore;
};

export class Scheduler {
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  async run(initial: KgmRequest): Promise<KgmResponse> {
    const request = applyHaxiTagAssembly(initial);
    const sessionId = request.sessionId ?? request.userId;
    const toolResults: ToolResult[] = [];
    let usedNativeToolCalls = false;
    let roundsExecuted = 0;

    const metadata = enrichAgenticMetadata(request.metadata, {
      taskType: request.routing?.taskType,
      input: request.input,
      toolCount: request.toolPolicy?.allowed?.length,
      sessionId,
      nativeRuntimeId:
        typeof request.metadata?.native_runtime_id === "string"
          ? request.metadata.native_runtime_id
          : typeof request.routing?.target?.runtimeId === "string"
            ? request.routing.target.runtimeId
            : undefined,
    });
    const routing = enrichRoutingHints(request.routing, metadata);
    request.metadata = metadata;
    request.routing = routing;

    let latestRouting: Record<string, unknown> | undefined = metadata;
    if (this.deps.sessionStore) {
      this.deps.sessionStore.append(sessionId, {
        timestamp: new Date().toISOString(),
        role: "user",
        type: "input",
        content: request.input,
      });
    }

    let context = await this.deps.contextBuilder.build(request);

    const finalize = (content: string): KgmResponse => {
      if (this.deps.sessionStore) {
        this.deps.sessionStore.append(sessionId, {
          timestamp: new Date().toISOString(),
          role: "assistant",
          type: "final",
          content,
        });
      }
      const profile =
        typeof metadata.agentic_profile === "string" ? metadata.agentic_profile : "standard";
      recordAgenticRound({
        profile,
        taskType: routing.taskType,
        rounds: roundsExecuted,
        toolInterrupts: toolResults.length,
        prefixChars: request.input.length + content.length,
        usedNativeToolCalls,
      });
      return {
        requestId: context.requestId,
        type: "final",
        content,
        toolResults,
        metadata:
          latestRouting && Object.keys(latestRouting).length > 0
            ? {
                ...latestRouting,
                session_id: sessionId,
                session_continuity: true,
                intent_source: usedNativeToolCalls ? "native_tool_calls" : latestRouting.intent_source,
              }
            : undefined,
      };
    };

    for (let round = 0; round < context.toolPolicy.maxRounds; round += 1) {
      roundsExecuted = round + 1;
      const tools = this.deps.toolRegistry.listDefinitions(context.toolPolicy.allowed);
      const cfg = this.deps.configStore?.get();
      const systemPromptAddons = cfg
        ? [
            ...collectPlaygroundSystemAddons(cfg),
            ...(request.kgm?.playground?.extraSystemPrompt?.trim()
              ? [request.kgm.playground.extraSystemPrompt.trim()]
              : []),
            ...(typeof metadata.system_prompt_addon === "string" && metadata.system_prompt_addon.trim()
              ? [metadata.system_prompt_addon.trim()]
              : []),
          ]
        : [
            ...(request.kgm?.playground?.extraSystemPrompt?.trim()
              ? [request.kgm.playground.extraSystemPrompt.trim()]
              : []),
            ...(typeof metadata.system_prompt_addon === "string" && metadata.system_prompt_addon.trim()
              ? [metadata.system_prompt_addon.trim()]
              : []),
          ];
      const prompt = renderPrompt({
        context,
        tools,
        outputSchema: this.deps.outputSchema,
        toolDescriptorMode: this.deps.configStore?.get().context.toolDescriptorMode ?? "full",
        skillNames: this.deps.skillRuntime?.listNames(),
        includeSkillNames: this.deps.configStore?.get().context.includeSkillNames ?? true,
        systemPromptAddons,
      });

      const completion = await this.deps.llmClient.complete(prompt, {
        model: request.model,
        requestId: context.requestId,
        sessionId,
        maxTokens: context.constraints.maxTokens ?? 512,
        metadata,
        taskInput: request.input,
        taskType: routing.taskType,
        taskName: routing.taskName,
        routing,
        tools: tools.length > 0 ? toOpenAiFunctionTools(tools) : undefined,
        toolChoice: tools.length > 0 ? "auto" : undefined,
      });
      latestRouting = {
        ...metadata,
        ...(extractAutoRoutingTrace(completion.raw) ? { routing: extractAutoRoutingTrace(completion.raw) } : {}),
        ...(extractResolvedModel(completion.raw) ? { resolved_model: extractResolvedModel(completion.raw) } : {}),
      };
      const routingTrace = extractAutoRoutingTrace(completion.raw);
      if (routingTrace?.selected?.runtimeId && typeof latestRouting.native_runtime_id !== "string") {
        latestRouting.native_runtime_id = routingTrace.selected.runtimeId;
        // Keep affinity for subsequent tool rounds
        metadata.native_runtime_id = routingTrace.selected.runtimeId;
        request.metadata = metadata;
        if (!request.routing) request.routing = {};
        request.routing.target = {
          ...(request.routing.target ?? {}),
          runtimeId: routingTrace.selected.runtimeId,
        };
      }
      const resolved = resolveCompletionIntent(completion, {
        skillNames: this.deps.skillRuntime?.listNames(),
      });
      if (resolved.source === "native_tool_calls") {
        usedNativeToolCalls = true;
      }
      latestRouting.intent_source = resolved.source;
      const intent = resolved.intent;
      if (this.deps.schemaRecord) {
        const validation = validateAgainstSchema(this.deps.schemaRecord.schema, intent);
        if (!validation.ok) {
          return finalize(`schema_validation_failed:${validation.errors.join("|")}`);
        }
      }

      if (intent.type === "final") {
        return finalize(intent.content);
      }

      const toolResult = await this.executeIntent(intent, context);
      if (!toolResult) {
        return finalize("policy_reject");
      }
      toolResults.push(toolResult);
      // Keep same sessionId / request metadata for prefix continuity across tool rounds
      context = await this.appendToolResult(context, toolResult, sessionId);
    }

    return finalize("max_rounds_reached");
  }

  private async executeIntent(intent: LlmIntent, context: ContextPack): Promise<ToolResult | null> {
    if (intent.type === "call") {
      if (!context.toolPolicy.allowed.includes(intent.target)) {
        return null;
      }
      try {
        const output = await this.deps.toolRegistry.execute(intent.target, intent.arguments);
        return { name: intent.target, output, success: true };
      } catch (error) {
        return { name: intent.target, output: {}, success: false, error: String(error) };
      }
    }

    if (intent.type === "invoke_skill") {
      if (!this.deps.skillRuntime) {
        return { name: intent.skill, output: {}, success: false, error: "skill_runtime_missing" };
      }
      try {
        const output = await this.deps.skillRuntime.run(intent.skill, intent.input);
        return { name: intent.skill, output, success: true };
      } catch (error) {
        return { name: intent.skill, output: {}, success: false, error: String(error) };
      }
    }

    return null;
  }

  private async appendToolResult(
    context: ContextPack,
    toolResult: ToolResult,
    sessionId?: string,
  ): Promise<ContextPack> {
    const contextToolResult = this.buildContextToolResult(toolResult, context);
    const updated: ContextPack = {
      ...context,
      toolResults: [...context.toolResults, contextToolResult],
    };

    if (this.deps.memoryStore && this.deps.embedder && toolResult.success) {
      const summary = JSON.stringify(contextToolResult.output);
      const embedding = await this.deps.embedder.embed(summary);
      await this.deps.memoryStore.add(
        buildMemoryChunk({
          id: `${context.requestId}_${toolResult.name}_${context.toolResults.length}`,
          userId: context.userId,
          text: summary,
          embedding,
          source: `tool:${toolResult.name}`,
          embeddingVersion: this.deps.configStore?.get().embedding.version,
        })
      );
    }

    if (this.deps.sessionStore && sessionId) {
      this.deps.sessionStore.append(sessionId, {
        timestamp: new Date().toISOString(),
        role: "tool",
        type: "tool",
        name: toolResult.name,
        output: contextToolResult.output,
      });
    }

    return updated;
  }

  private buildContextToolResult(toolResult: ToolResult, context: ContextPack): ToolResult {
    const config = this.deps.configStore?.get().context;
    const maxChars = config?.maxToolOutputChars ?? 2000;
    const previewChars = config?.artifactPreviewChars ?? 240;

    const normalizedOutput =
      toolResult.output && typeof toolResult.output === "object" && !Array.isArray(toolResult.output)
        ? toolResult.output
        : { value: toolResult.output };

    const outputJson = JSON.stringify(normalizedOutput);
    if (!this.deps.artifactStore || outputJson.length <= maxChars) {
      return { ...toolResult, output: normalizedOutput };
    }

    const artifact = this.deps.artifactStore.writeJson(
      `tool_${context.requestId}_${toolResult.name}`,
      normalizedOutput,
      previewChars,
    );

    return {
      ...toolResult,
      output: {
        summary: outputJson.slice(0, maxChars),
        artifact_ref: artifact,
      },
    };
  }
}
