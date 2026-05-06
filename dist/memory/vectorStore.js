import { getJson, postJson } from "../utils/http.js";
import { joinUrl } from "../utils/url.js";
export class ChromaVectorStore {
    baseUrl;
    apiPath;
    collectionName;
    collectionId;
    timeoutMs;
    constructor(params) {
        this.baseUrl = params.baseUrl;
        this.apiPath = params.apiPath ?? "/api/v1";
        this.collectionName = params.collection;
        this.timeoutMs = params.timeoutMs;
    }
    async upsert(params) {
        const collectionId = await this.ensureCollection();
        const url = joinUrl(this.baseUrl, `${this.apiPath}/collections/${collectionId}/add`);
        await postJson(url, {
            ids: params.ids,
            embeddings: params.embeddings,
            metadatas: params.metadatas,
        }, { timeoutMs: this.timeoutMs });
    }
    async query(params) {
        const collectionId = await this.ensureCollection();
        const url = joinUrl(this.baseUrl, `${this.apiPath}/collections/${collectionId}/query`);
        const data = (await postJson(url, {
            query_embeddings: [params.embedding],
            n_results: params.topK,
            where: params.where,
        }, { timeoutMs: this.timeoutMs }));
        const ids = data.ids?.[0] ?? [];
        const distances = data.distances?.[0] ?? [];
        const scores = ids.map((_, idx) => {
            const distance = distances[idx] ?? 1;
            return Math.max(0, 1 - distance);
        });
        return { ids, scores };
    }
    async ensureCollection() {
        if (this.collectionId) {
            return this.collectionId;
        }
        const listUrl = joinUrl(this.baseUrl, `${this.apiPath}/collections`);
        const list = (await getJson(listUrl, { timeoutMs: this.timeoutMs }));
        const found = list.find((item) => item.name === this.collectionName || item.id === this.collectionName);
        if (found?.id) {
            this.collectionId = found.id;
            return this.collectionId;
        }
        if (found?.name) {
            this.collectionId = found.name;
            return this.collectionId;
        }
        const createUrl = joinUrl(this.baseUrl, `${this.apiPath}/collections`);
        const created = (await postJson(createUrl, { name: this.collectionName, metadata: { created_by: "kgm" } }, { timeoutMs: this.timeoutMs }));
        this.collectionId = created.id ?? created.name ?? this.collectionName;
        return this.collectionId;
    }
}
