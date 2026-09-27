import {
  normalizeGfmLite,
  normalizeJammedMarkdownBlockBreaks,
  type NormalizeGfmLiteOptions,
} from './gfm-lite.js';

/**
 * 聊天展示向预处理：在 gfm-lite 之后剥离模型/XML 包裹、清理历史存储噪声。
 * 对齐 yueli-deck messageContentPipeline + MarkdownRenderer.cleanEmptyLines。
 */
export function stripModelWrapperTags(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?planning[^>]*>[\s\S]*?<\/planning>/g, '')
    .replace(/<\/?response_content[^>]*>[\s\S]*?<\/response_content>/g, '')
    .replace(/<message[^>]*>([\s\S]*?)<\/message>/gi, '$1')
    .replace(/<response[^>]*>([\s\S]*?)<\/response>/gi, '$1')
    .replace(/<\/?message[^>]*>/gi, '')
    .replace(/<\/?response[^>]*>/gi, '')
    .replace(/<(?!(?:redacted_thinking|thinking)\b)([a-zA-Z0-9_-]+)[^>]*>(?!.*<\/\1>)/g, '')
    .replace(/\s*\+\s*$/gm, '')
    .replace(/^\s*\+\s*/gm, '')
    .replace(/\s*\+\s*/g, ' ')
    .replace(/\\n/g, '\n');
}

export function compactMarkdownEmptyLines(md: string): string {
  let cleaned = md.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  cleaned = cleaned.replace(/\r\n?/g, '\n');
  cleaned = cleaned.replace(/(\n[ \t\u3000]*){2,}/g, '\n\n');
  cleaned = cleaned.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');

  cleaned = cleaned.replace(/([^\n])\n{2,}(#+ )/g, '$1\n$2');
  cleaned = cleaned.replace(/(#+ [^\n]+)\n{2,}([^\n])/g, '$1\n$2');
  cleaned = cleaned.replace(/([^\n])\n{2,}(\s*[-*+]|[0-9]+\.)/g, '$1\n$2');
  cleaned = cleaned.replace(/(\n\s*[-*+][^\n]+(?:\n\s*[-*+][^\n]+)*)\n{2,}([^\n])/g, '$1\n$2');
  cleaned = cleaned.replace(/([^\n])\n{2,}(> )/g, '$1\n$2');
  cleaned = cleaned.replace(/((?:^|\n)>[^\n]+)\n{2,}([^\n])/g, '$1\n$2');
  cleaned = cleaned.replace(/([^\n])\n{2,}(```)/g, '$1\n$2');
  cleaned = cleaned.replace(/(```[^\n]*\n[\s\S]*?```)\n{2,}([^\n])/g, '$1\n$2');
  cleaned = cleaned.replace(/([^\n])\n{2,}(\|)/g, '$1\n$2');
  cleaned = cleaned.replace(/((?:^|\n)\|[^\n]+)\n{2,}([^\n])/g, '$1\n$2');
  cleaned = cleaned.replace(/(\n[\s\u3000]*){2,}/g, '\n\n');

  return cleaned;
}

/**
 * deck 对齐的轻量正文 prepare（yueli-deck messageContentPipeline.prepareChatMessageContent）。
 * 仅标签剥离 + 存储噪声 + 块级断行，不跑完整 gfm-lite。
 */
export function prepareChatMessageContent(raw: string): string {
  if (!raw) return '';
  const stripped = stripModelWrapperTags(raw)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
  return normalizeJammedMarkdownBlockBreaks(stripped);
}

/**
 * Copilot 聊天展示：deck prepare + gfm-lite。
 * 默认 breakProse: false，避免长段中文被拆成「文字墙」。
 * 不再默认 compactMarkdownEmptyLines。
 */
export function prepareChatMessageForDisplay(
  raw: string,
  options?: { compact?: boolean } & NormalizeGfmLiteOptions,
): string {
  if (!raw) return '';
  const { compact, breakProse = false, ...gfmOpts } = options ?? {};
  const base = prepareChatMessageContent(raw);
  const normalized = normalizeGfmLite(base, { breakProse, ...gfmOpts });
  return compact ? compactMarkdownEmptyLines(normalized) : normalized;
}
