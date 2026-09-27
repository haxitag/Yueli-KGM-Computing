/**
 * Resolve model aliases via Ops store (Playground-managed).
 */

import { resolveMappedModelId, type ModelIdMappingRecord } from "../models/modelIdMapping.js";
import { getOpsStore, type ModelAliasRecord } from "./opsStore.js";

export type ResolvedModelRef = {
  requested: string;
  model: string;
  provider?: string;
  runtimeId?: string;
  alias?: ModelAliasRecord;
  mapping?: ModelIdMappingRecord;
};

export async function resolveModelAlias(
  requested: string | undefined,
  provider?: string,
): Promise<ResolvedModelRef | undefined> {
  if (!requested?.trim()) return undefined;
  const name = requested.trim();
  const mapped = resolveMappedModelId(name, provider);
  if (mapped.mapping) {
    return {
      requested: name,
      model: mapped.model,
      provider: mapped.provider,
      mapping: mapped.mapping,
    };
  }
  try {
    const store = await getOpsStore();
    const alias = store.resolveAlias(name);
    const providerKey = provider?.trim().toLowerCase();
    if (!alias?.provider || !providerKey || alias.provider.trim().toLowerCase() !== providerKey) {
      return { requested: name, model: name, provider: provider?.trim() || undefined };
    }
    return {
      requested: name,
      model: alias.model,
      provider: alias.provider,
      runtimeId: alias.runtimeId,
      alias,
    };
  } catch {
    return { requested: name, model: name, provider: provider?.trim() || undefined };
  }
}
