import { createRuntimeWithStorage } from "../index.js";

async function main(): Promise<void> {
  const runtime = await createRuntimeWithStorage({});
  const embedding = await runtime.embedder.embed("seed memory");
  const now = new Date().toISOString();
  await runtime.memoryStore.add({
    id: "mem_seed",
    userId: "user_1",
    text: "seed memory",
    embedding,
    embeddingVersion: "canon-2025-01",
    source: "seed",
    createdAt: now,
    lastAccessedAt: now,
  });
  console.log("seeded");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
