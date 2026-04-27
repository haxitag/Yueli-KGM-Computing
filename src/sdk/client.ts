import type { KgmRequest, KgmResponse } from "../core/types.js";
import type { AutoRoutingConfig, KgmConfig, KgmConfigPatch } from "../core/configStore.js";
import type { BusinessRoutingConfig } from "../routing/businessRouting.js";
import type { RoutingHistoryEntry } from "../routing/routingHistoryStore.js";
import type { KceComputeRequest, KceComputeResponse } from "../kce/engine.js";
import { getJson, postJson } from "../utils/http.js";

export class KgmSdk {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async execute(request: KgmRequest): Promise<KgmResponse> {
    return (await postJson(`${this.baseUrl}/v1/kgm/execute`, request)) as KgmResponse;
  }

  async computeKce(request: KceComputeRequest): Promise<KceComputeResponse> {
    return (await postJson(`${this.baseUrl}/v1/kgm/kce/compute`, request)) as KceComputeResponse;
  }

  async health(): Promise<{ status: string }> {
    return (await getJson(`${this.baseUrl}/health`)) as { status: string };
  }

  async addMemory(params: { userId: string; text: string; source: string }): Promise<{ status: string }> {
    return (await postJson(`${this.baseUrl}/v1/kgm/memory`, params)) as { status: string };
  }

  async searchMemory(params: {
    userId: string;
    query: string;
    topK?: number;
  }): Promise<{ evidence: Array<{ id: string; text: string; score: number; source: string }> }> {
    return (await postJson(`${this.baseUrl}/v1/kgm/memory/search`, params)) as {
      evidence: Array<{ id: string; text: string; score: number; source: string }>;
    };
  }

  async getSchema(schemaId: string): Promise<unknown> {
    return getJson(`${this.baseUrl}/v1/kgm/schemas/${schemaId}`);
  }

  async registerSchema(payload: {
    schemaId: string;
    version: string;
    status: "draft" | "active" | "deprecated" | "retired";
    schema: Record<string, unknown>;
  }): Promise<unknown> {
    return postJson(`${this.baseUrl}/v1/kgm/schemas`, payload);
  }

  async listTools(): Promise<unknown> {
    return getJson(`${this.baseUrl}/v1/kgm/tools`);
  }

  async readArtifact(params: { id: string; offset?: number; limit?: number }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    return getJson(`${this.baseUrl}/v1/kgm/artifacts/${params.id}${suffix}`);
  }

  async readSession(params: { id: string; offset?: number; limit?: number }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    return getJson(`${this.baseUrl}/v1/kgm/sessions/${params.id}${suffix}`);
  }

  async getConfig(): Promise<KgmConfig> {
    return (await getJson(`${this.baseUrl}/v1/kgm/config`)) as KgmConfig;
  }

  async updateConfig(patch: KgmConfigPatch): Promise<KgmConfig> {
    return (await postJson(`${this.baseUrl}/v1/kgm/config`, patch)) as KgmConfig;
  }

  async updateEmbeddingConfig(patch: Partial<KgmConfig["embedding"]>): Promise<KgmConfig> {
    return this.updateConfig({ embedding: patch });
  }

  async updateLlmConfig(patch: Partial<KgmConfig["llm"]>): Promise<KgmConfig> {
    return this.updateConfig({ llm: patch });
  }

  async updateDatabaseConfig(patch: Partial<KgmConfig["database"]>): Promise<KgmConfig> {
    return this.updateConfig({ database: patch });
  }

  async updateVectorConfig(patch: Partial<KgmConfig["vector"]>): Promise<KgmConfig> {
    return this.updateConfig({ vector: patch });
  }

  async updateContextConfig(patch: Partial<KgmConfig["context"]>): Promise<KgmConfig> {
    return this.updateConfig({ context: patch });
  }

  async getAutoRouting(): Promise<AutoRoutingConfig> {
    return (await getJson(`${this.baseUrl}/v1/kgm/auto-routing`)) as AutoRoutingConfig;
  }

  async updateAutoRouting(patch: Partial<AutoRoutingConfig>): Promise<AutoRoutingConfig> {
    return (await postJson(`${this.baseUrl}/v1/kgm/auto-routing`, patch)) as AutoRoutingConfig;
  }

  async getAutoRoutingSummary(limit?: number): Promise<unknown> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return getJson(`${this.baseUrl}/v1/kgm/auto-routing/summary${suffix}`);
  }

  async listAutoRoutingAudit(limit?: number): Promise<unknown> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return getJson(`${this.baseUrl}/v1/kgm/auto-routing/audit${suffix}`);
  }

  async getRouting(): Promise<BusinessRoutingConfig> {
    return (await getJson(`${this.baseUrl}/v1/kgm/routing`)) as BusinessRoutingConfig;
  }

  async updateRouting(
    routing: Partial<BusinessRoutingConfig> | BusinessRoutingConfig,
    note?: string,
  ): Promise<BusinessRoutingConfig> {
    const payload = note ? { routing, note } : routing;
    return (await postJson(`${this.baseUrl}/v1/kgm/routing`, payload)) as BusinessRoutingConfig;
  }

  async listRoutingVersions(limit?: number): Promise<{ items: RoutingHistoryEntry[] }> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    return (await getJson(`${this.baseUrl}/v1/kgm/routing/versions${suffix}`)) as {
      items: RoutingHistoryEntry[];
    };
  }

  async rollbackRouting(version: string, note?: string): Promise<BusinessRoutingConfig> {
    const payload = note ? { version, note } : { version };
    return (await postJson(`${this.baseUrl}/v1/kgm/routing/rollback`, payload)) as BusinessRoutingConfig;
  }
}
