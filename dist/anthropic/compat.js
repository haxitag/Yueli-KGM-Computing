import { createOpenAiChatCompletion, streamOpenAiChatCompletion, } from "../openai/compat.js";
function parseFunctionArgumentsJson(argumentsJson) {
    const raw = argumentsJson ?? "{}";
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        /* empty */
    }
    return {};
}
/**
 * OpenAI `tool_calls` → Anthropic `tool_use` 块（不含 text）。
 */
export function openAiToolCallsToAnthropicToolUseBlocks(toolCalls) {
    return toolCalls.map((call, index) => {
        const id = call.id?.trim() || `toolu_${index}_${Date.now().toString(36)}`;
        const name = call.function?.name ?? "";
        const input = parseFunctionArgumentsJson(call.function?.arguments);
        return { type: "tool_use", id, name, input };
    });
}
/**
 * OpenAI assistant `message`（`content` + 可选 `tool_calls`）→ Anthropic `content` 数组。
 */
export function openAiAssistantMessageToAnthropicContent(message) {
    const blocks = [];
    const text = message.content;
    if (text !== null && text !== undefined && String(text).length > 0) {
        blocks.push({ type: "text", text: String(text) });
    }
    if (message.tool_calls?.length) {
        blocks.push(...openAiToolCallsToAnthropicToolUseBlocks(message.tool_calls));
    }
    if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
    }
    return blocks;
}
function mapOpenAiFinishReasonToAnthropicStopReason(finish) {
    switch (finish) {
        case "length":
            return "max_tokens";
        case "tool_calls":
            return "tool_use";
        case "content_filter":
            return "end_turn";
        case "stop":
        default:
            return "end_turn";
    }
}
export function openAiChatCompletionToAnthropicMessage(openai) {
    const choices = openai.choices;
    const message = choices?.[0]?.message;
    const usage = openai.usage;
    const model = String(openai.model ?? "");
    const rawId = String(openai.id ?? "chatcmpl");
    const id = rawId.startsWith("chatcmpl-") ? `msg_${rawId.slice("chatcmpl-".length)}` : `msg_${rawId}`;
    const stopReason = mapOpenAiFinishReasonToAnthropicStopReason(choices?.[0]?.finish_reason);
    const content = message
        ? openAiAssistantMessageToAnthropicContent(message)
        : [{ type: "text", text: "" }];
    return {
        id,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason,
        usage: {
            input_tokens: usage?.prompt_tokens ?? 0,
            output_tokens: usage?.completion_tokens ?? 0,
        },
    };
}
function expandAnthropicAssistantToOpenAi(blocks) {
    const textParts = [];
    const toolUses = [];
    for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
        }
        if (block.type === "tool_use") {
            const b = block;
            toolUses.push({
                id: String(b.id ?? ""),
                name: String(b.name ?? ""),
                input: b.input && typeof b.input === "object" ? b.input : {},
            });
        }
    }
    const textJoined = textParts.join("");
    const msg = {
        role: "assistant",
        content: textJoined.length > 0 ? textJoined : null,
    };
    if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tc, i) => ({
            id: tc.id || `call_${i}`,
            type: "function",
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
            },
        }));
    }
    return [msg];
}
function expandAnthropicUserBlocksToOpenAi(blocks) {
    const out = [];
    const textBuf = [];
    const flushText = () => {
        const t = textBuf.join("");
        textBuf.length = 0;
        if (t.length > 0) {
            out.push({ role: "user", content: t });
        }
    };
    for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
            textBuf.push(block.text);
        }
        else if (block.type === "tool_result") {
            flushText();
            const b = block;
            const toolUseId = String(b.tool_use_id ?? "");
            const c = typeof b.content === "string" ? b.content : b.content !== undefined ? JSON.stringify(b.content) : "";
            out.push({ role: "tool", tool_call_id: toolUseId, content: c });
        }
    }
    flushText();
    return out;
}
export function anthropicToolsToOpenAiTools(tools) {
    if (!tools?.length)
        return undefined;
    return tools.map((t) => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema ?? { type: "object", properties: {} },
        },
    }));
}
export function parseAnthropicToolChoice(toolChoice) {
    if (toolChoice === undefined)
        return { openAi: undefined };
    if (typeof toolChoice === "string") {
        if (toolChoice === "auto")
            return { openAi: "auto" };
        if (toolChoice === "any")
            return { openAi: "required" };
        if (toolChoice === "none")
            return { openAi: "none" };
        return { openAi: undefined };
    }
    if (typeof toolChoice === "object" && toolChoice !== null) {
        const o = toolChoice;
        const disableRaw = o.disable_parallel_tool_use;
        const disableParallelToolUse = typeof disableRaw === "boolean" ? disableRaw : undefined;
        const t = o.type;
        if (t === "auto")
            return { openAi: "auto", disableParallelToolUse };
        if (t === "any")
            return { openAi: "required", disableParallelToolUse };
        if (t === "tool") {
            const name = String(o.name ?? "").trim();
            if (!name)
                return { openAi: undefined, disableParallelToolUse };
            return {
                openAi: { type: "function", function: { name } },
                disableParallelToolUse,
            };
        }
        if (t === "none")
            return { openAi: "none" };
    }
    return { openAi: undefined };
}
export function anthropicToolChoiceToOpenAi(toolChoice) {
    return parseAnthropicToolChoice(toolChoice).openAi;
}
/** 由 `tool_choice.disable_parallel_tool_use` 推导 OpenAI `parallel_tool_calls`（未指定则 undefined） */
export function anthropicDisableParallelToOpenAiParallel(disableParallelToolUse) {
    if (disableParallelToolUse === undefined)
        return undefined;
    return !disableParallelToolUse;
}
export function anthropicMessagesToOpenAiChatRequest(req) {
    const messages = [];
    if (req.system !== undefined && req.system !== "") {
        messages.push({ role: "system", content: req.system });
    }
    for (const m of req.messages) {
        if (typeof m.content === "string") {
            messages.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === "assistant") {
            messages.push(...expandAnthropicAssistantToOpenAi(m.content));
        }
        else {
            messages.push(...expandAnthropicUserBlocksToOpenAi(m.content));
        }
    }
    const tools = anthropicToolsToOpenAiTools(req.tools);
    const parsedChoice = parseAnthropicToolChoice(req.tool_choice);
    const tool_choice = parsedChoice.openAi;
    const fromChoice = anthropicDisableParallelToOpenAiParallel(parsedChoice.disableParallelToolUse);
    const parallel_tool_calls = req.parallel_tool_calls !== undefined ? req.parallel_tool_calls : fromChoice;
    return {
        model: req.model,
        messages,
        max_tokens: req.max_tokens ?? 4096,
        temperature: req.temperature,
        stream: req.stream,
        metadata: req.metadata,
        kgm: req.kgm,
        ...(tools !== undefined ? { tools } : {}),
        ...(tool_choice !== undefined ? { tool_choice } : {}),
        ...(parallel_tool_calls !== undefined ? { parallel_tool_calls } : {}),
    };
}
export async function createAnthropicMessagesResponse(params) {
    const request = anthropicMessagesToOpenAiChatRequest({ ...params.request, stream: false });
    const response = await createOpenAiChatCompletion({
        ...params,
        request,
    });
    return openAiChatCompletionToAnthropicMessage(response);
}
function mergeToolCallDeltas(acc, deltas) {
    for (const d of deltas) {
        const idx = typeof d.index === "number" ? d.index : 0;
        if (!acc[idx]) {
            acc[idx] = { arguments: "" };
        }
        if (d.id) {
            acc[idx].id = d.id;
        }
        if (d.function?.name) {
            acc[idx].name = d.function.name;
        }
        if (d.function?.arguments) {
            acc[idx].arguments += d.function.arguments;
        }
    }
}
function toolAccToAnthropicToolUseBlocks(acc) {
    const indices = Object.keys(acc)
        .map(Number)
        .sort((a, b) => a - b);
    return indices.map((i, j) => {
        const t = acc[i];
        const id = t.id?.trim() || `toolu_${j}_${Date.now().toString(36)}`;
        const name = t.name ?? "";
        const input = parseFunctionArgumentsJson(t.arguments);
        return { type: "tool_use", id, name, input };
    });
}
function* yieldAnthropicToolUseStreamBlocks(tools, startIndex) {
    for (let i = 0; i < tools.length; i += 1) {
        const t = tools[i];
        const index = startIndex + i;
        yield JSON.stringify({
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
        });
        const json = JSON.stringify(t.input);
        yield JSON.stringify({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: json },
        });
    }
}
/**
 * 将 OpenAI chat completion SSE 分片映射为 Anthropic 风格的 JSON 行（写入 `data:`，每条含 `type` 字段）。
 * 在流式结束时若存在 `tool_calls`，会按序输出 `tool_use` 内容块（与 OpenAI 分片顺序一致：先累积 tool，再输出 text 时先 flush tool）。
 */
export async function* streamAnthropicMessagesJsonLines(params) {
    const request = anthropicMessagesToOpenAiChatRequest({ ...params.request, stream: true });
    const stream = params.openAiStream ?? streamOpenAiChatCompletion({
        ...params,
        request,
    });
    const configModel = params.configStore.get().llm.model;
    const model = params.request.model ?? configModel;
    const msgId = `msg_stream_${Date.now().toString(36)}`;
    yield JSON.stringify({
        type: "message_start",
        message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
        },
    });
    const toolAcc = {};
    let lastUsage;
    let lastFinish;
    let nextBlockIndex = 0;
    let textBlockIndex = -1;
    let startedText = false;
    function* flushPendingTools() {
        if (Object.keys(toolAcc).length === 0) {
            return;
        }
        const tools = toolAccToAnthropicToolUseBlocks(toolAcc);
        for (const k of Object.keys(toolAcc)) {
            delete toolAcc[Number(k)];
        }
        yield* yieldAnthropicToolUseStreamBlocks(tools, nextBlockIndex);
        nextBlockIndex += tools.length;
    }
    for await (const chunk of stream) {
        const parsed = JSON.parse(chunk);
        if (parsed.usage) {
            lastUsage = parsed.usage;
        }
        const delta = parsed.choices?.[0]?.delta;
        const fr = parsed.choices?.[0]?.finish_reason;
        if (fr !== undefined && fr !== null) {
            lastFinish = fr;
        }
        if (delta?.tool_calls?.length) {
            mergeToolCallDeltas(toolAcc, delta.tool_calls);
        }
        const deltaAny = delta;
        const content = delta?.content ||
            (typeof deltaAny?.reasoning_content === "string" ? deltaAny.reasoning_content : undefined) ||
            (typeof deltaAny?.reasoning === "string" ? deltaAny.reasoning : undefined);
        if (content) {
            if (!startedText) {
                yield* flushPendingTools();
                yield JSON.stringify({
                    type: "content_block_start",
                    index: nextBlockIndex,
                    content_block: { type: "text", text: "" },
                });
                textBlockIndex = nextBlockIndex;
                startedText = true;
                nextBlockIndex += 1;
            }
            yield JSON.stringify({
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: content },
            });
        }
    }
    if (!startedText) {
        yield* flushPendingTools();
    }
    else if (Object.keys(toolAcc).length > 0) {
        yield* flushPendingTools();
    }
    yield JSON.stringify({
        type: "message_delta",
        delta: {
            stop_reason: mapOpenAiFinishReasonToAnthropicStopReason(lastFinish),
            usage: {
                input_tokens: lastUsage?.prompt_tokens ?? 0,
                output_tokens: lastUsage?.completion_tokens ?? 0,
            },
        },
    });
    yield JSON.stringify({ type: "message_stop" });
}
