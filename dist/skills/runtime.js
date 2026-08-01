export class SkillRegistry {
    skills = new Map();
    register(skill) {
        this.skills.set(skill.name, skill);
    }
    get(name) {
        return this.skills.get(name);
    }
    listNames() {
        return Array.from(this.skills.keys());
    }
    clear() {
        this.skills.clear();
    }
}
export class SkillRuntime {
    registry;
    tools;
    constructor(registry, tools) {
        this.registry = registry;
        this.tools = tools;
    }
    listNames() {
        return this.registry.listNames();
    }
    getSkillRegistry() {
        return this.registry;
    }
    async run(skillName, input) {
        const skill = this.registry.get(skillName);
        if (!skill) {
            throw new Error(`skill not found: ${skillName}`);
        }
        if (!skill.steps || skill.steps.length === 0) {
            throw new Error(`skill_has_no_executable_steps:${skillName};provide steps with tool bindings (systemPromptAddon alone is not executable)`);
        }
        const results = { input };
        for (const step of skill.steps) {
            if (!step.tool?.trim()) {
                throw new Error(`skill_step_missing_tool:${skillName}:${step.id}`);
            }
            const resolvedInput = resolveStepInput(step.input, results);
            results[step.id] = await this.tools.execute(step.tool, resolvedInput);
        }
        return results;
    }
}
function resolveStepInput(template, results) {
    const resolved = {};
    for (const [key, value] of Object.entries(template)) {
        if (typeof value === "string") {
            resolved[key] = value.replace(/\{\{\s*([^\}]+)\s*\}\}/g, (_match, path) => {
                const trimmed = String(path).trim();
                const got = lookupResultPath(results, trimmed);
                if (got === undefined || got === null) {
                    return "";
                }
                return typeof got === "object" ? JSON.stringify(got) : String(got);
            });
        }
        else {
            resolved[key] = value;
        }
    }
    return resolved;
}
function lookupResultPath(root, path) {
    const segments = path.split(".").map((s) => s.trim()).filter(Boolean);
    let cur = root;
    for (const seg of segments) {
        if (cur && typeof cur === "object" && seg in cur) {
            cur = cur[seg];
        }
        else {
            return undefined;
        }
    }
    return cur;
}
