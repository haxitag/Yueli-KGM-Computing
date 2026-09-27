/**
 * Dual-track confidence fusion: formal/symbolic × retrieval × LLM.
 * Produces an explicit fused score with per-track breakdown (anti-black-box).
 */

export type DualTrackWeights = {
  symbolic: number;
  retrieval: number;
  llm: number;
};

export type DualTrackScoreInput = {
  /** Rule / graph / logical-form grounded score in [0,1] */
  symbolic: number;
  /** Memory / RAG evidence score in [0,1] */
  retrieval: number;
  /** LLM / statistical synthesis score in [0,1] */
  llm: number;
  weights?: Partial<DualTrackWeights>;
};

export type DualTrackScoreResult = {
  fused: number;
  tracks: {
    symbolic: number;
    retrieval: number;
    llm: number;
  };
  weights: DualTrackWeights;
  formula: string;
};

export const DEFAULT_DUAL_TRACK_WEIGHTS: DualTrackWeights = {
  symbolic: 0.4,
  retrieval: 0.3,
  llm: 0.3,
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function normalizeWeights(weights?: Partial<DualTrackWeights>): DualTrackWeights {
  const raw: DualTrackWeights = {
    symbolic: weights?.symbolic ?? DEFAULT_DUAL_TRACK_WEIGHTS.symbolic,
    retrieval: weights?.retrieval ?? DEFAULT_DUAL_TRACK_WEIGHTS.retrieval,
    llm: weights?.llm ?? DEFAULT_DUAL_TRACK_WEIGHTS.llm,
  };
  const sum = raw.symbolic + raw.retrieval + raw.llm;
  if (sum <= 0) return { ...DEFAULT_DUAL_TRACK_WEIGHTS };
  return {
    symbolic: raw.symbolic / sum,
    retrieval: raw.retrieval / sum,
    llm: raw.llm / sum,
  };
}

export function fuseDualTrackConfidence(input: DualTrackScoreInput): DualTrackScoreResult {
  const tracks = {
    symbolic: clamp01(input.symbolic),
    retrieval: clamp01(input.retrieval),
    llm: clamp01(input.llm),
  };
  const weights = normalizeWeights(input.weights);
  const fused = Number(
    (tracks.symbolic * weights.symbolic + tracks.retrieval * weights.retrieval + tracks.llm * weights.llm).toFixed(4),
  );
  return {
    fused,
    tracks,
    weights,
    formula: `fused = symbolic*${weights.symbolic.toFixed(2)} + retrieval*${weights.retrieval.toFixed(2)} + llm*${weights.llm.toFixed(2)}`,
  };
}
