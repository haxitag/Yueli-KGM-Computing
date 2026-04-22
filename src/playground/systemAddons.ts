import type { KgmConfig } from "../core/configStore.js";

/** 将 Playground 中激活的技能 / MCP 说明拼入系统提示 */
export function collectPlaygroundSystemAddons(config: KgmConfig): string[] {
  const pg = config.playground;
  const out: string[] = [];
  const skillById = new Map(pg.skills.map((s) => [s.id, s]));
  for (const id of pg.activeSkillIds) {
    const s = skillById.get(id);
    if (s?.systemPromptAddon?.trim()) {
      out.push(s.systemPromptAddon.trim());
    }
  }
  if (pg.activeMcpIds.length > 0) {
    const mcps = pg.mcpConnectors.filter((c) => pg.activeMcpIds.includes(c.id) && c.enabled);
    if (mcps.length > 0) {
      out.push(
        `已启用的 MCP 连接器（通过内置工具 mcp_call 调用，参数 connectorId/toolName/arguments）：${mcps
          .map((m) => `${m.name} [id=${m.id}, ${m.transport}]`)
          .join("；")}`,
      );
    }
  }
  return out;
}
