import type { SkillDefinition } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";

export function parseExecutableSkill(payload: {
  name?: string;
  description?: string;
  steps?: unknown;
}): { ok: true; skill: SkillDefinition } | { ok: false; error: string; message: string } {
  const name = payload.name?.trim() ?? "";
  const description = payload.description?.trim() ?? "";
  if (!name) {
    return { ok: false, error: "skill_name_required", message: "Skill name is required." };
  }
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    return {
      ok: false,
      error: "skill_steps_required",
      message: "A skill must include executable steps with tool bindings. Empty skills are not stored.",
    };
  }
  const steps: SkillDefinition["steps"] = [];
  for (const item of payload.steps) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "skill_step_invalid", message: "Each skill step must be an object with id and tool." };
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const tool = typeof rec.tool === "string" ? rec.tool.trim() : "";
    if (!id || !tool) {
      return { ok: false, error: "skill_step_invalid", message: "Each skill step needs a non-empty id and tool." };
    }
    const input =
      rec.input && typeof rec.input === "object" && !Array.isArray(rec.input)
        ? (rec.input as Record<string, unknown>)
        : {};
    steps.push({ id, tool, input });
  }
  return { ok: true, skill: { name, description, steps } };
}

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
