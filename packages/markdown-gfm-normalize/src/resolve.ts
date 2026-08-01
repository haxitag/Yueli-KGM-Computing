import { normalizeGfmLite } from './gfm-lite.js';

export type OutputNormalizeMode = 'gfm-lite';

export type KgmOutputExtensions = {
  extensions?: {
    output?: {
      normalize?: OutputNormalizeMode;
    };
  };
};

function readNormalizeFromRecord(rec: Record<string, unknown> | undefined): OutputNormalizeMode | undefined {
  if (!rec) return undefined;
  const ext = rec.extensions;
  if (ext && typeof ext === 'object') {
    const output = (ext as Record<string, unknown>).output;
    if (output && typeof output === 'object') {
      const mode = (output as Record<string, unknown>).normalize;
      if (mode === 'gfm-lite') return 'gfm-lite';
    }
  }
  if (rec.kgm_output_normalize === 'gfm-lite' || rec.output_normalize === 'gfm-lite') {
    return 'gfm-lite';
  }
  return undefined;
}

/**
 * 解析是否启用 gfm-lite。优先级：
 * 1. HTTP 头 X-KGM-Output-Normalize / X-Yueli-Output-Normalize
 * 2. kgm.extensions.output.normalize
 * 3. metadata.extensions.output.normalize / metadata.kgm_output_normalize
 */
export function resolveOutputNormalizeMode(
  kgm?: KgmOutputExtensions | null,
  metadata?: Record<string, unknown> | null,
  headers?: Record<string, string | string[] | undefined> | Headers | null
): OutputNormalizeMode | undefined {
  if (headers) {
    const h =
      headers instanceof Headers
        ? {
            xKgm: headers.get('x-kgm-output-normalize') ?? headers.get('X-KGM-Output-Normalize'),
            xYueli: headers.get('x-yueli-output-normalize') ?? headers.get('X-Yueli-Output-Normalize')
          }
        : {
            xKgm:
              (headers['x-kgm-output-normalize'] as string) ??
              (headers['X-KGM-Output-Normalize'] as string),
            xYueli:
              (headers['x-yueli-output-normalize'] as string) ??
              (headers['X-Yueli-Output-Normalize'] as string)
          };
    const headerVal = (h.xKgm ?? h.xYueli ?? '').toString().trim().toLowerCase();
    if (headerVal === 'off' || headerVal === 'false' || headerVal === '0' || headerVal === 'none') {
      return undefined;
    }
    if (headerVal === 'gfm-lite') return 'gfm-lite';
  }

  const fromKgm = readNormalizeFromRecord(kgm as Record<string, unknown> | undefined);
  if (fromKgm) return fromKgm;

  return readNormalizeFromRecord(metadata ?? undefined);
}

export function applyOutputNormalizeIfEnabled(
  text: string,
  kgm?: KgmOutputExtensions | null,
  metadata?: Record<string, unknown> | null,
  headers?: Record<string, string | string[] | undefined> | Headers | null
): string {
  const mode = resolveOutputNormalizeMode(kgm, metadata, headers);
  if (mode !== 'gfm-lite' || !text) return text;
  return normalizeGfmLite(text);
}
