import type { ToolDefinition, ToolExecutor } from "../core/types.js";

export type ToolRecord = {
  definition: ToolDefinition;
  executor: ToolExecutor;
};

export class ToolRegistry {
  private tools = new Map<string, ToolRecord>();
  private callTotal = 0;
  private callByName = new Map<string, number>();

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor });
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  listDefinitions(allowed?: string[]): ToolDefinition[] {
    const defs = Array.from(this.tools.values()).map((entry) => entry.definition);
    if (!allowed || allowed.length === 0) {
      return defs;
    }
    return defs.filter((def) => allowed.includes(def.name));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`tool not found: ${name}`);
    }
    this.callTotal += 1;
    this.callByName.set(name, (this.callByName.get(name) ?? 0) + 1);
    return tool.executor(args);
  }

  getCallStats(): { total: number; byName: Record<string, number> } {
    return {
      total: this.callTotal,
      byName: Object.fromEntries(this.callByName),
    };
  }
}
