import { DEFAULT_SCHEMA_IDS } from "../core/config.js";
import { SchemaRegistry } from "./registry.js";

const requestSchema = {
  type: "object",
  required: ["userId", "input"],
  properties: {
    requestId: { type: "string" },
    userId: { type: "string" },
    sessionId: { type: "string" },
    input: { type: "string" },
    signals: { type: "array" },
    conversation: { type: "array" },
    constraints: { type: "object" },
    toolPolicy: { type: "object" },
    metadata: { type: "object" },
    kgm: { type: "object" },
  },
};

const responseSchema = {
  type: "object",
  required: ["requestId", "type", "content"],
  properties: {
    requestId: { type: "string" },
    type: { type: "string", enum: ["final"] },
    content: { type: "string" },
    toolResults: { type: "array" },
    metadata: { type: "object" },
    kgm: { type: "object" },
  },
};

const contextPackSchema = {
  type: "object",
  required: ["requestId", "userId", "input", "signals", "evidence"],
  properties: {
    requestId: { type: "string" },
    userId: { type: "string" },
    input: { type: "string" },
    signals: { type: "array" },
    conversation: { type: "array" },
    evidence: { type: "array" },
    constraints: { type: "object" },
    toolPolicy: { type: "object" },
    toolResults: { type: "array" },
    kgm: { type: "object" },
  },
};

const llmIntentSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["final", "call", "invoke_skill"] },
    content: { type: "string" },
    target: { type: "string" },
    arguments: { type: "object" },
    skill: { type: "string" },
    input: { type: "object" },
  },
};

const toolSchema = {
  type: "object",
  required: ["name", "description", "inputSchema", "outputSchema"],
  properties: {
    name: { type: "string" },
    kind: { type: "string" },
    description: { type: "string" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    metadata: { type: "object" },
  },
};

const skillSchema = {
  type: "object",
  required: ["name", "steps"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    steps: { type: "array" },
  },
};

const profileSchema = {
  type: "object",
  required: ["values", "thinking_style", "confidence"],
  properties: {
    values: { type: "object" },
    thinking_style: { type: "object" },
    confidence: { type: "number" },
  },
};

const memoryChunkSchema = {
  type: "object",
  required: ["id", "text", "embedding_version"],
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    embedding_version: { type: "string" },
    source: { type: "string" },
  },
};

const promptArtifactSchema = {
  type: "object",
  required: ["prompt", "template_version"],
  properties: {
    prompt: { type: "string" },
    template_version: { type: "string" },
    token_count: { type: "number" },
  },
};

export function registerDefaultSchemas(registry: SchemaRegistry): void {
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.request,
    version: "1.0.0",
    status: "active",
    schema: requestSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.response,
    version: "1.0.0",
    status: "active",
    schema: responseSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.contextPack,
    version: "1.0.0",
    status: "active",
    schema: contextPackSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.llmIntent,
    version: "1.0.0",
    status: "active",
    schema: llmIntentSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.tool,
    version: "1.0.0",
    status: "active",
    schema: toolSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.skill,
    version: "1.0.0",
    status: "active",
    schema: skillSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.profile,
    version: "1.0.0",
    status: "active",
    schema: profileSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.memoryChunk,
    version: "1.0.0",
    status: "active",
    schema: memoryChunkSchema,
  });
  registry.register({
    schemaId: DEFAULT_SCHEMA_IDS.promptArtifact,
    version: "1.0.0",
    status: "active",
    schema: promptArtifactSchema,
  });
}
