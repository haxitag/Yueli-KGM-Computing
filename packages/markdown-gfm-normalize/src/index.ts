export { coerceAssistantContentToString } from './coerce.js';
export {
  normalizeGfmLite,
  fixAtxHeadingSpacing,
  normalizeJammedMarkdownBlockBreaks,
  normalizeMarkdownListsAndPseudoBullets,
  splitPackedEmojiDashListLines,
  splitStuckOpeningFenceFirstLine,
  unwrapOuterMarkdownWrapperFence,
  closeOrphanOpeningFenceBeforeAtxHeading,
  breakLongCjkProseParagraphs
} from './gfm-lite.js';
export {
  prepareChatMessageContent,
  prepareChatMessageForDisplay,
  stripModelWrapperTags,
  compactMarkdownEmptyLines
} from './prepare.js';
export {
  applyOutputNormalizeIfEnabled,
  resolveOutputNormalizeMode,
  type KgmOutputExtensions,
  type OutputNormalizeMode
} from './resolve.js';

import { coerceAssistantContentToString } from './coerce.js';
import { normalizeGfmLite } from './gfm-lite.js';

/** 与历史 Copilot `normalizeAssistantMarkdownForRender` 对齐 */
export function normalizeGfmLiteFromRaw(raw: unknown): string {
  const s = coerceAssistantContentToString(raw);
  return normalizeGfmLite(s);
}
