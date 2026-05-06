export function createCanonicalCheckpointForNativeCore(loaded) {
    if (!loaded.executableModel || !loaded.tokenizer) {
        return undefined;
    }
    return loaded.executableModel.toCheckpoint(loaded.tokenizer.spec);
}
