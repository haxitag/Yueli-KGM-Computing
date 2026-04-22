import fs from "node:fs";
import path from "node:path";

export async function withNativeCoreAddonShim<T>(callback: () => Promise<T>): Promise<T> {
  const originalLibrary = process.env.KGM_NATIVE_CORE_LIBRARY;
  const originalAddon = process.env.KGM_NATIVE_CORE_ADDON;
  process.env.KGM_NATIVE_CORE_LIBRARY = resolveBuiltRuntimePath("dist/native-core/index.js");
  process.env.KGM_NATIVE_CORE_ADDON = resolveBuiltRuntimePath("dist/demo/native_core_addon_shim.js");
  try {
    return await callback();
  } finally {
    restoreEnv("KGM_NATIVE_CORE_LIBRARY", originalLibrary);
    restoreEnv("KGM_NATIVE_CORE_ADDON", originalAddon);
  }
}

function resolveBuiltRuntimePath(relativePath: string): string {
  const resolved = path.resolve(process.cwd(), relativePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`native_core_smoke_runtime_missing:${resolved}`);
  }
  return resolved;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (typeof previous === "string") {
    process.env[name] = previous;
    return;
  }
  delete process.env[name];
}
