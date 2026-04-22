/** 解析 Cursor/Codex 风格的 SKILL.md：可选 YAML frontmatter + 正文作为 systemPromptAddon */
export function parseSkillMd(content) {
    const trimmed = content.trim();
    if (trimmed.startsWith("---")) {
        const end = trimmed.indexOf("\n---", 3);
        if (end !== -1) {
            const front = trimmed.slice(3, end).trim();
            const body = trimmed.slice(end + 4).trim();
            let name;
            for (const line of front.split("\n")) {
                const m = line.match(/^name:\s*(.+)$/);
                if (m) {
                    name = m[1].trim().replace(/^["']|["']$/g, "");
                }
            }
            return {
                name,
                description: firstLine(body),
                systemPromptAddon: body,
            };
        }
    }
    return {
        description: firstLine(trimmed),
        systemPromptAddon: trimmed,
    };
}
function firstLine(text) {
    const line = text.split("\n")[0]?.trim() ?? "";
    return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}
