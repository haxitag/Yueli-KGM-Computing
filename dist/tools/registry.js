export class ToolRegistry {
    tools = new Map();
    register(definition, executor) {
        this.tools.set(definition.name, { definition, executor });
    }
    getDefinition(name) {
        return this.tools.get(name)?.definition;
    }
    listDefinitions(allowed) {
        const defs = Array.from(this.tools.values()).map((entry) => entry.definition);
        if (!allowed || allowed.length === 0) {
            return defs;
        }
        return defs.filter((def) => allowed.includes(def.name));
    }
    async execute(name, args) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`tool not found: ${name}`);
        }
        return tool.executor(args);
    }
}
