/** OpenAI/KGM 多模态：content 可能为 [{ type:'text', text:'...' }, ...] */
export function coerceAssistantContentToString(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (part == null) return '';
        if (typeof part === 'string') return part;
        if (typeof part === 'object') {
          const o = part as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (typeof o.content === 'string') return o.content;
        }
        return '';
      })
      .join('');
  }
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
  }
  return String(raw);
}
