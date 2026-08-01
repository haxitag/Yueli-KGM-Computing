import { once } from "node:events";
import { createKgmServer, createRuntimeWithStorage, KgmSdk } from "../index.js";

async function main(): Promise<void> {
  const runtime = await createRuntimeWithStorage({});
  const server = createKgmServer({
    scheduler: runtime.scheduler,
    contextBuilder: runtime.contextBuilder,
    llmClient: runtime.llmClient,
    schemaRegistry: runtime.schemaRegistry,
    toolRegistry: runtime.toolRegistry,
    memoryStore: runtime.memoryStore,
    graphStore: runtime.graphStore,
    embedder: runtime.embedder,
    sandboxManager: runtime.sandboxManager,
    configStore: runtime.configStore,
    skillRuntime: runtime.skillRuntime,
  });

  server.listen(0);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address not available");
  }

  const sdk = new KgmSdk(`http://127.0.0.1:${address.port}`);
  await sdk.addMemory({ userId: "user_1", text: "prefers short replies", source: "profile" });
  const response = await sdk.execute({ userId: "user_1", input: "search market trends" });
  console.log(JSON.stringify(response, null, 2));

  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
