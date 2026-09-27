/**
 * GFM-lite：确定性技术修复，不依赖模型遵守 Markdown 规范。
 * 覆盖 ATX 标题空格、围栏、列表空行、块级断行等。
 */

export function splitStuckOpeningFenceFirstLine(md: string): string {
  const lines = md.split('\n');
  if (lines.length === 0) return md;
  const first = lines[0];
  const m = /^(\s*```)([A-Za-z0-9_+-]*)(.*)$/.exec(first);
  if (!m) return md;
  const tail = (m[3] || '').trimStart();
  if (!tail) return md;
  return [`${m[1]}${m[2]}`, tail, ...lines.slice(1)].join('\n');
}

export function unwrapOuterMarkdownWrapperFence(md: string): string {
  let s = md.replace(/^\uFEFF/, '').trim();
  let depth = 0;
  while (depth < 3 && s.length > 0) {
    const lines = s.split('\n');
    if (lines.length < 3) break;
    const first = lines[0].trim();
    const last = lines[lines.length - 1].trim();
    if (!/^```(markdown|md)\s*$/i.test(first) || last !== '```') break;
    s = lines.slice(1, -1).join('\n').trim();
    depth++;
  }
  return s;
}

export function closeOrphanOpeningFenceBeforeAtxHeading(md: string): string {
  const lines = md.split('\n');
  let start = 0;
  while (start < lines.length && /^\s*$/.test(lines[start])) start++;
  if (start >= lines.length) return md;
  const openLine = lines[start].trim();
  if (!/^```[A-Za-z0-9_+-]*$/.test(openLine)) return md;

  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```\s*$/.test(lines[i])) return md;
  }

  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{1,6}\s+\S/.test(t) || /^#{1,6}[^\s#]/.test(t)) {
      const before = lines.slice(0, i).join('\n');
      const after = lines.slice(i).join('\n');
      return `${before}\n\`\`\`\n\n${after}`;
    }
  }
  return md;
}

/** `##写在前面` → `## 写在前面`；`###2.1` → `### 2.1` */
export function fixAtxHeadingSpacing(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const m = /^(\s{0,3})(#{1,6})([^\s#].*)$/.exec(line);
    if (m) {
      line = `${m[1]}${m[2]} ${m[3]}`;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 句号/分隔线/标题挤在同一行时插入块级换行（来自 yueli-deck messageContentPipeline）。
 */
export function normalizeJammedMarkdownBlockBreaks(s: string): string {
  let t = s;
  t = t.replace(/([。！？；」』.)\]]])\s*(-{3,})\s*(#{1,6}\s)/g, '$1\n\n$2\n\n$3');
  t = t.replace(/([。！？；」』.)\]]])\s*(#{1,6}\s)/g, '$1\n\n$2');
  t = t.replace(/([。！？；」』.)\]]])\s*(#{1,6})([^\s#])/g, '$1\n\n$2 $3');
  t = t.replace(/([^\s\n#])(-{3,})(#{1,6}\s)/g, '$1\n\n$2\n\n$3');
  t = t.replace(/([^\s\n#])(#{1,6})([^\s#\n])/g, '$1\n\n$2 $3');
  return t;
}

function isMarkdownListItemLine(line: string): boolean {
  const t = line.replace(/^\s+/, '');
  if (/^[-*+]\s+\[[ xX]\]\s+\S/.test(t)) return true;
  if (/^[-*+]\s+\S/.test(t)) return true;
  if (/^\d+\.\s+\S/.test(t)) return true;
  return false;
}

function isListContinuationLine(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function isAtxHeadingLine(line: string): boolean {
  const t = line.trim();
  return /^#{1,6}\s+\S/.test(t) || /^#{1,6}[^\s#]/.test(t);
}

function isThematicBreakLine(line: string): boolean {
  const t = line.trim();
  return /^([-*_])\1{2,}\s*$/.test(t);
}

export function normalizeMarkdownListsAndPseudoBullets(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    line = line.replace(/^(\s*)[\u2014\u2013]\s+/u, '$1- ');
    line = line.replace(/^(\s*)\u2022\s+/u, '$1- ');

    if (isMarkdownListItemLine(line) && out.length > 0) {
      const prev = out[out.length - 1] ?? '';
      const prevTrim = prev.trim();
      if (prevTrim !== '') {
        const prevIsList = isListContinuationLine(prev);
        const prevIsHeading = isAtxHeadingLine(prev);
        const prevIsHr = isThematicBreakLine(prev);
        const prevIsFence = prevTrim.startsWith('```');
        if (!prevIsList && !prevIsHeading && !prevIsHr && !prevIsFence) {
          out.push('');
        }
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u2600-\u27BF]/u;
const EMOJI_G = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u2600-\u27BF]/gu;

/** 行内「•」与 CommonMark 列表标记对齐 */
function normalizeInlineBulletChars(line: string): string {
  let s = line.replace(/^\s*\u2022\s+/u, '- ');
  s = s.replace(/\s+\u2022\s+/gu, '\n- ');
  return s;
}

/** 同一行内多个「emoji + 说明」能力项（🌐… 💻… 📊…）拆成多行列表 */
function splitPackedEmojiCapabilityItems(line: string): string {
  const emojiCount = [...line.matchAll(EMOJI_G)].length;
  if (emojiCount < 2) return line;
  if (emojiCount < 3 && line.length < 24) return line;

  let s = line;
  s = s.replace(/\s*\*\*\s*[\u2014\u2013]\s*/g, '\n\n');
  s = s.replace(/\s*[\u2014\u2013]\s+(?=[\p{Extended_Pictographic}\u2600-\u27BF])/gu, '\n- ');
  s = s.replace(
    /([^\s\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u2600-\u27BF\-+*])(\s+)(?=[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u2600-\u27BF])/gu,
    '$1\n\n- ',
  );
  return s;
}

function pushNormalizedListPart(part: string, out: string[]): void {
  if (/^[-*+]\s/.test(part) || isMarkdownListItemLine(part)) {
    out.push(part);
  } else if (EMOJI_RE.test(part) && !/^[-*+]\s/.test(part)) {
    out.push(`- ${part.replace(/^[\u2014\u2013\u2022•]\s*/u, '')}`);
  } else {
    out.push(part);
  }
}

function emitSplitLineParts(line: string, out: string[]): void {
  const parts = line
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  for (let part of parts) {
    const emojiCount = [...part.matchAll(EMOJI_G)].length;
    if (emojiCount >= 3 || (emojiCount >= 2 && part.length > 24)) {
      part = splitPackedEmojiCapabilityItems(part);
      for (const sub of part
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean)) {
        pushNormalizedListPart(sub, out);
      }
      continue;
    }
    pushNormalizedListPart(part, out);
  }
}

export function splitPackedEmojiDashListLines(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    line = normalizeInlineBulletChars(line);
    const emojiCount = [...line.matchAll(EMOJI_G)].length;
    const hasEmDashBullets = /[\u2014\u2013]\s*[\p{Extended_Pictographic}\u2600-\u27BF]/u.test(line);
    const shouldSplitPacked =
      (emojiCount >= 2 && hasEmDashBullets) ||
      emojiCount >= 3 ||
      (emojiCount >= 2 && line.length > 24);

    if (shouldSplitPacked) {
      line = splitPackedEmojiCapabilityItems(line);
      emitSplitLineParts(line, out);
      continue;
    }

    line = line.replace(/(\S)\s+[\u2014\u2013]\s+(?=[\p{Extended_Pictographic}\u2600-\u27BF])/gu, '$1\n- ');
    out.push(line);
  }

  return out.join('\n');
}

/**
 * 模型常输出整段无换行的中文长文：在句末标点后插入段落空行（仅处理超长行，避免破坏列表/表格）。
 */
export function breakLongCjkProseParagraphs(md: string, minLineLen = 48): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || trimmed.length < minLineLen) {
      out.push(line);
      continue;
    }
    if (/^\s*[-*+]\s/.test(trimmed) || /^\s*\d+\.\s/.test(trimmed) || /^\|/.test(trimmed)) {
      out.push(line);
      continue;
    }

    line = line.replace(
      /([。！？!?；;])(?=[\u4e00-\u9fff\u3400-\u4dbf"A-Za-z0-9])/g,
      '$1\n\n',
    );
    line = line.replace(/([.!?])([A-Za-z\u4e00-\u9fff])/g, '$1\n\n$2');
    out.push(line);
  }

  return out.join('\n');
}

export type NormalizeGfmLiteOptions = {
  /** 流式中间态可关，避免对半截句子反复插入空行 */
  breakProse?: boolean;
};

/** 技术向 GFM-lite 流水线（不含 UI 标签剥离） */
export function normalizeGfmLite(md: string, options?: NormalizeGfmLiteOptions): string {
  let s = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = unwrapOuterMarkdownWrapperFence(s);
  s = splitStuckOpeningFenceFirstLine(s);
  s = closeOrphanOpeningFenceBeforeAtxHeading(s);
  s = normalizeJammedMarkdownBlockBreaks(s);
  s = fixAtxHeadingSpacing(s);
  s = splitPackedEmojiDashListLines(s);
  s = normalizeMarkdownListsAndPseudoBullets(s);
  if (options?.breakProse !== false) {
    s = breakLongCjkProseParagraphs(s);
  }
  return s;
}
