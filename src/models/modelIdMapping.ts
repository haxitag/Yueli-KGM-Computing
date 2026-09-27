/**
 * Provider-scoped model id migration.
 * One canonical id per inference provider; extra ids/versions resolve to it.
 * A mapping without a provider is not applied.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ModelIdMappingRecord = {
  id: string;
  provider: string;
  canonicalModelId: string;
  aliases: string[];
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  contextTokens?: number;
  latencyMsP50?: number;
  enabled: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type MappingFile = { items: ModelIdMappingRecord[] };

let pathOverride: string | undefined;

export function setModelIdMappingPathForTests(filePath?: string): void {
  pathOverride = filePath;
}

export function modelIdMappingPath(): string {
  return (
    pathOverride ??
    (process.env.KGM_MODEL_ID_MAPPINGS_PATH?.trim() ||
      path.join(process.cwd(), "config", "model-id-mappings.json"))
  );
}

function keyOf(value: string): string {
  return value.trim().toLowerCase();
}

function readItems(): ModelIdMappingRecord[] {
  const file = modelIdMappingPath();
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MappingFile;
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function writeItems(items: ModelIdMappingRecord[]): void {
  const file = modelIdMappingPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ items }, null, 2)}\n`);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalInt(value: unknown): number | undefined {
  const n = optionalNumber(value);
  return n === undefined ? undefined : Math.trunc(n);
}

function normalizeAliases(canonical: string, aliases: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases ?? []) {
    const alias = raw.trim();
    if (!alias) continue;
    const k = keyOf(alias);
    if (k === keyOf(canonical) || seen.has(k)) continue;
    seen.add(k);
    out.push(alias);
  }
  return out;
}

export type PublicProviderRow = {
  type: string;
  model: string;
  baseUrl?: string;
  hasApiKey: boolean;
};

/** 模型管理页：服务商、映射、报价、性能。映射必须落在某个服务商上。 */
export function buildModelManagerView(input: {
  providers: PublicProviderRow[];
  activeProviders?: string[];
  defaultProvider?: string;
  mappings: ModelIdMappingRecord[];
}) {
  const configured = new Set(input.providers.map((row) => keyOf(row.type)));
  const mappings = input.mappings.map((row) => ({
    ...row,
    providerConfigured: configured.has(keyOf(row.provider)),
  }));
  return {
    providers: input.providers,
    activeProviders: input.activeProviders ?? [],
    defaultProvider: input.defaultProvider ?? "",
    mappings,
    pricing: mappings.filter((row) => row.inputUsdPerMillion != null || row.outputUsdPerMillion != null),
    performance: mappings.filter((row) => row.contextTokens != null || row.latencyMsP50 != null),
  };
}

export function listModelIdMappings(): ModelIdMappingRecord[] {
  return readItems().sort((a, b) => a.provider.localeCompare(b.provider) || a.canonicalModelId.localeCompare(b.canonicalModelId));
}

export function upsertModelIdMapping(input: {
  id?: string;
  provider?: string;
  canonicalModelId?: string;
  aliases?: string[];
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  contextTokens?: number;
  latencyMsP50?: number;
  enabled?: boolean;
  notes?: string;
}): ModelIdMappingRecord {
  const provider = input.provider?.trim() ?? "";
  const canonicalModelId = input.canonicalModelId?.trim() ?? "";
  if (!provider) throw new Error("provider required");
  if (!canonicalModelId) throw new Error("canonicalModelId required");
  const aliases = normalizeAliases(canonicalModelId, input.aliases);
  const items = readItems();
  const incomingIds = [canonicalModelId, ...aliases].map(keyOf);
  for (const row of items) {
    if (input.id && row.id === input.id) continue;
    if (keyOf(row.provider) !== keyOf(provider)) continue;
    const taken = new Set([row.canonicalModelId, ...row.aliases].map(keyOf));
    if (incomingIds.some((id) => taken.has(id))) {
      throw new Error("model id already mapped for this provider");
    }
  }
  const now = new Date().toISOString();
  const existing =
    (input.id ? items.find((row) => row.id === input.id) : undefined) ??
    items.find((row) => keyOf(row.provider) === keyOf(provider) && keyOf(row.canonicalModelId) === keyOf(canonicalModelId));
  const record: ModelIdMappingRecord = {
    id: existing?.id ?? input.id ?? `map_${randomBytes(8).toString("hex")}`,
    provider,
    canonicalModelId,
    aliases,
    inputUsdPerMillion: optionalNumber(input.inputUsdPerMillion),
    outputUsdPerMillion: optionalNumber(input.outputUsdPerMillion),
    contextTokens: optionalInt(input.contextTokens),
    latencyMsP50: optionalNumber(input.latencyMsP50),
    enabled: input.enabled ?? existing?.enabled ?? true,
    notes: input.notes?.trim() || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing ? items.map((row) => (row.id === record.id ? record : row)) : [...items, record];
  writeItems(next);
  return record;
}

export function deleteModelIdMapping(id: string): boolean {
  const items = readItems();
  const next = items.filter((row) => row.id !== id);
  if (next.length === items.length) return false;
  writeItems(next);
  return true;
}

export function providerFromInferencePayload(payload: {
  provider?: unknown;
  metadata?: { provider_preference?: unknown };
  routing?: { target?: { provider?: unknown } };
} | undefined): string | undefined {
  const candidates = [
    payload?.provider,
    payload?.metadata?.provider_preference,
    payload?.routing?.target?.provider,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveMappedModelId(
  requested: string | undefined,
  provider: string | undefined,
): { requested: string; model: string; provider?: string; mapping?: ModelIdMappingRecord } {
  const name = requested?.trim() ?? "";
  const prov = provider?.trim() ?? "";
  if (!name || !prov) return { requested: name, model: name, provider: prov || undefined };
  const mapping = readItems().find(
    (row) =>
      row.enabled &&
      keyOf(row.provider) === keyOf(prov) &&
      (keyOf(row.canonicalModelId) === keyOf(name) || row.aliases.some((alias) => keyOf(alias) === keyOf(name))),
  );
  if (!mapping) return { requested: name, model: name, provider: prov };
  return { requested: name, model: mapping.canonicalModelId, provider: prov, mapping };
}
