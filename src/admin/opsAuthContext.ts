/**
 * Request-scoped auth for Ops (master vs virtual call key).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { VirtualKeyRecord } from "./opsStore.js";

export type OpsAuthContext = {
  kind: "master" | "virtual" | "anonymous";
  keyId: string;
  keyName?: string;
  virtualKey?: VirtualKeyRecord;
  rawKeyPrefix?: string;
};

const als = new AsyncLocalStorage<OpsAuthContext>();

export function runWithOpsAuth<T>(ctx: OpsAuthContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export async function runWithOpsAuthAsync<T>(ctx: OpsAuthContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function getOpsAuth(): OpsAuthContext {
  return (
    als.getStore() ?? {
      kind: "anonymous",
      keyId: "anonymous",
    }
  );
}
