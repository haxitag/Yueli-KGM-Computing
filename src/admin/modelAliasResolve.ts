/**
 * Resolve model aliases via Ops store (Playground-managed).
 */

import { getOpsStore, type ModelAliasRecord } from "./opsStore.js";

export type ResolvedModelRef = {
  requested: string;
  model: string;
  provider?: string;
  runtimeId?: string;
  alias?: ModelAliasRecord;
};

export async function resolveModelAlias(requested: string | undefined): Promise<ResolvedModelRef | undefined> {
  if (!requested?.trim()) return undefined;
  const name = requested.trim();
  try {
    const store = await getOpsStore();
    const alias = store.resolveAlias(name);
    if (!alias) {
      return { requested: name, model: name };
    }
    return {
      requested: name,
      model: alias.model,
      provider: alias.provider,
      runtimeId: alias.runtimeId,
      alias,
    };
  } catch {
    return { requested: name, model: name };
  }
}
