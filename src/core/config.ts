export const CANONICAL_EMBEDDING = {
  modelName: "text-embedding-3-large",
  dim: 3072,
  pooling: "mean" as const,
  normalize: true,
  version: "canon-2025-01-openai",
  distance: "cosine" as const,
};

export const DEFAULT_TOOL_POLICY = {
  allowed: ["search_web", "get_weather"],
  maxRounds: 2,
};

export const DEFAULT_CONSTRAINTS = {
  language: "zh",
  style: "structured",
  riskLevel: "medium" as const,
};

export const DEFAULT_SCHEMA_IDS = {
  request: "kgm.request.v1",
  response: "kgm.response.v1",
  contextPack: "kgm.contextpack.v1",
  llmIntent: "kgm.llm_intent.v1",
  tool: "kgm.tool.v1",
  skill: "kgm.skill.v1",
  profile: "kgm.profile.v1",
  memoryChunk: "kgm.memorychunk.v1",
  promptArtifact: "kgm.promptartifact.v1",
};
