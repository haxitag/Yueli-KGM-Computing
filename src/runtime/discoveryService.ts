import { joinUrl } from "../utils/url.js";

export type InferenceEngineType = "ollama" | "vmlx" | "llama.cpp" | "lmstudio" | "vllm" | "openai-compat";
export type InferenceModelCapability = "chat" | "embedding" | "reasoning";

export type DiscoveredModel = {
  id: string;
  capabilities: InferenceModelCapability[];
};

export type DiscoveredEngine = {
  id: string;
  type: InferenceEngineType;
  baseUrl: string;
  healthy: boolean;
  models: DiscoveredModel[];
};

export type DiscoveryResult = {
  discoveredAt: number;
  engines: DiscoveredEngine[];
};

export type DiscoveryOptions = {
  enabled?: boolean;
  ports?: number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_PORTS = [11434, 8002, 8080, 1234, 8000, 5000, 7860, 8765, 8095, 8090];
const PRIORITY: InferenceEngineType[] = ["ollama", "vmlx", "llama.cpp", "lmstudio", "vllm", "openai-compat"];

export class InferenceDiscoveryService {
  private lastResult?: DiscoveryResult;
  private readonly fetchImpl: typeof fetch;
  private readonly enabled: boolean;
  private readonly ports: number[];
  private readonly timeoutMs: number;

  constructor(options?: DiscoveryOptions) {
    this.enabled = options?.enabled ?? process.env.KGM_DISCOVERY_ENABLED === "1";
    this.ports = options?.ports ?? parsePorts(process.env.KGM_DISCOVERY_PORTS) ?? DEFAULT_PORTS;
    this.timeoutMs = options?.timeoutMs ?? parseNumber(process.env.KGM_DISCOVERY_TIMEOUT_MS) ?? 2000;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  async discover(options?: { force?: boolean }): Promise<DiscoveryResult> {
    if (!this.enabled) {
      this.lastResult = { discoveredAt: Math.floor(Date.now() / 1000), engines: [] };
      return this.lastResult;
    }
    if (this.lastResult && !options?.force) {
      return this.lastResult;
    }
    const engines = await Promise.all(this.ports.map((port) => this.probePort(port)));
    this.lastResult = {
      discoveredAt: Math.floor(Date.now() / 1000),
      engines: engines
        .filter((engine): engine is DiscoveredEngine => Boolean(engine))
        .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type)),
    };
    return this.lastResult;
  }

  getLastResult(): DiscoveryResult | undefined {
    return this.lastResult;
  }

  private async probePort(port: number): Promise<DiscoveredEngine | null> {
    const type = inferEngineType(port);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(baseUrl, "/models"), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const body = await response.json() as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ name?: string; model?: string }> };
      const models = normalizeModels(body);
      return {
        id: `${type.replace(".", "")}-local`,
        type,
        baseUrl,
        healthy: true,
        models,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function inferModelCapabilities(modelId: string): InferenceModelCapability[] {
  const id = modelId.toLowerCase();
  if (id.includes("embed") || id.includes("nomic") || id.includes("bge") || id.includes("e5-")) {
    return ["embedding"];
  }
  if (id.includes("r1") || id.includes("reason")) {
    return ["chat", "reasoning"];
  }
  return ["chat"];
}

function normalizeModels(body: { data?: Array<{ id?: string; name?: string }>; models?: Array<{ name?: string; model?: string }> }): DiscoveredModel[] {
  const ids = [
    ...(body.data ?? []).map((item) => item.id ?? item.name),
    ...(body.models ?? []).map((item) => item.model ?? item.name),
  ].filter((id): id is string => Boolean(id));
  return Array.from(new Set(ids)).map((id) => ({ id, capabilities: inferModelCapabilities(id) }));
}

function inferEngineType(port: number): InferenceEngineType {
  if (port === 11434) return "ollama";
  if (port === 8002) return "vmlx";
  if (port === 8080) return "llama.cpp";
  if (port === 1234) return "lmstudio";
  if (port === 8000) return "vllm";
  // SGLang default OpenAI-compat (7860) / MLX (8765) — typed as openai-compat until engine taxonomy expands
  if (port === 7860 || port === 8765) return "openai-compat";
  if (port === 8095) return "openai-compat"; // TokenSpeed default OpenAI-compat port
  if (port === 8090) return "openai-compat"; // ds4 default
  return "openai-compat";
}

function parsePorts(value: string | undefined): number[] | undefined {
  const ports = value?.split(/[,\s]+/).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  return ports?.length ? ports : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
