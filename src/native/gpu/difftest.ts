import assert from "node:assert/strict";

import type { CompletionOptions } from "../../llm/client.js";
import { NativeRuntimeEngine } from "../engine.js";
import { buildGpuMemoryPlan } from "./memoryPlan.js";

/**
 * Phase 6 对齐 harness（SIM 可跑）：
 * - 在同一个 checkpoint 上，对比 js-reference 与 native-gpu(sim) 的输出一致性。
 * - 同时验证 GPU memory plan 可构建且稳定。
 */
export async function difftestNativeGpuAgainstJsReference(params: {
  modelPath: string;
  prompt: string;
  options?: CompletionOptions;
}): Promise<void> {
  const ref = new NativeRuntimeEngine(params.modelPath, { servingBackend: "js-reference" });
  const gpu = new NativeRuntimeEngine(params.modelPath, { servingBackend: "native-gpu" });

  const meta = ref.metadata();
  assert.ok(meta.config, "model config missing");
  const plan = buildGpuMemoryPlan({
    modelConfig: meta.config as any,
    dtype: "bf16",
    maxSessions: 1,
    maxContextTokens: 128,
  });
  assert.ok(plan.bytes.total > 0);

  const a = await ref.complete(params.prompt, params.options);
  const b = await gpu.complete(params.prompt, params.options);
  assert.equal(b.text, a.text);
}

