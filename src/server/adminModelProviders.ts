import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ConfigStore } from "../core/configStore.js";
import type { ProviderConfig } from "../llm/providerFactory.js";
import { ProviderConfigurationManager } from "../models/providerConfigManager.js";
import { resolveCloudModelAlias } from "../models/cloudModelCatalog.js";
import { readKgmHttpJsonBody, sendKgmHttpJson } from "./httpJsonHelpers.js";
import { kgmErrorBody } from "../utils/kgmHttpErrors.js";

export type CopilotCloudProviderRow = {
  id?: string;
  name?: string;
  presetId?: string;
  enabled?: boolean;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
};

function resolveProviderConfigPath(): string {
  return (
    process.env.KGM_PROVIDER_CONFIG_PATH?.trim() ||
    path.join(process.cwd(), "config", "model-providers.json")
  );
}

function mapCopilotRowToProvider(row: CopilotCloudProviderRow): ProviderConfig | null {
  const presetId = (row.presetId || row.id || "").trim();
  const model = resolveCloudModelAlias((row.model || "").trim());
  if (!presetId || !model) return null;
  const type = presetId as ProviderConfig["type"];
  return {
    type,
    model,
    baseUrl: row.apiUrl?.trim() || undefined,
    apiKey: row.apiKey?.trim() || undefined,
  };
}

export async function handleGetModelProviders(res: ServerResponse): Promise<void> {
  const manager = new ProviderConfigurationManager(resolveProviderConfigPath());
  await manager.loadConfiguration();
  manager.updateFromEnvironment();
  const data = manager.getConfigData();
  return sendKgmHttpJson(res, 200, {
    path: resolveProviderConfigPath(),
    providers: data.providers.map((p) => ({
      type: p.type,
      model: p.model,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.apiKey || p.apiKeys?.length),
    })),
    activeProviders: data.activeProviders,
    defaultProvider: data.defaultProvider,
    providerRoutingRules: data.providerRoutingRules,
  });
}

export async function handlePutModelProviders(
  req: IncomingMessage,
  res: ServerResponse,
  configStore: ConfigStore,
): Promise<void> {
  const body = (await readKgmHttpJsonBody(req)) as {
    providers?: CopilotCloudProviderRow[];
    cloudProviders?: CopilotCloudProviderRow[];
    activeProviders?: string[];
    defaultProvider?: string;
  };

  const rows = body.cloudProviders ?? body.providers ?? [];
  if (!Array.isArray(rows)) {
    return sendKgmHttpJson(res, 400, kgmErrorBody("invalid_request", "providers array required", 400));
  }

  const manager = new ProviderConfigurationManager(resolveProviderConfigPath());
  await manager.loadConfiguration();

  const nextProviders: ProviderConfig[] = [];
  const activeKeys: string[] = [];

  for (const row of rows) {
    if (row.enabled === false) continue;
    const mapped = mapCopilotRowToProvider(row);
    if (!mapped) continue;
    if (!mapped.apiKey && !["ollama", "vllm", "sglang", "lmstudio", "vmlx"].includes(mapped.type)) {
      continue;
    }
    nextProviders.push(mapped);
    activeKeys.push(`${mapped.type}:${mapped.model}`);
  }

  manager.replaceFromCopilotSync({
    providers: nextProviders,
    activeProviders: body.activeProviders?.length ? body.activeProviders : activeKeys,
    defaultProvider: body.defaultProvider ?? activeKeys[0],
  });

  await manager.saveConfiguration();
  configStore.reloadFromDisk();

  const saved = manager.getConfigData();
  return sendKgmHttpJson(res, 200, {
    ok: true,
    saved: nextProviders.length,
    activeProviders: saved.activeProviders,
    path: resolveProviderConfigPath(),
  });
}

export function summarizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl.length > 48 ? `${baseUrl.slice(0, 48)}…` : baseUrl;
  }
}
