/**
 * 受限 Jinja2 子集，用于 HF `tokenizer_config.json` 中常见 `chat_template` 模式（无 filters、无宏、无继承）。
 *
 * 支持：
 * - `{% for name in list %}` / `{% endfor %}`（可嵌套）
 * - `{% if cond %}` / `{% elif cond %}` / `{% else %}` / `{% endif %}`（可嵌套）；条件支持 `==`、`!=`、`or`（空格分隔）
 * - `{{ path }}`：点号与 `['key']`、`[n]` 取值
 * - 字面量：`true` / `false` / 数字 / 单双引号字符串
 */

export type JinjaLiteContext = Record<string, unknown>;

type Tok =
  | { kind: "text"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "var"; value: string };

export function renderJinjaLite(template: string, root: JinjaLiteContext): string {
  const tokens = tokenize(template);
  return renderRange(tokens, root, 0, tokens.length);
}

function tokenize(template: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < template.length) {
    const v = template.indexOf("{{", i);
    const t = template.indexOf("{%", i);
    const next =
      v >= 0 && t >= 0 ? Math.min(v, t) : v >= 0 ? v : t >= 0 ? t : -1;
    if (next < 0) {
      out.push({ kind: "text", value: template.slice(i) });
      break;
    }
    if (next > i) {
      out.push({ kind: "text", value: template.slice(i, next) });
    }
    if (template.startsWith("{{", next)) {
      const end = template.indexOf("}}", next + 2);
      if (end < 0) {
        throw new Error("jinja_lite: unclosed {{");
      }
      out.push({ kind: "var", value: template.slice(next + 2, end).trim() });
      i = end + 2;
      continue;
    }
    const end = template.indexOf("%}", next + 2);
    if (end < 0) {
      throw new Error("jinja_lite: unclosed {%");
    }
    let inner = template.slice(next + 2, end).trim();
    if (inner.startsWith("-")) {
      inner = inner.slice(1).trim();
    }
    if (inner.endsWith("-")) {
      inner = inner.slice(0, -1).trim();
    }
    out.push({ kind: "tag", value: inner });
    i = end + 2;
  }
  return out;
}

function renderRange(tokens: Tok[], ctx: JinjaLiteContext, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i < end) {
    const t = tokens[i]!;
    if (t.kind === "text") {
      out += t.value;
      i += 1;
      continue;
    }
    if (t.kind === "var") {
      out += formatValue(evalExpr(t.value, ctx));
      i += 1;
      continue;
    }
    const tv = t.value;
    if (/^for\s/.test(tv)) {
      const m = /^for\s+(\w+)\s+in\s+(\w+)$/.exec(tv);
      if (!m) {
        throw new Error(`jinja_lite: unsupported for: ${tv}`);
      }
      const endForIdx = findMatchingEndFor(tokens, i + 1);
      const list = evalPath(ctx, m[2]!);
      let block = "";
      if (Array.isArray(list)) {
        for (const item of list) {
          const innerCtx = { ...ctx, [m[1]!]: item };
          block += renderRange(tokens, innerCtx, i + 1, endForIdx);
        }
      }
      out += block;
      i = endForIdx + 1;
      continue;
    }
    if (tv.startsWith("if ")) {
      const endIfIdx = findMatchingEndIf(tokens, i + 1);
      const branches = splitIfBranches(tokens, i, endIfIdx);
      let matched = false;
      for (const br of branches) {
        if (isElseBranch(br)) {
          if (!matched) {
            out += renderRange(tokens, ctx, br.start, br.end);
          }
          break;
        }
        if (evalCondition(br.cond, ctx)) {
          out += renderRange(tokens, ctx, br.start, br.end);
          matched = true;
          break;
        }
      }
      i = endIfIdx + 1;
      continue;
    }
    if (tv === "endfor" || tv === "endif") {
      throw new Error(`jinja_lite: unexpected ${tv}`);
    }
    throw new Error(`jinja_lite: unsupported tag: ${tv}`);
  }
  return out;
}

function findMatchingEndFor(tokens: Tok[], bodyStart: number): number {
  let depth = 1;
  let i = bodyStart;
  while (i < tokens.length && depth > 0) {
    if (tokens[i]!.kind === "tag") {
      const v = tokens[i]!.value;
      if (/^for\s/.test(v)) {
        depth += 1;
      } else if (v === "endfor") {
        depth -= 1;
      }
    }
    i += 1;
  }
  if (depth !== 0) {
    throw new Error("jinja_lite: unclosed for");
  }
  return i - 1;
}

function findMatchingEndIf(tokens: Tok[], bodyStart: number): number {
  let depth = 1;
  let i = bodyStart;
  while (i < tokens.length && depth > 0) {
    if (tokens[i]!.kind === "tag") {
      const v = tokens[i]!.value;
      if (v.startsWith("if ")) {
        depth += 1;
      } else if (v === "endif") {
        depth -= 1;
      }
    }
    i += 1;
  }
  if (depth !== 0) {
    throw new Error("jinja_lite: unclosed if");
  }
  return i - 1;
}

type IfBranch =
  | { cond: string; start: number; end: number }
  | { elseBranch: true; start: number; end: number };

function isElseBranch(br: IfBranch): br is { elseBranch: true; start: number; end: number } {
  return "elseBranch" in br && br.elseBranch;
}

/** 解析 `if` / `elif` / `else` 链；各段 `end` 为 **不包含** 的结束下标。 */
function splitIfBranches(tokens: Tok[], ifIdx: number, endifIdx: number): IfBranch[] {
  const ifTag = tokens[ifIdx]!.value;
  if (!ifTag.startsWith("if ")) {
    throw new Error("jinja_lite: expected if");
  }
  let currentCond = ifTag.slice(3).trim();
  const branches: IfBranch[] = [];
  let segmentStart = ifIdx + 1;
  let pos = ifIdx + 1;
  let nest = 0;
  while (pos < endifIdx) {
    const t = tokens[pos]!;
    if (t.kind === "tag") {
      const v = t.value;
      if (v.startsWith("if ")) {
        nest += 1;
        pos += 1;
        continue;
      }
      if (v === "endif") {
        nest -= 1;
        pos += 1;
        continue;
      }
      if (nest === 0 && v.startsWith("elif ")) {
        branches.push({ cond: currentCond, start: segmentStart, end: pos });
        currentCond = v.slice(5).trim();
        segmentStart = pos + 1;
        pos += 1;
        continue;
      }
      if (nest === 0 && v === "else") {
        branches.push({ cond: currentCond, start: segmentStart, end: pos });
        branches.push({ elseBranch: true, start: pos + 1, end: endifIdx });
        return branches;
      }
    }
    pos += 1;
  }
  branches.push({ cond: currentCond, start: segmentStart, end: endifIdx });
  return branches;
}

function evalExpr(expr: string, ctx: JinjaLiteContext): unknown {
  return evalPath(ctx, expr.trim());
}

function evalCondition(expr: string, ctx: JinjaLiteContext): boolean {
  const parts = expr.split(/\s+or\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.some((p) => evalSingleCondition(p, ctx));
  }
  return evalSingleCondition(expr, ctx);
}

function evalSingleCondition(expr: string, ctx: JinjaLiteContext): boolean {
  const e = expr.trim();
  const neIdx = e.indexOf("!=");
  if (neIdx >= 0) {
    const left = e.slice(0, neIdx).trim();
    const right = e.slice(neIdx + 2).trim();
    return String(evalPath(ctx, left)) !== String(evalPath(ctx, right));
  }
  const idx = e.indexOf("==");
  if (idx >= 0) {
    const left = e.slice(0, idx).trim();
    const right = e.slice(idx + 2).trim();
    return String(evalPath(ctx, left)) === String(evalPath(ctx, right));
  }
  return Boolean(evalPath(ctx, e));
}

function evalPath(ctx: JinjaLiteContext, raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  const segments = parsePathSegments(trimmed);
  let cur: unknown = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    if (typeof seg === "string") {
      if (typeof cur !== "object" || cur === null) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      if (!Array.isArray(cur)) {
        return undefined;
      }
      cur = cur[seg];
    }
  }
  return cur;
}

function parsePathSegments(s: string): Array<string | number> {
  const str = s.trim();
  const segs: Array<string | number> = [];
  let i = 0;
  const ident = /^([a-zA-Z_]\w*)/.exec(str.slice(i));
  if (!ident) {
    throw new Error(`jinja_lite: bad path: ${s}`);
  }
  segs.push(ident[1]!);
  i += ident[0].length;
  while (i < str.length) {
    if (str[i] === ".") {
      i += 1;
      const id = /^([a-zA-Z_]\w*)/.exec(str.slice(i));
      if (!id) {
        throw new Error(`jinja_lite: bad path: ${s}`);
      }
      segs.push(id[1]!);
      i += id[0].length;
    } else if (str[i] === "[") {
      i += 1;
      if (str[i] === "'" || str[i] === '"') {
        const q = str[i]!;
        i += 1;
        const start = i;
        while (i < str.length && str[i] !== q) {
          i += 1;
        }
        const key = str.slice(start, i);
        i += 1;
        if (str[i] !== "]") {
          throw new Error(`jinja_lite: bad path: ${s}`);
        }
        i += 1;
        segs.push(key);
      } else {
        const num = /^(\d+)/.exec(str.slice(i));
        if (!num) {
          throw new Error(`jinja_lite: bad path: ${s}`);
        }
        segs.push(Number(num[1]));
        i += num[0].length;
        if (str[i] !== "]") {
          throw new Error(`jinja_lite: bad path: ${s}`);
        }
        i += 1;
      }
    } else {
      break;
    }
  }
  if (i < str.length) {
    throw new Error(`jinja_lite: bad path tail: ${str.slice(i)}`);
  }
  return segs;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (typeof v === "object") {
    return "";
  }
  return String(v);
}
