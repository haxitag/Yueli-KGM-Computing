/**
 * 从各引擎 `CompletionResult.raw` 做结构化抽取，供 compat 层统一 token 用量与观测，
 * 减少在 OpenAI/Anthropic 适配里重复解析。
 */

export type NormalizedTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type StructuredCompletionFields = {
  usage?: NormalizedTokenUsage;
  /** 原始 finish_reason（若存在） */
  finishReason?: string;
  model?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Managed / failover 包装会把上游 body 放进 `result`。用量必须读到真正的上游对象。
 */
export function unwrapProviderRaw(raw: unknown): unknown {
  let current = raw;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6; depth += 1) {
    if (!isRecord(current) || seen.has(current)) {
      return current;
    }
    seen.add(current);
    if (isRecord(current.usage) || typeof current.prompt_eval_count === "number" || typeof current.eval_count === "number") {
      return current;
    }
    if ("result" in current) {
      current = current.result;
      continue;
    }
    break;
  }
  return current;
}

/**
 * 从 provider 返回体抽取 usage；无法识别时返回 undefined（由调用方回退到估算）。
 */
export function extractStructuredCompletion(raw: unknown, _providerHint?: string): StructuredCompletionFields {
  const body = unwrapProviderRaw(raw);
  if (!isRecord(body)) {
    return {};
  }

  const usageBlock = body.usage;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let found = false;

  if (isRecord(usageBlock)) {
    const p =
      num(usageBlock.prompt_tokens) ??
      num(usageBlock.input_tokens) ??
      num(usageBlock.prompt_tokens_total);
    const c =
      num(usageBlock.completion_tokens) ??
      num(usageBlock.output_tokens) ??
      num(usageBlock.completion_tokens_total);
    const t = num(usageBlock.total_tokens);
    if (p !== undefined) {
      prompt = p;
      found = true;
    }
    if (c !== undefined) {
      completion = c;
      found = true;
    }
    if (t !== undefined) {
      total = t;
      found = true;
    }
  }

  // Ollama /api/chat 常见字段（仅当未从标准 usage 解析到 token 时使用）
  if (!found) {
    const promptEval = num(body.prompt_eval_count);
    const evalCount = num(body.eval_count);
    if (promptEval !== undefined) {
      prompt = promptEval;
      found = true;
    }
    if (evalCount !== undefined) {
      completion = evalCount;
      found = true;
    }
  }

  const model = typeof body.model === "string" ? body.model : undefined;
  const firstChoice =
    Array.isArray(body.choices) && body.choices.length > 0 && isRecord(body.choices[0]) ? body.choices[0] : undefined;
  const finishReason =
    typeof body.finish_reason === "string"
      ? body.finish_reason
      : typeof firstChoice?.finish_reason === "string"
        ? firstChoice.finish_reason
        : undefined;

  if (!found) {
    return {
      model,
      finishReason,
    };
  }

  if (total === 0 && prompt + completion > 0) {
    total = prompt + completion;
  }

  return {
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total > 0 ? total : prompt + completion,
    },
    model,
    finishReason,
  };
}

/**
 * 有上游 usage 时原样采用（含合法的 0）；没有 usage 时才用估算，并标 estimated。
 */
export function mergeUsageWithEstimates(
  structured: StructuredCompletionFields,
  estimatedPrompt: number,
  estimatedCompletion: number,
): NormalizedTokenUsage & { estimated: boolean } {
  const u = structured.usage;
  if (!u) {
    return {
      prompt_tokens: estimatedPrompt,
      completion_tokens: estimatedCompletion,
      total_tokens: estimatedPrompt + estimatedCompletion,
      estimated: true,
    };
  }
  const total =
    u.total_tokens > 0 ? u.total_tokens : u.prompt_tokens + u.completion_tokens;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: total,
    estimated: false,
  };
}
