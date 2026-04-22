import { createRuntime, HashEmbedder, MockLlmClient } from "../index.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ llmClient: new MockLlmClient(), embedder: new HashEmbedder() });
  const embedding = await runtime.embedder.embed("seed memory");
  await runtime.memoryStore.add({
    id: "mem_seed",
    userId: "user_1",
    text: "seed memory",
    embedding,
    embeddingVersion: "canon-2025-01",
    source: "seed",
    createdAt: new Date().toISOString(),
  });
  console.log("seeded");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
