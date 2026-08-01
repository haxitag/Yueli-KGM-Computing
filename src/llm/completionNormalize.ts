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
 * 从 provider 返回体抽取 usage；无法识别时返回 undefined（由调用方回退到估算）。
 */
export function extractStructuredCompletion(raw: unknown, _providerHint?: string): StructuredCompletionFields {
  if (!isRecord(raw)) {
    return {};
  }

  const usageBlock = raw.usage;
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
    const promptEval = num(raw.prompt_eval_count);
    const evalCount = num(raw.eval_count);
    if (promptEval !== undefined) {
      prompt = promptEval;
      found = true;
    }
    if (evalCount !== undefined) {
      completion = evalCount;
      found = true;
    }
  }

  const model = typeof raw.model === "string" ? raw.model : undefined;
  const firstChoice =
    Array.isArray(raw.choices) && raw.choices.length > 0 && isRecord(raw.choices[0]) ? raw.choices[0] : undefined;
  const finishReason =
    typeof raw.finish_reason === "string"
      ? raw.finish_reason
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
 * 将结构化 usage 与启发式估算合并：优先采用 raw 中解析出的非零字段。
 */
export function mergeUsageWithEstimates(
  structured: StructuredCompletionFields,
  estimatedPrompt: number,
  estimatedCompletion: number,
): NormalizedTokenUsage {
  const u = structured.usage;
  if (!u) {
    return {
      prompt_tokens: estimatedPrompt,
      completion_tokens: estimatedCompletion,
      total_tokens: estimatedPrompt + estimatedCompletion,
    };
  }
  return {
    prompt_tokens: u.prompt_tokens > 0 ? u.prompt_tokens : estimatedPrompt,
    completion_tokens: u.completion_tokens > 0 ? u.completion_tokens : estimatedCompletion,
    total_tokens:
      u.total_tokens > 0
        ? u.total_tokens
        : (u.prompt_tokens > 0 ? u.prompt_tokens : estimatedPrompt) +
          (u.completion_tokens > 0 ? u.completion_tokens : estimatedCompletion),
  };
}
