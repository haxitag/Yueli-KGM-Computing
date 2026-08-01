import assert from "node:assert/strict";
import path from "node:path";

import { NativeRuntimeEngine } from "../native/engine.js";
import { withNativeCoreAddonShim } from "./native_core_smoke_support.js";

async function main(): Promise<void> {
  await withNativeCoreAddonShim(async () => {
    const modelPath = path.resolve("data/native-models/ok-model");
    const engine = new NativeRuntimeEngine(modelPath, {
      servingBackend: "native-core",
      kvCacheMode: "paged",
      kvPageSize: 2,
      cachedKvPageBudget: 4,
      seed: 1,
    });

    const result = await engine.complete("", {
      model: "kgm-native-core-shim",
      requestId: "native-core-smoke",
      sessionId: "native-core-smoke",
      maxTokens: 4,
      temperature: 0,
    });
    const raw = (result.raw as {
      nativeRuntime?: {
        scheduler?: { servingBackend?: string };
        memory?: { cachedKvPageBudget?: number };
      };
    }).nativeRuntime;

    assert.equal(result.text, "ok");
    assert.equal(engine.servingBackend(), "native-core");
    assert.equal(engine.executionBackend(), "native-core");
    assert.equal(raw?.scheduler?.servingBackend, "native-core");
    assert.equal(raw?.memory?.cachedKvPageBudget, 4);

    console.log(JSON.stringify({
      servingBackend: engine.servingBackend(),
      executionBackend: engine.executionBackend(),
      result: result.text,
      raw,
      schedulerMetrics: engine.schedulerMetrics(),
    }, null, 2));
  });
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
