import { streamCompletion } from "../llm/client.js";
import { extractAutoRoutingTrace, extractResolvedModel } from "../llm/autoRoutingClient.js";
import { parseIntent } from "../parse/parser.js";
import { renderPrompt } from "../prompt/renderer.js";
import { collectPlaygroundSystemAddons } from "../playground/systemAddons.js";
import { generateId } from "../utils/id.js";
import { applyHaxiTagAssembly } from "../protocol/haxiTagAssembly.js";
import { extractStructuredCompletion, mergeUsageWithEstimates } from "../llm/completionNormalize.js";
import { annotateOpenAiModels } from "../models/modelTypeAnnotator.js";
export function buildOpenAiModelList(configStore, modelManager) {
    const llm = configStore.get().llm;
    const data = modelManager?.listOpenAiModels(llm.model, llm.provider) ?? [
        {
            id: llm.model,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: llm.provider,
        },
    ];
    return {
        object: "list",
        data: annotateOpenAiModels([
            {
                id: "auto",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "kgm",
            },
            ...data,
        ]),
    };
}
function isMockMode() {
    return process.env.KGM_MOCK_MODE === "1";
}
function resolveRequestedModel(model, configStore) {
    return model && model !== "auto" ? model : configStore.get().llm.model;
}
function createMockChatCompletion(request, configStore) {
    const requestId = generateId();
    const created = Math.floor(Date.now() / 1000);
    const model = resolveRequestedModel(request.model, configStore);
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
function createMockResponse(request, configStore) {
    const requestId = generateId();
    const created = Math.floor(Date.now() / 1000);
    const model = resolveRequestedModel(request.model, configStore);
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
async function* streamMockChatCompletion(request, configStore) {
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
async function* streamMockResponse(request, configStore) {
    const body = createMockResponse(request, configStore);
    yield JSON.stringify({ type: "response.created", response: { id: body.id, object: "response", created: body.created, model: body.model, status: "in_progress" } });
    yield JSON.stringify({ type: "response.output_text.delta", delta: "ok" });
    yield JSON.stringify({ type: "response.completed", response: body });
}
export async function createOpenAiChatCompletion(params) {
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
    });
    const message = {
        role: "assistant",
        content: run.finalText || null,
    };
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
export async function createOpenAiResponse(params) {
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
    });
    return buildResponsesObject(run);
}
export function streamOpenAiChatCompletion(params) {
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
    });
}
export function streamOpenAiResponse(params) {
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
    });
}
async function executeCompatibilityRun(params) {
    const requestId = generateId();
    const created = Math.floor(Date.now() / 1000);
    const config = params.configStore.get();
    const model = resolveRequestedModel(params.model, params.configStore);
    let resolvedModel = model;
    const kgm = normalizeKgmExtensions(requestId, params.kgm);
    const availableTools = resolveTools(params.tools, params.toolRegistry, kgm);
    const effectiveTools = params.toolChoice === "none" ? [] : applyToolChoice(availableTools, params.toolChoice);
    const executeToolCalls = kgm.capabilities?.executeToolCalls ?? true;
    const conversation = [...params.messages];
    const traces = [];
    const aggregatedToolResults = [];
    let latestRoutingTrace = undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let finalText = "";
    let finishReason = "stop";
    for (let round = 0; round < 3; round += 1) {
        const runtimeRequest = applyHaxiTagAssembly({
            requestId,
            userId: params.user ?? "openai_compat",
            sessionId: deriveSessionId(params.metadata),
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
            metadata: params.metadata,
            kgm,
            routing: params.routing,
        });
        const context = await params.contextBuilder.build(runtimeRequest);
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
        const completion = await params.llmClient.complete(prompt, {
            model,
            requestId,
            sessionId: deriveSessionId(params.metadata),
            maxTokens: params.maxTokens,
            temperature: params.temperature ?? config.llm.temperature,
            metadata: params.metadata,
            taskInput: runtimeRequest.input,
            taskType: params.routing?.taskType,
            taskName: params.routing?.taskName,
            routing: params.routing,
        });
        latestRoutingTrace = extractAutoRoutingTrace(completion.raw);
        resolvedModel = extractResolvedModel(completion.raw) ?? resolvedModel;
        const structuredRound = extractStructuredCompletion(completion.raw, config.llm.provider);
        const roundUsage = mergeUsageWithEstimates(structuredRound, estimateTokens(prompt), estimateTokens(completion.text));
        promptTokens += roundUsage.prompt_tokens;
        completionTokens += roundUsage.completion_tokens;
        const intent = parseIntent(completion.text);
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
            }
            catch (error) {
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
            }
            catch (error) {
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
    const responseId = `resp_${requestId}`;
    const completionId = `chatcmpl_${requestId}`;
    params.responseStore.save({
        id: responseId,
        requestId,
        model: resolvedModel,
        conversation,
        metadata: params.metadata,
    });
    return {
        requestId,
        model: resolvedModel,
        created,
        responseId,
        completionId,
        metadata: params.metadata ?? {},
        kgm: {
            ...kgm,
            compatibility: {
                protocol: params.protocol,
                toolExecution: executeToolCalls ? "server" : "external",
                builtinToolsIncluded: Boolean(kgm.capabilities?.includeBuiltinTools),
                previousResponseId: params.previousResponseId,
            },
            ...(latestRoutingTrace ? { routing: latestRoutingTrace } : {}),
            tool_trace: traces,
        },
        finalText,
        finishReason,
        toolCalls: traces,
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
        conversation,
    };
}
async function* streamChatCompletionChunks(params) {
    const direct = await prepareDirectStream(params);
    if (!direct) {
        const run = await executeCompatibilityRun(params);
        yield* replayChatCompletionRun(run);
        return;
    }
    yield JSON.stringify({
        id: direct.completionId,
        object: "chat.completion.chunk",
        created: direct.created,
        model: direct.model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    let rawOutput = "";
    let streamedContent = "";
    let finalResult;
    let activeModel = direct.model;
    for await (const event of streamCompletion(params.llmClient, direct.prompt, {
        model: direct.model,
        requestId: direct.requestId,
        sessionId: deriveSessionId(params.metadata),
        maxTokens: params.maxTokens,
        temperature: params.temperature ?? params.configStore.get().llm.temperature,
        metadata: params.metadata,
        taskInput: extractLatestUserInput(direct.conversation),
        taskType: params.routing?.taskType,
        taskName: params.routing?.taskName,
        routing: params.routing,
    })) {
        if (event.type === "started" && event.model) {
            activeModel = event.model;
            continue;
        }
        if (event.type === "token" && event.text) {
            rawOutput += event.text;
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
            finalResult = event.result;
        }
    }
    const finalized = finalizeDirectStream(direct, rawOutput, streamedContent, finalResult, params.responseStore);
    finalized.model = extractResolvedModel(finalResult?.raw) ?? activeModel;
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
async function* streamResponsesChunks(params) {
    const direct = await prepareDirectStream(params);
    if (!direct) {
        const run = await executeCompatibilityRun(params);
        yield* replayResponsesRun(run);
        return;
    }
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
    let rawOutput = "";
    let streamedContent = "";
    let finalResult;
    let activeModel = direct.model;
    for await (const event of streamCompletion(params.llmClient, direct.prompt, {
        model: direct.model,
        requestId: direct.requestId,
        sessionId: deriveSessionId(params.metadata),
        maxTokens: params.maxTokens,
        temperature: params.temperature ?? params.configStore.get().llm.temperature,
        metadata: params.metadata,
        taskInput: extractLatestUserInput(direct.conversation),
        taskType: params.routing?.taskType,
        taskName: params.routing?.taskName,
        routing: params.routing,
    })) {
        if (event.type === "started" && event.model) {
            activeModel = event.model;
            continue;
        }
        if (event.type === "token" && event.text) {
            rawOutput += event.text;
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
            finalResult = event.result;
        }
    }
    const finalized = finalizeDirectStream(direct, rawOutput, streamedContent, finalResult, params.responseStore);
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
async function prepareDirectStream(params) {
    const requestId = generateId();
    const created = Math.floor(Date.now() / 1000);
    const config = params.configStore.get();
    const model = resolveRequestedModel(params.model, params.configStore);
    const kgm = normalizeKgmExtensions(requestId, params.kgm);
    const availableTools = resolveTools(params.tools, params.toolRegistry, kgm);
    const effectiveTools = params.toolChoice === "none" ? [] : applyToolChoice(availableTools, params.toolChoice);
    if (effectiveTools.length > 0) {
        return null;
    }
    const runtimeRequest = applyHaxiTagAssembly({
        requestId,
        userId: params.user ?? "openai_compat",
        sessionId: deriveSessionId(params.metadata),
        input: extractLatestUserInput(params.messages),
        model,
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
        model,
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
    };
}
function finalizeDirectStream(setup, rawOutput, streamedContent, finalResult, responseStore) {
    const rawText = finalResult?.text ?? rawOutput;
    const intent = parseIntent(rawText);
    const finalText = intent.type === "final" ? intent.content : streamedContent || rawText;
    const conversation = [...setup.conversation, { role: "assistant", content: finalText }];
    const routingTrace = extractAutoRoutingTrace(finalResult?.raw);
    const structured = extractStructuredCompletion(finalResult?.raw, undefined);
    const usageMerged = mergeUsageWithEstimates(structured, setup.promptTokens, estimateTokens(finalText));
    const run = {
        requestId: setup.requestId,
        model: extractResolvedModel(finalResult?.raw) ?? setup.model,
        created: setup.created,
        responseId: setup.responseId,
        completionId: setup.completionId,
        metadata: setup.metadata,
        kgm: {
            ...setup.kgm,
            ...(routingTrace ? { routing: routingTrace } : {}),
        },
        finalText,
        finishReason: "stop",
        toolCalls: [],
        usage: {
            prompt_tokens: usageMerged.prompt_tokens,
            completion_tokens: usageMerged.completion_tokens,
            total_tokens: usageMerged.total_tokens,
        },
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
function extractFinalContentDelta(rawText, emittedContent) {
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
function extractProgressiveFinalContent(rawText) {
    // 尝试从所有可能的内容字段中提取，不依赖 "type" 字段
    for (const field of CONTENT_FIELDS) {
        const fieldIndex = rawText.indexOf(`"${field}"`);
        if (fieldIndex !== -1) {
            const colonIndex = rawText.indexOf(":", fieldIndex);
            if (colonIndex === -1)
                continue;
            const openingQuoteIndex = rawText.indexOf("\"", colonIndex + 1);
            if (openingQuoteIndex === -1)
                continue;
            const content = decodeJsonStringPrefix(rawText.slice(openingQuoteIndex + 1));
            if (content)
                return content;
        }
    }
    // 备选方案：尝试解析完整或部分 JSON
    try {
        // 先尝试匹配最大的可能 JSON 对象
        let openBraceCount = 0;
        let startIndex = -1;
        for (let i = 0; i < rawText.length; i++) {
            if (rawText[i] === "{") {
                if (startIndex === -1)
                    startIndex = i;
                openBraceCount++;
            }
            else if (rawText[i] === "}") {
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
                            if (choice.delta?.content)
                                return choice.delta.content;
                            if (choice.message?.content)
                                return choice.message.content;
                            if (choice.text)
                                return choice.text;
                        }
                    }
                    catch {
                        // 继续尝试
                    }
                    startIndex = -1;
                }
            }
        }
    }
    catch {
        // 如果解析失败，继续返回空
    }
    return "";
}
function decodeJsonStringPrefix(value) {
    let decoded = "";
    for (let index = 0; index < value.length; index += 1) {
        const current = value[index];
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
function decodeEscapedChar(value) {
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
async function* replayChatCompletionRun(run) {
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
async function* replayResponsesRun(run) {
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
        const toolCall = run.toolCalls[index];
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
function buildResponsesObject(run) {
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
        kgm: run.kgm,
    };
}
function buildFunctionCallItem(toolCall) {
    return {
        id: toolCall.id,
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.argumentsJson,
        status: toolCall.executed ? "completed" : "pending",
    };
}
function buildFunctionCallOutputItem(toolCall) {
    return {
        type: "function_call_output",
        call_id: toolCall.id,
        output: JSON.stringify(toolCall.output ?? { error: toolCall.error ?? "unknown" }),
    };
}
function buildToolTrace(name, args) {
    return {
        id: `call_${generateId()}`,
        name,
        arguments: args,
        argumentsJson: JSON.stringify(args),
        executed: false,
    };
}
function resolveTools(requestTools, toolRegistry, kgm) {
    const toolsByName = new Map();
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
function canExecuteToolCall(name, toolRegistry) {
    return Boolean(toolRegistry.getDefinition(name));
}
function applyToolChoice(tools, toolChoice) {
    if (!toolChoice || toolChoice === "auto" || toolChoice === "required") {
        return tools;
    }
    if (toolChoice === "none") {
        return [];
    }
    return tools.filter((tool) => tool.name === toolChoice.function.name);
}
function normalizeMessages(messages) {
    return messages.map((message) => ({
        role: message.role,
        content: normalizeMessageContent(message),
        name: message.name,
        toolCallId: message.tool_call_id,
    }));
}
function normalizeResponsesInput(input, instructions, previousResponseId, responseStore) {
    const messages = [];
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
        const content = itemType === "function_call_output"
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
function normalizeMessageContent(message) {
    const parts = [];
    const content = message.content;
    if (typeof content === "string") {
        parts.push(content);
    }
    else if (Array.isArray(content)) {
        for (const item of content) {
            if (item.type === "text" || item.type === "input_text" || item.type === "output_text") {
                const textValue = typeof item.text === "string" ? item.text : undefined;
                if (textValue) {
                    parts.push(textValue);
                }
                continue;
            }
            if (item.type === "image_url") {
                const imageValue = typeof item.image_url === "string"
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
function toOpenAiToolCall(toolCall) {
    return {
        id: toolCall.id,
        type: "function",
        function: {
            name: toolCall.name,
            arguments: toolCall.argumentsJson,
        },
    };
}
function extractLatestUserInput(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "user" && messages[index].content) {
            return messages[index].content;
        }
    }
    return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}
function deriveStyle(responseFormat) {
    const type = responseFormat?.type;
    if (type === "json_object" || type === "json_schema") {
        return "json";
    }
    return undefined;
}
function deriveSessionId(metadata) {
    const value = metadata?.session_id;
    return typeof value === "string" ? value : undefined;
}
function normalizeKgmExtensions(requestId, kgm) {
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
function estimateTokens(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return 0;
    }
    return trimmed.split(/\s+/).length;
}
function splitText(text) {
    if (!text) {
        return [];
    }
    const chunks = [];
    for (let index = 0; index < text.length; index += 32) {
        chunks.push(text.slice(index, index + 32));
    }
    return chunks;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isResponsesInputItem(value) {
    return "type" in value || "call_id" in value || "output" in value;
}
