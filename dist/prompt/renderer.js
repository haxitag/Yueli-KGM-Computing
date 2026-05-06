export function renderPrompt(params) {
    const toolBlock = renderTools(params.tools, params.toolDescriptorMode ?? "full");
    const contextJson = JSON.stringify(buildPromptContext(params.context), null, 2);
    const schemaJson = JSON.stringify(params.outputSchema, null, 2);
    const dynamicHints = buildDynamicHints(params.context, params.toolDescriptorMode, params.skillNames);
    const skillBlock = buildSkillBlock(params.skillNames, params.includeSkillNames);
    const conversationBlock = buildConversationBlock(params.context);
    const addonBlock = (params.systemPromptAddons ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
    return [
        "You are the KGM-computing runtime.",
        ...addonBlock,
        "Return ONLY a JSON object that matches the output schema.",
        "If no tool applies, return type=final.",
        "",
        "### Allowed Tools",
        toolBlock,
        skillBlock,
        dynamicHints,
        conversationBlock,
        "",
        "### ContextPack",
        contextJson,
        "",
        "### Output Schema",
        schemaJson,
        "",
        "### Output JSON:",
    ].join("\n");
}
function renderTools(tools, mode) {
    if (tools.length === 0) {
        return "(none)";
    }
    if (mode === "names") {
        return tools.map((tool) => `- ${tool.name}`).join("\n");
    }
    return tools
        .map((tool, index) => {
        return [
            `${index + 1}. ${tool.name}`,
            `   kind: ${tool.kind ?? "tool"}`,
            `   description: ${tool.description}`,
            `   input_schema: ${JSON.stringify(tool.inputSchema)}`,
            `   metadata: ${JSON.stringify(tool.metadata ?? {})}`,
        ].join("\n");
    })
        .join("\n");
}
function buildDynamicHints(context, toolDescriptorMode, skillNames) {
    const hints = [];
    if (toolDescriptorMode === "names") {
        hints.push("Tool schemas are omitted. Use describe_tool(name) if you need input/output schema.");
    }
    const hasArtifacts = context.evidence.some((item) => item.artifact_ref) ||
        context.toolResults.some((result) => {
            const output = result.output;
            return Boolean(output && typeof output === "object" && "artifact_ref" in output);
        });
    if (hasArtifacts) {
        hints.push("If artifact_ref is present, call read_artifact(id) to load full content.");
    }
    if (context.session_ref) {
        hints.push("Session history is available. Use read_session(id) for more details.");
    }
    if (skillNames && skillNames.length > 0) {
        hints.push("Skill details are omitted. Use describe_skill(name) when needed.");
    }
    if (hints.length === 0) {
        return "";
    }
    return ["### Dynamic Context", ...hints.map((hint) => `- ${hint}`)].join("\n");
}
function buildSkillBlock(skillNames, includeSkillNames) {
    if (!includeSkillNames || !skillNames || skillNames.length === 0) {
        return "";
    }
    return ["### Skills", ...skillNames.map((name) => `- ${name}`)].join("\n");
}
function buildConversationBlock(context) {
    if (!context.conversation || context.conversation.length === 0) {
        return "";
    }
    return [
        "### Conversation",
        ...context.conversation.map((message, index) => {
            const header = `${index + 1}. ${message.role}${message.name ? `(${message.name})` : ""}`;
            const toolCall = message.toolCallId ? ` [tool_call_id=${message.toolCallId}]` : "";
            return `${header}${toolCall}: ${message.content}`;
        }),
    ].join("\n");
}
function buildPromptContext(context) {
    return {
        requestId: context.requestId,
        userId: context.userId,
        sessionId: context.sessionId,
        session_ref: context.session_ref,
        input: context.input,
        signals: context.signals,
        evidence: context.evidence,
        constraints: context.constraints,
        toolPolicy: context.toolPolicy,
        toolResults: context.toolResults,
        kgm: buildPromptVisibleKgm(context),
    };
}
function buildPromptVisibleKgm(context) {
    const retrieval = context.kgm?.retrieval;
    const graph = context.kgm?.graph;
    if (!retrieval && !graph) {
        return undefined;
    }
    return {
        retrieval,
        graph,
    };
}
