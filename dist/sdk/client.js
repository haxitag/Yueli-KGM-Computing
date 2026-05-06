import { getJson, postJson } from "../utils/http.js";
export class KgmSdk {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }
    async execute(request) {
        return (await postJson(`${this.baseUrl}/v1/kgm/execute`, request));
    }
    async computeKce(request) {
        return (await postJson(`${this.baseUrl}/v1/kgm/kce/compute`, request));
    }
    async health() {
        return (await getJson(`${this.baseUrl}/health`));
    }
    async addMemory(params) {
        return (await postJson(`${this.baseUrl}/v1/kgm/memory`, params));
    }
    async searchMemory(params) {
        return (await postJson(`${this.baseUrl}/v1/kgm/memory/search`, params));
    }
    async getSchema(schemaId) {
        return getJson(`${this.baseUrl}/v1/kgm/schemas/${schemaId}`);
    }
    async registerSchema(payload) {
        return postJson(`${this.baseUrl}/v1/kgm/schemas`, payload);
    }
    async listTools() {
        return getJson(`${this.baseUrl}/v1/kgm/tools`);
    }
    async readArtifact(params) {
        const qs = new URLSearchParams();
        if (params.offset !== undefined)
            qs.set("offset", String(params.offset));
        if (params.limit !== undefined)
            qs.set("limit", String(params.limit));
        const query = qs.toString();
        const suffix = query ? `?${query}` : "";
        return getJson(`${this.baseUrl}/v1/kgm/artifacts/${params.id}${suffix}`);
    }
    async readSession(params) {
        const qs = new URLSearchParams();
        if (params.offset !== undefined)
            qs.set("offset", String(params.offset));
        if (params.limit !== undefined)
            qs.set("limit", String(params.limit));
        const query = qs.toString();
        const suffix = query ? `?${query}` : "";
        return getJson(`${this.baseUrl}/v1/kgm/sessions/${params.id}${suffix}`);
    }
    async getConfig() {
        return (await getJson(`${this.baseUrl}/v1/kgm/config`));
    }
    async updateConfig(patch) {
        return (await postJson(`${this.baseUrl}/v1/kgm/config`, patch));
    }
    async updateEmbeddingConfig(patch) {
        return this.updateConfig({ embedding: patch });
    }
    async updateLlmConfig(patch) {
        return this.updateConfig({ llm: patch });
    }
    async updateDatabaseConfig(patch) {
        return this.updateConfig({ database: patch });
    }
    async updateVectorConfig(patch) {
        return this.updateConfig({ vector: patch });
    }
    async updateContextConfig(patch) {
        return this.updateConfig({ context: patch });
    }
    async getAutoRouting() {
        return (await getJson(`${this.baseUrl}/v1/kgm/auto-routing`));
    }
    async updateAutoRouting(patch) {
        return (await postJson(`${this.baseUrl}/v1/kgm/auto-routing`, patch));
    }
    async getAutoRoutingSummary(limit) {
        const qs = new URLSearchParams();
        if (limit !== undefined)
            qs.set("limit", String(limit));
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return getJson(`${this.baseUrl}/v1/kgm/auto-routing/summary${suffix}`);
    }
    async listAutoRoutingAudit(limit) {
        const qs = new URLSearchParams();
        if (limit !== undefined)
            qs.set("limit", String(limit));
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return getJson(`${this.baseUrl}/v1/kgm/auto-routing/audit${suffix}`);
    }
    async getRouting() {
        return (await getJson(`${this.baseUrl}/v1/kgm/routing`));
    }
    async updateRouting(routing, note) {
        const payload = note ? { routing, note } : routing;
        return (await postJson(`${this.baseUrl}/v1/kgm/routing`, payload));
    }
    async listRoutingVersions(limit) {
        const qs = new URLSearchParams();
        if (limit !== undefined)
            qs.set("limit", String(limit));
        const query = qs.toString();
        const suffix = query ? `?${query}` : "";
        return (await getJson(`${this.baseUrl}/v1/kgm/routing/versions${suffix}`));
    }
    async rollbackRouting(version, note) {
        const payload = note ? { version, note } : { version };
        return (await postJson(`${this.baseUrl}/v1/kgm/routing/rollback`, payload));
    }
}
