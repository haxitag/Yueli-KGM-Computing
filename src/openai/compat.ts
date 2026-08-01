import type { ConfigStore } from "../core/configStore.js";
import type {
  ConversationMessage,
  KgmExtensions,
  KgmRequest,
  RoutingHints,
  ToolDefinition,
  ToolResult,
} from "../core/types.js";
import type { ContextBuilder } from "../context/contextBuilder.js";
import { streamCompletion } from "../llm/client.js";
import type { CompletionResult, LlmClient } from "../llm/client.js";
import { extractAutoRoutingTrace, extractResolvedModel } from "../llm/autoRoutingClient.js";
import { parseIntent } from "../parse/parser.js";
import { resolveCompletionIntent, toOpenAiFunctionTools } from "../parse/nativeToolCalls.js";
import {
  enrichAgenticMetadata,
  enrichRoutingHints,
} from "../agentic/routingPreferences.js";
import { recordAgenticRound } from "../agentic/metrics.js";
import {
  buildKgmRequestPerf,
  enrichUsageWithCache,
  extractCachedTokensFromUsage,
  type KgmRequestPerf,
} from "../agentic/requestStats.js";
import { renderPrompt } from "../prompt/renderer.js";
import type { OpenAiResponseStore } from "./responseStore.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { collectPlaygroundSystemAddons } from "../playground/systemAddons.js";
import type { ToolRegistry } from "../tools/registry.js";
import { generateId } from "../utils/id.js";
import { resolveRequestTraceIds } from "../observability/requestTrace.js";
import type { ManagedModelManager } from "../models/modelManager.js";
import type { MaaSOpenAiChatExtras } from "../llm/maas/types.js";
import { extractMaaSOpenAiExtras } from "../llm/maas/reasoning.js";
import type { CompletionOptions } from "../llm/client.js";
import { applyHaxiTagAssembly } from "../protocol/haxiTagAssembly.js";
import { extractStructuredCompletion, mergeUsageWithEstimates } from "../llm/completionNormalize.js";
import { annotateOpenAiModels, appendConfiguredMediaModels } from "../models/modelTypeAnnotator.js";
import { maybeNormalizeCompatOutput } from "../output/gfmNormalize.js";

type OpenAiToolCall = {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAiMessageContentPart =
  | { type: "text" | "input_text" | "output_text"; text?: string }
  | { type: "image_url"; image_url?: { url?: string } | string }
  | { type: string; [key: string]: unknown };

export type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAiMessageContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
};

export type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};

export type OpenAiToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type OpenAiChatCompletionRequest = {
  model?: string;
  messages: OpenAiChatMessage[];
  tools?: OpenAiToolDefinition[];
  tool_choice?: OpenAiToolChoice;
  user?: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  metadata?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
  response_format?: Record<string, unknown>;
  stream?: boolean;
  kgm?: KgmExtensions;
  routing?: RoutingHints;
} & MaaSOpenAiChatExtras;

export type OpenAiResponsesInputItem = {
  type?: string;
  role?: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAiMessageContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  call_id?: string;
  output?: string | Record<string, unknown>;
};

export type OpenAiResponsesRequest = {
  model?: string;
  input?: string | OpenAiResponsesInputItem[] | OpenAiChatMessage[];
  instructions?: string;
  tools?: OpenAiToolDefinition[];
  tool_choice?: OpenAiToolChoice;
  previous_response_id?: string;
  user?: string;
  metadata?: Record<string, unknown>;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
  kgm?: KgmExtensions;
  routing?: RoutingHints;
} & MaaSOpenAiChatExtras;

type CompatibilityToolTrace = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson: string;
  executed: boolean;
  output?: Record<string, unknown>;
  error?: string;
};

type CompatibilityRun = {
  requestId: string;
  model: string;
  created: number;
  responseId: string;
  completionId: string;
  metadata: Record<string, unknown>;
  kgm: KgmExtensions & {
    compatibility: Record<string, unknown>;
    tool_trace: CompatibilityToolTrace[];
    correlation?: { requestId: string; traceId: string };
    perf?: KgmRequestPerf;
  };
  finalText: string;
  reasoningText?: string;
  finishReason: "stop" | "tool_calls";
  toolCalls: CompatibilityToolTrace[];
  usage: Record<string, number>;
  conversation: ConversationMessage[];
};

export function buildOpenAiModelList(
  configStore: ConfigStore,
  modelManager?: ManagedModelManager,
  options?: {
    configuredOnly?: boolean;
    configuredProviders?: import("../llm/providerFactory.js").ProviderConfig[];
  },
) {
  const llm = configStore.get().llm;
  const data = modelManager?.listOpenAiModels(llm.model, llm.provider, {
    configuredOnly: options?.configuredOnly,
    configuredProviders: options?.configuredProviders,
  }) ?? [
    {
      id: llm.model,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: llm.provider,
    },
  ];
  return {
    object: "list",
    data: annotateOpenAiModels(
      appendConfiguredMediaModels(
        [
          {
            id: "auto",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "kgm",
          },
          ...data,
        ],
        configStore,
      ),
    ),
  };
}

/**
 * Resolve request model for orchestration.
 * `auto` / empty / missing → `undefined` so AutoRouting can score-select.
 * Explicit ids are passed through (alias resolution happens in AutoRouting).
 */
export function resolveRequestedModel(model: string | undefined, _configStore?: ConfigStore): string | undefined {
  if (model == null) return undefined;
  const trimmed = model.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;
  return trimmed;
}

/** Display / mock fallback when routing has not yet selected a concrete model. */
function resolveDisplayModel(model: string | undefined, configStore: ConfigStore): string {
  return model ?? configStore.get().llm.model;
}

function isMockMode(): boolean {
  return process.env.KGM_MOCK_MODE === "1";
}

function createMockChatCompletion(request: OpenAiChatCompletionRequest, configStore: ConfigStore): Record<string, unknown> {
  const requestId = generateId();
  const created = Math.floor(Date.now() / 1000);
  const model = resolveDisplayModel(resolveRequestedModel(request.model, configStore), configStore);
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    metadata: request.metadata ?? {},
    kgm: { mock: true, reason: "KGM_MOCK_MODE=1" },
  };
}

function createMockResponse(request: OpenAiResponsesRequest, configStore: ConfigStore): Record<string, unknown> {
  const requestId = generateId();
  const created = Math.floor(Date.now() / 1000);
  const model = resolveDisplayModel(resolveRequestedModel(request.model, configStore), configStore);
  return {
    id: `resp_${requestId}`,
    object: "response",
    created,
    model,
    status: "completed",
    output: [
      {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    output_text: "ok",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    metadata: request.metadata ?? {},
    kgm: { mock: true, reason: "KGM_MOCK_MODE=1" },
  };
}

async function* streamMockChatCompletion(request: OpenAiChatCompletionRequest, configStore: ConfigStore): AsyncIterable<string> {
  const body = createMockChatCompletion(request, configStore);
  yield JSON.stringify({
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
  });
  yield JSON.stringify({
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: body.usage,
    metadata: body.metadata,
    kgm: body.kgm,
  });
}

async function* streamMockResponse(request: OpenAiResponsesRequest, configStore: ConfigStore): AsyncIterable<string> {
  const body = createMockResponse(request, configStore);
  yield JSON.stringify({ type: "response.created", response: { id: body.id, object: "response", created: body.created, model: body.model, status: "in_progress" } });
  yield JSON.stringify({ type: "response.output_text.delta", delta: "ok" });
  yield JSON.stringify({ type: "response.completed", response: body });
}

export async function createOpenAiChatCompletion(params: CompatibilityParams & {
  request: OpenAiChatCompletionRequest;
}): Promise<Record<string, unknown>> {
  if (isMockMode()) {
    return createMockChatCompletion(params.request, params.configStore);
  }
  const run = await executeCompatibilityRun({
    ...params,
    model: params.request.model,
    messages: normalizeMessages(params.request.messages),
    tools: params.request.tools,
    toolChoice: params.request.tool_choice,
    user: params.request.user,
    metadata: params.request.metadata,
    temperature: params.request.temperature,
    maxTokens: params.request.max_completion_tokens ?? params.request.max_tokens,
    responseFormat: params.request.response_format,
    kgm: params.request.kgm,
    routing: params.request.routing,
    protocol: "chat.completions",
    previousResponseId: undefined,
    parallel_tool_calls: params.request.parallel_tool_calls,
    thinking: params.request.thinking,
    enable_thinking: params.request.enable_thinking,
    reasoning_effort: params.request.reasoning_effort,
    output_config: params.request.output_config,
  });

  const message: Record<string, unknown> = {
    role: "assistant",
    content: run.finalText || null,
  };
  if (run.reasoningText?.trim()) {
    message.reasoning_content = run.reasoningText;
  }
  if (run.toolCalls.length > 0) {
    message.tool_calls = run.toolCalls.map(toOpenAiToolCall);
  }

  return {
    id: run.completionId,
    object: "chat.completion",
    created: run.created,
    model: run.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: run.finishReason,
      },
    ],
    usage: run.usage,
    metadata: run.metadata,
    kgm: run.kgm,
  };
}

function spreadMaaSFieldsFromRequest(
  req: MaaSOpenAiChatExtras & { parallel_tool_calls?: boolean },
): Pick<
  ExecuteParams,
  "parallel_tool_calls" | "thinking" | "enable_thinking" | "reasoning_effort" | "output_config"
> {
  return {
    parallel_tool_calls: req.parallel_tool_calls,
    thinking: req.thinking,
    enable_thinking: req.enable_thinking,
    reasoning_effort: req.reasoning_effort,
    output_config: req.output_config,
  };
}

export async function createOpenAiResponse(params: CompatibilityParams & {
  request: OpenAiResponsesRequest;
}): Promise<Record<string, unknown>> {
  if (isMockMode()) {
    return createMockResponse(params.request, params.configStore);
  }
  const run = await executeCompatibilityRun({
    ...params,
    model: params.request.model,
    messages: normalizeResponsesInput(params.request.input, params.request.instructions, params.request.previous_response_id, params.responseStore),
    tools: params.request.tools,
    toolChoice: params.request.tool_choice,
    user: params.request.user,
    metadata: params.request.metadata,
    temperature: params.request.temperature,
    maxTokens: params.request.max_output_tokens ?? params.request.max_completion_tokens,
    responseFormat: undefined,
    kgm: params.request.kgm,
    routing: params.request.routing,
    protocol: "responses",
    previousResponseId: params.request.previous_response_id,
    ...spreadMaaSFieldsFromRequest(params.request),
  });

  return buildResponsesObject(run);
}

export function streamOpenAiChatCompletion(params: CompatibilityParams & {
  request: OpenAiChatCompletionRequest;
}): AsyncIterable<string> {
  if (isMockMode()) {
    return streamMockChatCompletion(params.request, params.configStore);
  }
  return streamChatCompletionChunks({
    ...params,
    model: params.request.model,
    messages: normalizeMessages(params.request.messages),
    tools: params.request.tools,
    toolChoice: params.request.tool_choice,
    user: params.request.user,
    metadata: params.request.metadata,
    temperature: params.request.temperature,
    maxTokens: params.request.max_completion_tokens ?? params.request.max_tokens,
    responseFormat: params.request.response_format,
    kgm: params.request.kgm,
    routing: params.request.routing,
    protocol: "chat.completions",
    previousResponseId: undefined,
    ...spreadMaaSFieldsFromRequest(params.request),
  });
}

export function streamOpenAiResponse(params: CompatibilityParams & {
  request: OpenAiResponsesRequest;
}): AsyncIterable<string> {
  if (isMockMode()) {
    return streamMockResponse(params.request, params.configStore);
  }
  return streamResponsesChunks({
    ...params,
    model: params.request.model,
    messages: normalizeResponsesInput(params.request.input, params.request.instructions, params.request.previous_response_id, params.responseStore),
    tools: params.request.tools,
    toolChoice: params.request.tool_choice,
    user: params.request.user,
    metadata: params.request.metadata,
    temperature: params.request.temperature,
    maxTokens: params.request.max_output_tokens ?? params.request.max_completion_tokens,
    responseFormat: undefined,
    kgm: params.request.kgm,
    routing: params.request.routing,
    protocol: "responses",
    previousResponseId: params.request.previous_response_id,
    ...spreadMaaSFieldsFromRequest(params.request),
  });
}

type CompatibilityParams = {
  contextBuilder: ContextBuilder;
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  configStore: ConfigStore;
  outputSchema: Record<string, unknown>;
  responseStore: OpenAiResponseStore;
  skillRuntime?: SkillRuntime;
  /** 来自 HTTP 的请求头，用于 X-KGM-Output-Normalize 等 */
  requestHeaders?: Record<string, string | string[] | undefined>;
};

type ExecuteParams = CompatibilityParams & {
  model?: string;
  messages: ConversationMessage[];
  tools?: OpenAiToolDefinition[];
  toolChoice?: OpenAiToolChoice;
  user?: string;
  metadata?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  kgm?: KgmExtensions;
  routing?: RoutingHints;
  protocol: "chat.completions" | "responses";
  previousResponseId?: string;
  parallel_tool_calls?: boolean;
} & MaaSOpenAiChatExtras;

function buildMaaSCompletionOptions(
  params: ExecuteParams,
  base: Omit<CompletionOptions, keyof MaaSOpenAiChatExtras>,
): CompletionOptions {
  const extras = extractMaaSOpenAiExtras(params as unknown as Record<string, unknown>);
  return {
    ...base,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
      name: m.name,
      tool_call_id: m.toolCallId,
    })),
    tools: params.tools,
    toolChoice: params.toolChoice,
    parallelToolCalls: params.parallel_tool_calls,
    responseFormat: params.responseFormat,
    thinking: params.thinking ?? extras.thinking,
    enableThinking: params.enable_thinking ?? extras.enable_thinking,
    reasoningEffort: params.reasoning_effort ?? extras.reasoning_effort,
    outputConfig: params.output_config ?? extras.output_config,
    maasExtras: extras,
  };
}

type DirectStreamSetup = {
  requestId: string;
  created: number;
  /** Response/SSE display model (never empty). */
  model: string;
  /** Passed to AutoRouting; undefined = dynamic selection. */
  routingModel?: string;
  responseId: string;
  completionId: string;
  metadata: Record<string, unknown>;
  kgm: KgmExtensions & {
    compatibility: Record<string, unknown>;
    tool_trace: CompatibilityToolTrace[];
    correlation?: { requestId: string; traceId: string };
  };
  prompt: string;
  promptTokens: number;
  conversation: ConversationMessage[];
  startedAtMs: number;
};

async function executeCompatibilityRun(params: ExecuteParams): Promise<CompatibilityRun> {
  const ids = resolveRequestTraceIds({
    headers: params.requestHeaders,
    body: {
      kgm: params.kgm,
      metadata: params.metadata,
    },
  });
  const requestId = ids.requestId;
  const created = Math.floor(Date.now() / 1000);
  const config = params.configStore.get();
  const model = resolveRequestedModel(params.model, params.configStore);
  let resolvedModel = resolveDisplayModel(model, params.configStore);
  const kgm = normalizeKgmExtensions(requestId, {
    ...params.kgm,
    ops: {
      ...(params.kgm?.ops ?? {}),
      traceId: ids.traceId,
    },
  });
  const availableTools = resolveTools(params.tools, params.toolRegistry, kgm);
  const effectiveTools = params.toolChoice === "none" ? [] : applyToolChoice(availableTools, params.toolChoice);
  const executeToolCalls = kgm.capabilities?.executeToolCalls ?? true;
  const conversation = [...params.messages];
  const traces: CompatibilityToolTrace[] = [];
  const aggregatedToolResults: ToolResult[] = [];
  let latestRoutingTrace = undefined as ReturnType<typeof extractAutoRoutingTrace> | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalText = "";
  let finishReason: "stop" | "tool_calls" = "stop";
  let usedNativeToolCalls = false;
  let roundsExecuted = 0;
  let cachedTokensTotal = 0;
  const startedAtMs = Date.now();
  let firstTokenAtMs: number | undefined;

  const sessionId =
    deriveSessionId(params.metadata) ??
    (typeof params.user === "string" && params.user.trim() ? params.user : `compat_${requestId}`);
  const agenticMetadata = enrichAgenticMetadata(params.metadata, {
    taskType: params.routing?.taskType,
    input: extractLatestUserInput(conversation),
    toolCount: effectiveTools.length,
    sessionId,
  });
  const agenticRouting = enrichRoutingHints(params.routing, agenticMetadata);

  for (let round = 0; round < 3; round += 1) {
    roundsExecuted = round + 1;
    const runtimeRequest: KgmRequest = applyHaxiTagAssembly({
      requestId,
      userId: params.user ?? "openai_compat",
      sessionId,
      input: extractLatestUserInput(conversation),
      model,
      conversation,
      constraints: {
        maxTokens: params.maxTokens,
        style: deriveStyle(params.responseFormat),
      },
      toolPolicy: {
        allowed: effectiveTools.map((tool) => tool.name),
        maxRounds: 1,
      },
      metadata: agenticMetadata,
      kgm,
      routing: agenticRouting,
    });

    const context = await params.contextBuilder.build(runtimeRequest);
    // Session/prefix continuity: carry tool results across rounds on the same sessionId
    context.toolResults = [...aggregatedToolResults];
    const systemPromptAddons = [
      ...collectPlaygroundSystemAddons(config),
      ...(params.kgm?.playground?.extraSystemPrompt?.trim()
        ? [params.kgm.playground.extraSystemPrompt.trim()]
        : []),
    ];
    const prompt = renderPrompt({
      context,
      tools: effectiveTools,
      outputSchema: params.outputSchema,
      toolDescriptorMode: config.context.toolDescriptorMode,
      skillNames: params.skillRuntime?.listNames(),
      includeSkillNames: config.context.includeSkillNames,
      systemPromptAddons,
    });
    const openAiTools =
      effectiveTools.length > 0
        ? (params.tools?.length ? params.tools : toOpenAiFunctionTools(effectiveTools))
        : undefined;
    const completion = await params.llmClient.complete(prompt, buildMaaSCompletionOptions({
      ...params,
      tools: openAiTools,
      toolChoice: params.toolChoice ?? (openAiTools ? "auto" : undefined),
    }, {
      model,
      requestId,
      sessionId,
      maxTokens: params.maxTokens,
      temperature: params.temperature ?? config.llm.temperature,
      metadata: agenticMetadata,
      taskInput: runtimeRequest.input,
      taskType: agenticRouting.taskType,
      taskName: agenticRouting.taskName,
      routing: agenticRouting,
    }));
    latestRoutingTrace = extractAutoRoutingTrace(completion.raw);
    if (firstTokenAtMs == null) {
      firstTokenAtMs = Date.now();
    }
    resolvedModel = extractResolvedModel(completion.raw) ?? resolvedModel;
    const structuredRound = extractStructuredCompletion(completion.raw, config.llm.provider);
    const rawUsage =
      completion.raw && typeof completion.raw === "object"
        ? (completion.raw as { usage?: unknown }).usage
        : undefined;
    const cachedRound = extractCachedTokensFromUsage(rawUsage);
    if (cachedRound != null) {
      cachedTokensTotal += cachedRound;
    }
    const roundUsage = mergeUsageWithEstimates(
      structuredRound,
      estimateTokens(prompt),
      estimateTokens(completion.text),
    );
    promptTokens += roundUsage.prompt_tokens;
    completionTokens += roundUsage.completion_tokens;
    const resolved = resolveCompletionIntent(completion, {
      skillNames: params.skillRuntime?.listNames(),
    });
    if (resolved.source === "native_tool_calls") {
      usedNativeToolCalls = true;
    }
    const intent = resolved.intent;

    if (intent.type === "final") {
      finalText = intent.content;
      finishReason = "stop";
      conversation.push({ role: "assistant", content: finalText });
      break;
    }

    if (intent.type === "call" && effectiveTools.some((tool) => tool.name === intent.target)) {
      const trace = buildToolTrace(intent.target, intent.arguments ?? {});
      traces.push(trace);

      if (!executeToolCalls || !canExecuteToolCall(intent.target, params.toolRegistry)) {
        finishReason = "tool_calls";
        conversation.push({
          role: "assistant",
          content: `${trace.name}(${trace.argumentsJson})`,
          toolCallId: trace.id,
        });
        break;
      }

      try {
        const output = await params.toolRegistry.execute(intent.target, intent.arguments ?? {});
        trace.executed = true;
        trace.output = output;
        aggregatedToolResults.push({
          name: trace.name,
          output,
          success: true,
        });
        conversation.push({
          role: "assistant",
          content: `${trace.name}(${trace.argumentsJson})`,
          toolCallId: trace.id,
        });
        conversation.push({
          role: "tool",
          name: trace.name,
          toolCallId: trace.id,
          content: JSON.stringify(output),
        });
        continue;
      } catch (error) {
        trace.executed = true;
        trace.error = String(error);
        aggregatedToolResults.push({
          name: trace.name,
          output: {},
          success: false,
          error: trace.error,
        });
        finishReason = "tool_calls";
        break;
      }
    }

    if (intent.type === "invoke_skill" && params.skillRuntime) {
      const trace = buildToolTrace(intent.skill, intent.input ?? {});
      traces.push(trace);
      if (!executeToolCalls) {
        finishReason = "tool_calls";
        conversation.push({
          role: "assistant",
          content: `invoke_skill(${intent.skill})`,
          toolCallId: trace.id,
        });
        break;
      }
      try {
        const output = await params.skillRuntime.run(intent.skill, intent.input ?? {});
        trace.executed = true;
        trace.output = output;
        aggregatedToolResults.push({ name: intent.skill, output, success: true });
        conversation.push({
          role: "assistant",
          content: `invoke_skill(${intent.skill})`,
          toolCallId: trace.id,
        });
        conversation.push({
          role: "tool",
          name: intent.skill,
          toolCallId: trace.id,
          content: JSON.stringify(output),
        });
        continue;
      } catch (error) {
        trace.executed = true;
        trace.error = String(error);
        aggregatedToolResults.push({
          name: intent.skill,
          output: {},
          success: false,
          error: trace.error,
        });
        finishReason = "tool_calls";
        break;
      }
    }

    finalText = completion.text;
    finishReason = "stop";
    conversation.push({ role: "assistant", content: finalText });
    break;
  }

  if (!finalText && finishReason === "stop") {
    finalText = "max_rounds_reached";
  }

  recordAgenticRound({
    profile: typeof agenticMetadata.agentic_profile === "string" ? agenticMetadata.agentic_profile : "standard",
    taskType: agenticRouting.taskType,
    rounds: roundsExecuted,
    toolInterrupts: traces.length,
    prefixChars: extractLatestUserInput(conversation).length + finalText.length,
    firstTokenMs: firstTokenAtMs != null ? firstTokenAtMs - startedAtMs : undefined,
    usedNativeToolCalls,
  });

  finalText = maybeNormalizeCompatOutput(
    finalText,
    kgm,
    agenticMetadata,
    params.requestHeaders,
  );

  const finishedAtMs = Date.now();
  const runtimeKind =
    typeof latestRoutingTrace?.selected?.provider === "string"
      ? latestRoutingTrace.selected.provider
      : undefined;
  const perf = buildKgmRequestPerf({
    startedAtMs,
    firstTokenAtMs,
    finishedAtMs,
    promptTokens,
    completionTokens,
    cachedTokens: cachedTokensTotal > 0 ? cachedTokensTotal : undefined,
    toolRounds: traces.length,
    intentSource: usedNativeToolCalls ? "native_tool_calls" : "text_json",
    agenticProfile:
      typeof agenticMetadata.agentic_profile === "string" ? agenticMetadata.agentic_profile : undefined,
    runtimeKind,
  });

  const responseId = `resp_${requestId}`;
  const completionId = `chatcmpl_${requestId}`;
  params.responseStore.save({
    id: responseId,
    requestId,
    model: resolvedModel,
    conversation,
    metadata: agenticMetadata,
  });

  const usageBase = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  const usageEnriched = enrichUsageWithCache(usageBase, perf.cachedTokens);

  return {
    requestId,
    model: resolvedModel,
    created,
    responseId,
    completionId,
    metadata: {
      ...agenticMetadata,
      session_id: sessionId,
      session_continuity: true,
      intent_source: usedNativeToolCalls ? "native_tool_calls" : "text_json",
    },
    kgm: {
      ...kgm,
      correlation: {
        requestId,
        traceId: kgm.ops?.traceId ?? requestId,
      },
      compatibility: {
        protocol: params.protocol,
        toolExecution: executeToolCalls ? "server" : "external",
        builtinToolsIncluded: Boolean(kgm.capabilities?.includeBuiltinTools),
        previousResponseId: params.previousResponseId,
        finish_reason: finishReason,
        intent_source: usedNativeToolCalls ? "native_tool_calls" : "text_json",
        ...(latestRoutingTrace
          ? {
              autoRouting: latestRoutingTrace as unknown as Record<string, unknown>,
              routing: {
                provider: latestRoutingTrace.selected.provider,
                baseUrlHost: latestRoutingTrace.selected.baseUrlHost,
                routeKey: latestRoutingTrace.selected.routeKey,
              },
            }
          : {}),
      },
      tool_trace: traces,
      perf,
      ...(latestRoutingTrace
        ? {
            autoRouting: latestRoutingTrace as unknown as Record<string, unknown>,
            routing: {
              provider: latestRoutingTrace.selected.provider,
              baseUrlHost: latestRoutingTrace.selected.baseUrlHost,
              routeKey: latestRoutingTrace.selected.routeKey,
            },
          }
        : {}),
    },
    finalText,
    finishReason,
    toolCalls: traces,
    usage: (usageEnriched ?? usageBase) as Record<string, number>,
    conversation,
  };
}

async function *streamChatCompletionChunks(params: ExecuteParams): AsyncIterable<string> {
  const direct = await prepareDirectStream(params);
  if (!direct) {
    const run = await executeCompatibilityRun(params);
    yield* replayChatCompletionRun(run);
    return;
  }

  let emittedPreamble = false;
  const emitPreamble = function* () {
    if (emittedPreamble) return;
    emittedPreamble = true;
    yield JSON.stringify({
      id: direct.completionId,
      object: "chat.completion.chunk",
      created: direct.created,
      model: direct.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  };

  let rawOutput = "";
  let streamedContent = "";
  let streamedReasoning = "";
  let finalResult: CompletionResult | undefined;
  let activeModel = direct.model;
  for await (const event of streamCompletion(params.llmClient, direct.prompt, buildMaaSCompletionOptions(params, {
    model: direct.routingModel,
    requestId: direct.requestId,
    sessionId: deriveSessionId(params.metadata),
    maxTokens: params.maxTokens,
    temperature: params.temperature ?? params.configStore.get().llm.temperature,
    metadata: params.metadata,
    taskInput: extractLatestUserInput(direct.conversation),
    taskType: params.routing?.taskType,
    taskName: params.routing?.taskName,
    routing: params.routing,
  }))) {
    if (event.type === "started" && event.model) {
      activeModel = event.model;
      yield* emitPreamble();
      continue;
    }
    if (event.type === "token" && event.text) {
      yield* emitPreamble();
      rawOutput += event.text;
      if (event.channel === "reasoning") {
        streamedReasoning += event.text;
        yield JSON.stringify({
          id: direct.completionId,
          object: "chat.completion.chunk",
          created: direct.created,
          model: activeModel,
          choices: [
            { index: 0, delta: { reasoning_content: event.text }, finish_reason: null },
          ],
        });
        continue;
      }
      const delta = extractFinalContentDelta(rawOutput, streamedContent);
      if (!delta) {
        continue;
      }
      streamedContent += delta;
      yield JSON.stringify({
        id: direct.completionId,
        object: "chat.completion.chunk",
        created: direct.created,
        model: activeModel,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      });
      continue;
    }
    if (event.type === "finished") {
      yield* emitPreamble();
      finalResult = event.result;
    }
  }

  yield* emitPreamble();
  const finalized = finalizeDirectStream(
    direct,
    rawOutput,
    streamedContent,
    finalResult,
    params.responseStore,
    { kgm: params.kgm, metadata: params.metadata, requestHeaders: params.requestHeaders },
    streamedReasoning,
  );
  finalized.model = extractResolvedModel(finalResult?.raw) ?? activeModel;
  const routingTrace = extractAutoRoutingTrace(finalResult?.raw);
  if (routingTrace?.selected) {
    finalized.kgm = {
      ...finalized.kgm,
      autoRouting: routingTrace as unknown as Record<string, unknown>,
      routing: {
        provider: routingTrace.selected.provider,
        baseUrlHost: routingTrace.selected.baseUrlHost,
        routeKey: routingTrace.selected.routeKey,
        failureReason: routingTrace.selected.failureReason,
      },
    };
  }
  if (finalized.finalText.length > streamedContent.length) {
    const trailing = finalized.finalText.slice(streamedContent.length);
    if (trailing) {
      yield JSON.stringify({
        id: finalized.completionId,
        object: "chat.completion.chunk",
        created: finalized.created,
        model: finalized.model,
        choices: [{ index: 0, delta: { content: trailing }, finish_reason: null }],
      });
    }
  }
  yield JSON.stringify({
    id: finalized.completionId,
    object: "chat.completion.chunk",
    created: finalized.created,
    model: finalized.model,
    choices: [{ index: 0, delta: {}, finish_reason: finalized.finishReason }],
    usage: finalized.usage,
    metadata: finalized.metadata,
    kgm: finalized.kgm,
  });
}

async function *streamResponsesChunks(params: ExecuteParams): AsyncIterable<string> {
  const direct = await prepareDirectStream(params);
  if (!direct) {
    const run = await executeCompatibilityRun(params);
    yield* replayResponsesRun(run);
    return;
  }

  let emittedCreated = false;
  const emitCreated = function* () {
    if (emittedCreated) return;
    emittedCreated = true;
    yield JSON.stringify({
      type: "response.created",
      response: {
        id: direct.responseId,
        object: "response",
        created: direct.created,
        model: direct.model,
        status: "in_progress",
      },
    });
  };

  let rawOutput = "";
  let streamedContent = "";
  let streamedReasoning = "";
  let finalResult: CompletionResult | undefined;
  let activeModel = direct.model;
  for await (const event of streamCompletion(params.llmClient, direct.prompt, buildMaaSCompletionOptions(params, {
    model: direct.routingModel,
    requestId: direct.requestId,
    sessionId: deriveSessionId(params.metadata),
    maxTokens: params.maxTokens,
    temperature: params.temperature ?? params.configStore.get().llm.temperature,
    metadata: params.metadata,
    taskInput: extractLatestUserInput(direct.conversation),
    taskType: params.routing?.taskType,
    taskName: params.routing?.taskName,
    routing: params.routing,
  }))) {
    if (event.type === "started" && event.model) {
      activeModel = event.model;
      yield* emitCreated();
      continue;
    }
    if (event.type === "token" && event.text) {
      yield* emitCreated();
      rawOutput += event.text;
      if (event.channel === "reasoning") {
        streamedReasoning += event.text;
        yield JSON.stringify({
          type: "response.reasoning.delta",
          delta: event.text,
        });
        continue;
      }
      const delta = extractFinalContentDelta(rawOutput, streamedContent);
      if (!delta) {
        continue;
      }
      streamedContent += delta;
      yield JSON.stringify({
        type: "response.output_text.delta",
        delta,
      });
      continue;
    }
    if (event.type === "finished") {
      yield* emitCreated();
      finalResult = event.result;
    }
  }

  yield* emitCreated();
  const finalized = finalizeDirectStream(
    direct,
    rawOutput,
    streamedContent,
    finalResult,
    params.responseStore,
    { kgm: params.kgm, metadata: params.metadata, requestHeaders: params.requestHeaders },
    streamedReasoning,
  );
  finalized.model = extractResolvedModel(finalResult?.raw) ?? activeModel;
  if (finalized.finalText.length > streamedContent.length) {
    const trailing = finalized.finalText.slice(streamedContent.length);
    if (trailing) {
      yield JSON.stringify({
        type: "response.output_text.delta",
        delta: trailing,
      });
    }
  }
  yield JSON.stringify({
    type: "response.completed",
    response: buildResponsesObject(finalized),
  });
}

async function prepareDirectStream(params: ExecuteParams): Promise<DirectStreamSetup | null> {
  const ids = resolveRequestTraceIds({
    headers: params.requestHeaders,
    body: { kgm: params.kgm, metadata: params.metadata },
  });
  const requestId = ids.requestId;
  const created = Math.floor(Date.now() / 1000);
  const config = params.configStore.get();
  const model = resolveRequestedModel(params.model, params.configStore);
  const displayModel = resolveDisplayModel(model, params.configStore);
  const kgm = normalizeKgmExtensions(requestId, {
    ...params.kgm,
    ops: {
      ...(params.kgm?.ops ?? {}),
      traceId: ids.traceId,
    },
  });
  const availableTools = resolveTools(params.tools, params.toolRegistry, kgm);
  const effectiveTools = params.toolChoice === "none" ? [] : applyToolChoice(availableTools, params.toolChoice);

  // 只要注入了 tools（含「仅返回 tool_calls、服务端不执行」），走完整兼容管线，
  // 以便 SSE/JSON 产出标准 tool_calls；直连流不负责工具编排。
  if (effectiveTools.length > 0) {
    return null;
  }

  const runtimeRequest: KgmRequest = applyHaxiTagAssembly({
    requestId,
    userId: params.user ?? "openai_compat",
    sessionId: deriveSessionId(params.metadata),
    input: extractLatestUserInput(params.messages),
    model: displayModel,
    conversation: [...params.messages],
    constraints: {
      maxTokens: params.maxTokens,
      style: deriveStyle(params.responseFormat),
    },
    toolPolicy: {
      allowed: [],
      maxRounds: 1,
    },
    metadata: params.metadata,
    kgm,
    routing: params.routing,
  });

  const context = await params.contextBuilder.build(runtimeRequest);
  const systemPromptAddons = [
    ...collectPlaygroundSystemAddons(config),
    ...(params.kgm?.playground?.extraSystemPrompt?.trim()
      ? [params.kgm.playground.extraSystemPrompt.trim()]
      : []),
  ];
  const prompt = renderPrompt({
    context,
    tools: [],
    outputSchema: params.outputSchema,
    toolDescriptorMode: config.context.toolDescriptorMode,
    skillNames: params.skillRuntime?.listNames(),
    includeSkillNames: config.context.includeSkillNames,
    systemPromptAddons,
  });

  return {
    requestId,
    created,
    model: displayModel,
    routingModel: model,
    responseId: `resp_${requestId}`,
    completionId: `chatcmpl_${requestId}`,
    metadata: params.metadata ?? {},
    kgm: {
      ...kgm,
      compatibility: {
        protocol: params.protocol,
        toolExecution: (kgm.capabilities?.executeToolCalls ?? true) ? "server" : "external",
        builtinToolsIncluded: Boolean(kgm.capabilities?.includeBuiltinTools),
        previousResponseId: params.previousResponseId,
      },
      tool_trace: [],
    },
    prompt,
    promptTokens: estimateTokens(prompt),
    conversation: [...params.messages],
    startedAtMs: Date.now(),
  };
}

function finalizeDirectStream(
  setup: DirectStreamSetup,
  rawOutput: string,
  streamedContent: string,
  finalResult?: CompletionResult,
  responseStore?: OpenAiResponseStore,
  normalizeContext?: {
    kgm?: KgmExtensions;
    metadata?: Record<string, unknown>;
    requestHeaders?: Record<string, string | string[] | undefined>;
  },
  streamedReasoning = "",
): CompatibilityRun {
  const rawText = finalResult?.text ?? rawOutput;
  const intent = parseIntent(rawText);
  let finalText = intent.type === "final" ? intent.content : streamedContent || rawText;
  finalText = maybeNormalizeCompatOutput(
    finalText,
    normalizeContext?.kgm ?? setup.kgm,
    normalizeContext?.metadata ?? setup.metadata,
    normalizeContext?.requestHeaders,
  );
  const conversation = [...setup.conversation, { role: "assistant" as const, content: finalText }];
  const routingTrace = extractAutoRoutingTrace(finalResult?.raw);
  const structured = extractStructuredCompletion(finalResult?.raw, undefined);
  const usageMerged = mergeUsageWithEstimates(structured, setup.promptTokens, estimateTokens(finalText));
  const finishedAtMs = Date.now();
  const perf = buildKgmRequestPerf({
    startedAtMs: setup.startedAtMs,
    finishedAtMs,
    promptTokens: usageMerged.prompt_tokens,
    completionTokens: usageMerged.completion_tokens,
    toolRounds: 0,
    intentSource: "text_json",
    runtimeKind:
      typeof routingTrace?.selected?.provider === "string" ? routingTrace.selected.provider : undefined,
  });
  const run: CompatibilityRun = {
    requestId: setup.requestId,
    model: extractResolvedModel(finalResult?.raw) ?? setup.model,
    created: setup.created,
    responseId: setup.responseId,
    completionId: setup.completionId,
    metadata: setup.metadata,
    kgm: {
      ...setup.kgm,
      perf,
      ...(routingTrace
        ? {
            autoRouting: routingTrace as unknown as Record<string, unknown>,
            routing: {
              provider: routingTrace.selected.provider,
              baseUrlHost: routingTrace.selected.baseUrlHost,
              routeKey: routingTrace.selected.routeKey,
            },
          }
        : {}),
    },
    finalText,
    reasoningText: streamedReasoning.trim() || undefined,
    finishReason: "stop",
    toolCalls: [],
    usage: (enrichUsageWithCache(
      {
        prompt_tokens: usageMerged.prompt_tokens,
        completion_tokens: usageMerged.completion_tokens,
        total_tokens: usageMerged.total_tokens,
      },
      perf.cachedTokens,
    ) ?? {
      prompt_tokens: usageMerged.prompt_tokens,
      completion_tokens: usageMerged.completion_tokens,
      total_tokens: usageMerged.total_tokens,
    }) as Record<string, number>,
    conversation,
  };
  responseStore?.save({
    id: setup.responseId,
    requestId: setup.requestId,
    model: run.model,
    conversation,
    metadata: setup.metadata,
  });
  return run;
}

function extractFinalContentDelta(rawText: string, emittedContent: string): string {
  const current = extractProgressiveFinalContent(rawText);
  if (!current || current.length <= emittedContent.length) {
    return "";
  }
  return current.slice(emittedContent.length);
}

// 支持推理模式的字段列表
const CONTENT_FIELDS = [
  "content",
  "reasoning_content",
  "reasoning",
  "thinking",
  "thought",
  "text",
  "output_text",
];

function extractProgressiveFinalContent(rawText: string): string {
  // 尝试从所有可能的内容字段中提取，不依赖 "type" 字段
  for (const field of CONTENT_FIELDS) {
    const fieldIndex = rawText.indexOf(`"${field}"`);
    if (fieldIndex !== -1) {
      const colonIndex = rawText.indexOf(":", fieldIndex);
      if (colonIndex === -1) continue;
      const openingQuoteIndex = rawText.indexOf("\"", colonIndex + 1);
      if (openingQuoteIndex === -1) continue;
      const content = decodeJsonStringPrefix(rawText.slice(openingQuoteIndex + 1));
      if (content) return content;
    }
  }
  
  // 备选方案：尝试解析完整或部分 JSON
  try {
    // 先尝试匹配最大的可能 JSON 对象
    let openBraceCount = 0;
    let startIndex = -1;
    for (let i = 0; i < rawText.length; i++) {
      if (rawText[i] === "{") {
        if (startIndex === -1) startIndex = i;
        openBraceCount++;
      } else if (rawText[i] === "}") {
        openBraceCount--;
        if (openBraceCount === 0 && startIndex !== -1) {
          try {
            const json = JSON.parse(rawText.slice(startIndex, i + 1));
            // 从解析的 JSON 中查找内容
            for (const field of [...CONTENT_FIELDS, "output_text", "text"]) {
              if (typeof json[field] === "string" && json[field]) {
                return json[field];
              }
            }
            // 检查 choices 结构
            if (json.choices?.[0]) {
              const choice = json.choices[0];
              if (choice.delta?.content) return choice.delta.content;
              if (choice.message?.content) return choice.message.content;
              if (choice.text) return choice.text;
            }
          } catch {
            // 继续尝试
          }
          startIndex = -1;
        }
      }
    }
  } catch {
    // 如果解析失败，继续返回空
  }
  
  return "";
}

function decodeJsonStringPrefix(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    if (current === "\"") {
      break;
    }
    if (current !== "\\") {
      decoded += current;
      continue;
    }
    const next = value[index + 1];
    if (!next) {
      break;
    }
    if (next === "u") {
      const hex = value.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        break;
      }
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const escaped = decodeEscapedChar(next);
    if (escaped === null) {
      break;
    }
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function decodeEscapedChar(value: string): string | null {
  switch (value) {
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return null;
  }
}

async function *replayChatCompletionRun(run: CompatibilityRun): AsyncIterable<string> {
  yield JSON.stringify({
    id: run.completionId,
    object: "chat.completion.chunk",
    created: run.created,
    model: run.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (const toolCall of run.toolCalls) {
    yield JSON.stringify({
      id: run.completionId,
      object: "chat.completion.chunk",
      created: run.created,
      model: run.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: toolCall.argumentsJson,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  for (const piece of splitText(run.finalText)) {
    yield JSON.stringify({
      id: run.completionId,
      object: "chat.completion.chunk",
      created: run.created,
      model: run.model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
  }
  yield JSON.stringify({
    id: run.completionId,
    object: "chat.completion.chunk",
    created: run.created,
    model: run.model,
    choices: [{ index: 0, delta: {}, finish_reason: run.finishReason }],
    usage: run.usage,
    metadata: run.metadata,
    kgm: run.kgm,
  });
}

async function *replayResponsesRun(run: CompatibilityRun): AsyncIterable<string> {
  yield JSON.stringify({
    type: "response.created",
    response: {
      id: run.responseId,
      object: "response",
      created: run.created,
      model: run.model,
      status: "in_progress",
    },
  });
  for (let index = 0; index < run.toolCalls.length; index += 1) {
    const toolCall = run.toolCalls[index]!;
    yield JSON.stringify({
      type: "response.output_item.added",
      output_index: index,
      item: buildFunctionCallItem(toolCall),
    });
    if (toolCall.executed) {
      yield JSON.stringify({
        type: "response.output_item.added",
        output_index: index,
        item: buildFunctionCallOutputItem(toolCall),
      });
    }
  }
  for (const piece of splitText(run.finalText)) {
    yield JSON.stringify({
      type: "response.output_text.delta",
      delta: piece,
    });
  }
  yield JSON.stringify({
    type: "response.completed",
    response: buildResponsesObject(run),
  });
}

function buildResponsesObject(run: CompatibilityRun): Record<string, unknown> {
  const output = [
    ...run.toolCalls.map(buildFunctionCallItem),
    ...run.toolCalls.filter((item) => item.executed).map(buildFunctionCallOutputItem),
    {
      id: `msg_${run.requestId}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: run.finalText,
        },
      ],
    },
  ];

  return {
    id: run.responseId,
    object: "response",
    created: run.created,
    model: run.model,
    status: "completed",
    output,
    output_text: run.finalText,
    usage: run.usage,
    metadata: run.metadata,
    kgm: {
      ...run.kgm,
      ...(run.reasoningText?.trim()
        ? { reasoning_content: run.reasoningText, reasoning_trace: run.reasoningText.split("\n").filter(Boolean).map((line) => ({ content: line })) }
        : {}),
    },
  };
}

function buildFunctionCallItem(toolCall: CompatibilityToolTrace): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.argumentsJson,
    status: toolCall.executed ? "completed" : "pending",
  };
}

function buildFunctionCallOutputItem(toolCall: CompatibilityToolTrace): Record<string, unknown> {
  return {
    type: "function_call_output",
    call_id: toolCall.id,
    output: JSON.stringify(toolCall.output ?? { error: toolCall.error ?? "unknown" }),
  };
}

function buildToolTrace(name: string, args: Record<string, unknown>): CompatibilityToolTrace {
  return {
    id: `call_${generateId()}`,
    name,
    arguments: args,
    argumentsJson: JSON.stringify(args),
    executed: false,
  };
}

function resolveTools(
  requestTools: OpenAiToolDefinition[] | undefined,
  toolRegistry: ToolRegistry,
  kgm: KgmExtensions | undefined,
): ToolDefinition[] {
  const toolsByName = new Map<string, ToolDefinition>();

  if (kgm?.capabilities?.includeBuiltinTools) {
    for (const definition of toolRegistry.listDefinitions()) {
      toolsByName.set(definition.name, definition);
    }
  }

  for (const tool of requestTools ?? []) {
    const existing = toolRegistry.getDefinition(tool.function.name);
    if (existing) {
      toolsByName.set(existing.name, existing);
      continue;
    }
    toolsByName.set(tool.function.name, {
      name: tool.function.name,
      kind: "function",
      description: tool.function.description ?? "Externally declared OpenAI-compatible function",
      inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      metadata: {
        latency: "medium",
        sideEffect: false,
        costLevel: "medium",
        integration: "external",
      },
    });
  }

  return Array.from(toolsByName.values());
}

function canExecuteToolCall(name: string, toolRegistry: ToolRegistry): boolean {
  return Boolean(toolRegistry.getDefinition(name));
}

function applyToolChoice(tools: ToolDefinition[], toolChoice?: OpenAiToolChoice): ToolDefinition[] {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") {
    return tools;
  }
  if (toolChoice === "none") {
    return [];
  }
  return tools.filter((tool) => tool.name === toolChoice.function.name);
}

function normalizeMessages(messages: OpenAiChatMessage[]): ConversationMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: normalizeMessageContent(message),
    name: message.name,
    toolCallId: message.tool_call_id,
  }));
}

function normalizeResponsesInput(
  input: OpenAiResponsesRequest["input"],
  instructions: string | undefined,
  previousResponseId: string | undefined,
  responseStore: OpenAiResponseStore,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  if (previousResponseId) {
    const previous = responseStore.get(previousResponseId);
    if (previous) {
      messages.push(...previous.conversation);
    }
  }
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!input) {
    return messages;
  }

  for (const item of input) {
    const responsesItem = isResponsesInputItem(item) ? item : undefined;
    const itemType = responsesItem?.type;
    const role = item.role ?? (itemType === "function_call_output" ? "tool" : "user");
    const content =
      itemType === "function_call_output"
        ? typeof responsesItem?.output === "string"
          ? responsesItem.output
          : JSON.stringify(responsesItem?.output ?? {})
        : normalizeMessageContent({
          role,
          content: item.content,
          tool_call_id: item.tool_call_id ?? responsesItem?.call_id,
          name: item.name,
        });
    messages.push({
      role,
      content,
      name: item.name,
      toolCallId: item.tool_call_id ?? responsesItem?.call_id,
    });
  }

  return messages;
}

function normalizeMessageContent(message: {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAiMessageContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}): string {
  const parts: string[] = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text" || item.type === "input_text" || item.type === "output_text") {
        const textValue = typeof item.text === "string" ? item.text : undefined;
        if (textValue) {
          parts.push(textValue);
        }
        continue;
      }
      if (item.type === "image_url") {
        const imageValue =
          typeof item.image_url === "string"
            ? item.image_url
            : isRecord(item.image_url) && typeof item.image_url.url === "string"
              ? item.image_url.url
              : undefined;
        parts.push(`[image:${imageValue ?? "unknown"}]`);
        continue;
      }
      parts.push(`[content:${item.type}]`);
    }
  }

  if (message.tool_calls?.length) {
    parts.push(message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments})`).join("\n"));
  }

  return parts.join("\n").trim();
}

function toOpenAiToolCall(toolCall: CompatibilityToolTrace): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    },
  };
}

function extractLatestUserInput(messages: ConversationMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].content) {
      return messages[index].content;
    }
  }
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function deriveStyle(responseFormat?: Record<string, unknown>): string | undefined {
  const type = responseFormat?.type;
  if (type === "json_object" || type === "json_schema") {
    return "json";
  }
  return undefined;
}

function deriveSessionId(metadata?: Record<string, unknown>): string | undefined {
  const value = metadata?.session_id;
  return typeof value === "string" ? value : undefined;
}

function normalizeKgmExtensions(requestId: string, kgm?: KgmExtensions): KgmExtensions {
  return {
    ...kgm,
    ops: {
      deployment: "self_hosted",
      slaOwner: "self",
      traceId: requestId,
      ...(kgm?.ops ?? {}),
    },
  };
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function splitText(text: string): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 32) {
    chunks.push(text.slice(index, index + 32));
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponsesInputItem(
  value: OpenAiResponsesInputItem | OpenAiChatMessage,
): value is OpenAiResponsesInputItem {
  return "type" in value || "call_id" in value || "output" in value;
}
