import type { KgmRequest, Signal } from "../core/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 将 HaxiTAG / Studio 装配结果（常置于 `metadata` 的扁平或嵌套字段）显式映射到
 * `KgmRequest` 的 signals / metadata / 专用 `kgm` 槽位，与 `normalizeMessages` 职责分离。
 *
 * 约定字段（可选用其一，语义优先于同名）：
 * - `metadata.haxitag`：{ fullPrompt?, contextText?, contextBuilderHints? }
 * - `metadata.fullprompt` / `metadata.haxitag_fullprompt`：装配后的完整提示片段
 * - `metadata.haxitag_context`：装配侧附加上下文文本
 */
export function applyHaxiTagAssembly(request: KgmRequest): KgmRequest {
  const metadata = (request.metadata ?? {}) as Record<string, unknown>;
  const next: KgmRequest = { ...request, metadata: { ...metadata } };

  const haxitag = isRecord(metadata.haxitag) ? metadata.haxitag : undefined;
  const fullPrompt =
    (typeof haxitag?.fullPrompt === "string" && haxitag.fullPrompt) ||
    (typeof metadata.fullprompt === "string" && metadata.fullprompt) ||
    (typeof metadata.haxitag_fullprompt === "string" && metadata.haxitag_fullprompt) ||
    undefined;

  const contextText =
    (typeof haxitag?.contextText === "string" && haxitag.contextText) ||
    (typeof metadata.haxitag_context === "string" && metadata.haxitag_context) ||
    undefined;

  const hints =
    haxitag?.contextBuilderHints && isRecord(haxitag.contextBuilderHints)
      ? haxitag.contextBuilderHints
      : undefined;

  const extraSignals: Signal[] = [];

  if (fullPrompt?.trim()) {
    extraSignals.push({
      type: "system",
      source: "haxitag.fullprompt",
      title: "HaxiTAG assembled prompt",
      value: fullPrompt.trim(),
    });
  }

  if (contextText?.trim()) {
    extraSignals.push({
      type: "retrieval",
      source: "haxitag.context",
      title: "HaxiTAG assembled context",
      value: contextText.trim(),
    });
  }

  if (hints && Object.keys(hints).length > 0) {
    extraSignals.push({
      type: "app",
      source: "haxitag.contextbuilder",
      title: "HaxiTAG context builder hints",
      value: JSON.stringify(hints),
      metadata: hints,
    });
  }

  if (extraSignals.length === 0) {
    return next;
  }

  next.signals = [...(request.signals ?? []), ...extraSignals];

  const md = next.metadata as Record<string, unknown>;
  md.haxitag_normalized = true;
  return next;
}
