import { registerMcpPlaygroundTool } from "../tools/mcpTools.js";
/** Skills with executable steps only; systemPromptAddon-only entries stay prompt addons via collectPlaygroundSystemAddons. */
export function isExecutableSkill(entry) {
    return Boolean(entry.steps?.some((step) => Boolean(step.tool?.trim())));
}
/** 从 ConfigStore.playground 同步技能定义到 SkillRegistry，并确保 mcp_call 工具已注册 */
export function syncPlaygroundFromConfig(params) {
    const { skillRegistry, toolRegistry, configStore } = params;
    const pg = configStore.get().playground;
    skillRegistry.clear();
    for (const entry of pg.skills) {
        if (!isExecutableSkill(entry)) {
            continue;
        }
        const def = {
            name: entry.name,
            description: entry.description,
            steps: entry.steps.filter((step) => Boolean(step.tool?.trim())),
        };
        skillRegistry.register(def);
    }
    if (!toolRegistry.getDefinition("mcp_call")) {
        registerMcpPlaygroundTool(toolRegistry, () => configStore.get().playground);
    }
}
