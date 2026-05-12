import { createRuntimeWithStorage } from "../index.js";

async function main(): Promise<void> {
  const runtime = await createRuntimeWithStorage({});

  const embedding = await runtime.embedder.embed("user prefers short answers");
  const now = new Date().toISOString();
  await runtime.memoryStore.add({
    id: "mem_001",
    userId: "user_1",
    text: "user prefers short answers",
    embedding,
    embeddingVersion: "canon-2025-01",
    source: "profile",
    createdAt: now,
    lastAccessedAt: now,
  });

  const response = await runtime.scheduler.run({
    userId: "user_1",
    input: "search market trends",
    signals: [{ type: "web", source: "browser", title: "example", value: "example" }],
  });

  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
