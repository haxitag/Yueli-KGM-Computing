/**
 * Detect antirez/ds4 specialized GGUFs (DeepSeek V4 Flash/PRO, GLM 5.2 routed quants).
 * These MUST NOT claim in-process native / native-gpu executability — force via_worker(ds4).
 */

export type Ds4ArtifactProfile = {
  specialized: boolean;
  family: "deepseek-v4-flash" | "deepseek-v4-pro" | "glm-5.2" | "unknown";
  quantTier: "iq2-imatrix" | "q2-imatrix" | "q4-imatrix" | "q4" | "q2" | "unknown";
  imatrix: boolean;
  /** Prefer SSD streaming when memory is tight (operator hint) */
  suggestSsdStreaming: boolean;
  reason: string;
};

const DEEPSEEK_V4_FLASH_RE =
  /deepseek[-_]?v4[-_]?flash|ds4flash|v4[-_]?flash[-_]?(q2|q4|iq2)/i;
const DEEPSEEK_V4_PRO_RE = /deepseek[-_]?v4[-_]?pro|v4[-_]?pro[-_]?(q2|q4|iq2)/i;
const GLM52_RE = /glm[-_]?5\.?2|glm52/i;
const IMATRIX_RE = /imatrix/i;
const IQ2_RE = /iq2[_-]?xxs|routediq2/i;
const Q2_RE = /q2[_-]?k|routedq2|[-_]q2[-_]/i;
const Q4_RE = /q4[_-]?k|[-_]q4[-_]|ud-q4/i;

export function classifyDs4Artifact(localPathOrName: string | undefined): Ds4ArtifactProfile {
  const raw = String(localPathOrName ?? "").trim();
  if (!raw) {
    return {
      specialized: false,
      family: "unknown",
      quantTier: "unknown",
      imatrix: false,
      suggestSsdStreaming: false,
      reason: "empty_path",
    };
  }
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? raw;
  const imatrix = IMATRIX_RE.test(base) || IMATRIX_RE.test(raw);

  let family: Ds4ArtifactProfile["family"] = "unknown";
  if (DEEPSEEK_V4_PRO_RE.test(base) || DEEPSEEK_V4_PRO_RE.test(raw)) {
    family = "deepseek-v4-pro";
  } else if (DEEPSEEK_V4_FLASH_RE.test(base) || DEEPSEEK_V4_FLASH_RE.test(raw)) {
    family = "deepseek-v4-flash";
  } else if (GLM52_RE.test(base) || GLM52_RE.test(raw)) {
    family = "glm-5.2";
  }

  let quantTier: Ds4ArtifactProfile["quantTier"] = "unknown";
  if (IQ2_RE.test(base)) {
    quantTier = imatrix ? "iq2-imatrix" : "q2";
  } else if (Q2_RE.test(base) && imatrix) {
    quantTier = "q2-imatrix";
  } else if (Q4_RE.test(base) && imatrix) {
    quantTier = "q4-imatrix";
  } else if (Q4_RE.test(base)) {
    quantTier = "q4";
  } else if (Q2_RE.test(base)) {
    quantTier = "q2";
  }

  const specialized = family !== "unknown";
  return {
    specialized,
    family,
    quantTier,
    imatrix,
    suggestSsdStreaming: specialized && (family === "deepseek-v4-pro" || quantTier.startsWith("q4") || quantTier.includes("iq2")),
    reason: specialized
      ? `ds4_specialized_gguf:${family}:${quantTier}`
      : "not_ds4_specialized_gguf",
  };
}

export function isDs4SpecializedGguf(localPathOrName: string | undefined): boolean {
  return classifyDs4Artifact(localPathOrName).specialized;
}
