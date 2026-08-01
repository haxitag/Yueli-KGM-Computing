import type { SkillDefinition } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  listNames(): string[] {
    return Array.from(this.skills.keys());
  }

  clear(): void {
    this.skills.clear();
  }
}

export class SkillRuntime {
  private registry: SkillRegistry;
  private tools: ToolRegistry;

  constructor(registry: SkillRegistry, tools: ToolRegistry) {
    this.registry = registry;
    this.tools = tools;
  }

  listNames(): string[] {
    return this.registry.listNames();
  }

  getSkillRegistry(): SkillRegistry {
    return this.registry;
  }

  async run(skillName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const skill = this.registry.get(skillName);
    if (!skill) {
      throw new Error(`skill not found: ${skillName}`);
    }
    if (!skill.steps || skill.steps.length === 0) {
      throw new Error(
        `skill_has_no_executable_steps:${skillName};provide steps with tool bindings (systemPromptAddon alone is not executable)`,
      );
    }

    const results: Record<string, unknown> = { input };

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

function resolveStepInput(
  template: Record<string, unknown>,
  results: Record<string, unknown>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
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
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function lookupResultPath(root: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").map((s) => s.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur && typeof cur === "object" && seg in (cur as object)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}
