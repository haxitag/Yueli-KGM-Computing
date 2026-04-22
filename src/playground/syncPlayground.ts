import type { ConfigStore } from "../core/configStore.js";
import type { SkillDefinition } from "../core/types.js";
import { SkillRegistry } from "../skills/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import { registerMcpPlaygroundTool } from "../tools/mcpTools.js";

/** 从 ConfigStore.playground 同步技能定义到 SkillRegistry，并确保 mcp_call 工具已注册 */
export function syncPlaygroundFromConfig(params: {
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  configStore: ConfigStore;
}): void {
  const { skillRegistry, toolRegistry, configStore } = params;
  const pg = configStore.get().playground;
  skillRegistry.clear();
  for (const entry of pg.skills) {
    const def: SkillDefinition = {
      name: entry.name,
      description: entry.description,
      steps: entry.steps,
    };
    skillRegistry.register(def);
  }
  if (!toolRegistry.getDefinition("mcp_call")) {
    registerMcpPlaygroundTool(toolRegistry, () => configStore.get().playground);
  }
}
