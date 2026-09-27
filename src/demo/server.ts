import { createRuntimeWithStorage, createKgmServer } from "../index.js";

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

const port = Number(process.env.PORT ?? 58691);
server.listen(port, () => {
  console.log(`KGM server listening on ${port}`);
});
