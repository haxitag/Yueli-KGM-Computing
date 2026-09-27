import type { LoadedNativeModel } from "./loaders.js";
import type { NativeCheckpoint } from "./types.js";

export function createCanonicalCheckpointForNativeCore(loaded: LoadedNativeModel): NativeCheckpoint | undefined {
  if (!loaded.executableModel || !loaded.tokenizer) {
    return undefined;
  }
  return loaded.executableModel.toCheckpoint(loaded.tokenizer.spec);
}
