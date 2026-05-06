import { buildMemoryChunk } from "../memory/store.js";
import { renderPrompt } from "../prompt/renderer.js";
import { parseIntent } from "../parse/parser.js";
import { validateAgainstSchema } from "../schema/validator.js";
import { extractAutoRoutingTrace, extractResolvedModel } from "../llm/autoRoutingClient.js";
import { collectPlaygroundSystemAddons } from "../playground/systemAddons.js";
import { applyHaxiTagAssembly } from "../protocol/haxiTagAssembly.js";
export class Scheduler {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async run(initial) {
        const request = applyHaxiTagAssembly(initial);
        const sessionId = request.sessionId ?? request.userId;
        const toolResults = [];
        let latestRouting = request.metadata;
        if (this.deps.sessionStore) {
            this.deps.sessionStore.append(sessionId, {
                timestamp: new Date().toISOString(),
                role: "user",
                type: "input",
                content: request.input,
            });
        }
        let context = await this.deps.contextBuilder.build(request);
        const finalize = (content) => {
            if (this.deps.sessionStore) {
                this.deps.sessionStore.append(sessionId, {
                    timestamp: new Date().toISOString(),
                    role: "assistant",
                    type: "final",
                    content,
                });
            }
            return {
                requestId: context.requestId,
                type: "final",
                content,
                toolResults,
                metadata: latestRouting && Object.keys(latestRouting).length > 0
                    ? latestRouting
                    : undefined,
            };
        };
        for (let round = 0; round < context.toolPolicy.maxRounds; round += 1) {
            const tools = this.deps.toolRegistry.listDefinitions(context.toolPolicy.allowed);
            const cfg = this.deps.configStore?.get();
            const systemPromptAddons = cfg
                ? [
                    ...collectPlaygroundSystemAddons(cfg),
                    ...(request.kgm?.playground?.extraSystemPrompt?.trim()
                        ? [request.kgm.playground.extraSystemPrompt.trim()]
                        : []),
                ]
                : request.kgm?.playground?.extraSystemPrompt?.trim()
                    ? [request.kgm.playground.extraSystemPrompt.trim()]
                    : [];
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
                metadata: request.metadata,
                taskInput: request.input,
                taskType: request.routing?.taskType,
                taskName: request.routing?.taskName,
                routing: request.routing,
            });
            latestRouting = {
                ...(request.metadata ?? {}),
                ...(extractAutoRoutingTrace(completion.raw) ? { routing: extractAutoRoutingTrace(completion.raw) } : {}),
                ...(extractResolvedModel(completion.raw) ? { resolved_model: extractResolvedModel(completion.raw) } : {}),
            };
            const intent = parseIntent(completion.text);
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
            context = await this.appendToolResult(context, toolResult, sessionId);
        }
        return finalize("max_rounds_reached");
    }
    async executeIntent(intent, context) {
        if (intent.type === "call") {
            if (!context.toolPolicy.allowed.includes(intent.target)) {
                return null;
            }
            try {
                const output = await this.deps.toolRegistry.execute(intent.target, intent.arguments);
                return { name: intent.target, output, success: true };
            }
            catch (error) {
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
            }
            catch (error) {
                return { name: intent.skill, output: {}, success: false, error: String(error) };
            }
        }
        return null;
    }
    async appendToolResult(context, toolResult, sessionId) {
        const contextToolResult = this.buildContextToolResult(toolResult, context);
        const updated = {
            ...context,
            toolResults: [...context.toolResults, contextToolResult],
        };
        if (this.deps.memoryStore && this.deps.embedder && toolResult.success) {
            const summary = JSON.stringify(contextToolResult.output);
            const embedding = await this.deps.embedder.embed(summary);
            await this.deps.memoryStore.add(buildMemoryChunk({
                id: `${context.requestId}_${toolResult.name}_${context.toolResults.length}`,
                userId: context.userId,
                text: summary,
                embedding,
                source: `tool:${toolResult.name}`,
                embeddingVersion: this.deps.configStore?.get().embedding.version,
            }));
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
    buildContextToolResult(toolResult, context) {
        const config = this.deps.configStore?.get().context;
        const maxChars = config?.maxToolOutputChars ?? 2000;
        const previewChars = config?.artifactPreviewChars ?? 240;
        const normalizedOutput = toolResult.output && typeof toolResult.output === "object" && !Array.isArray(toolResult.output)
            ? toolResult.output
            : { value: toolResult.output };
        const outputJson = JSON.stringify(normalizedOutput);
        if (!this.deps.artifactStore || outputJson.length <= maxChars) {
            return { ...toolResult, output: normalizedOutput };
        }
        const artifact = this.deps.artifactStore.writeJson(`tool_${context.requestId}_${toolResult.name}`, normalizedOutput, previewChars);
        return {
            ...toolResult,
            output: {
                summary: outputJson.slice(0, maxChars),
                artifact_ref: artifact,
            },
        };
    }
}
