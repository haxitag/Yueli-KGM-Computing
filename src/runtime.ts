import { ContextBuilder } from "./context/contextBuilder.js";
import { ArtifactStore } from "./context/artifactStore.js";
import { SessionStore } from "./context/sessionStore.js";
import { ConfigurableEmbedder } from "./embedding/canonical.js";
import type { Embedder } from "./embedding/canonical.js";
import { InMemoryGraphStore } from "./graph/store.js";
import type { GraphStore } from "./graph/store.js";
import { ConfigurableLlmClient } from "./llm/client.js";
import type { LlmClient } from "./llm/client.js";
import { AutoRoutingLlmClient } from "./llm/autoRoutingClient.js";
import { AdapterClient } from "./integrations/adapter.js";
import { AdapterLlmClient } from "./llm/adapterClient.js";
import { InMemoryStore } from "./memory/store.js";
import type { MemoryStore } from "./memory/store.js";
import { createHybridMemoryStore } from "./memory/factory.js";
import { registerDefaultSchemas } from "./schema/defaults.js";
import { SchemaRegistry } from "./schema/registry.js";
import { Scheduler } from "./scheduler/fsm.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { registerIoTools } from "./tools/ioTools.js";
import { registerGraphTools } from "./tools/graphTools.js";
import { registerArtifactTools } from "./tools/artifactTools.js";
import { registerSessionTools } from "./tools/sessionTools.js";
import { registerCatalogTools } from "./tools/catalogTools.js";
import { registerSandboxTools } from "./tools/sandboxTools.js";
import { ToolRegistry } from "./tools/registry.js";
import { SkillRegistry, SkillRuntime } from "./skills/runtime.js";
import { syncPlaygroundFromConfig } from "./playground/syncPlayground.js";
import { DEFAULT_SCHEMA_IDS } from "./core/config.js";
import { ConfigStore } from "./core/configStore.js";
import { SandboxManager } from "./sandbox/manager.js";
import { ManagedModelManager } from "./models/modelManager.js";
import { AutoRoutingAuditStore } from "./routing/autoRoutingAuditStore.js";
import { YcbClient } from "./ycb/client.js";

export function createRuntime(params: {
  llmClient?: LlmClient;
  embedder?: Embedder;
  memoryStore?: MemoryStore;
  configStore?: ConfigStore;
  graphStore?: GraphStore;
}): {
  scheduler: Scheduler;
  schemaRegistry: SchemaRegistry;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  skillRuntime: SkillRuntime;
  contextBuilder: ContextBuilder;
  llmClient: LlmClient;
  embedder: Embedder;
  memoryStore: MemoryStore;
  graphStore: GraphStore;
  sandboxManager: SandboxManager;
  modelManager: ManagedModelManager;
  autoRoutingClient: AutoRoutingLlmClient;
  autoRoutingAuditStore: AutoRoutingAuditStore;
  configStore: ConfigStore;
  artifactStore: ArtifactStore;
  sessionStore: SessionStore;
} {
  const configStore = params.configStore ?? new ConfigStore();
  const embedder = params.embedder ?? new ConfigurableEmbedder(configStore);
  const memoryStore = params.memoryStore ?? new InMemoryStore();
  const adapterClient = new AdapterClient(configStore);
  const artifactStore = new ArtifactStore(configStore.get().context.artifactDir);
  const sessionStore = new SessionStore(configStore.get().context.sessionDir);
  const graphStore = params.graphStore ?? new InMemoryGraphStore();
  const sandboxManager = new SandboxManager({
    getOverlay: () => configStore.get().sandboxAdapters,
  });
  const modelManager = new ManagedModelManager({
    llamaCpp: () => {
      const worker = configStore.get().workers.llamaCpp;
      return {
        enabled: worker.enabled,
        command: worker.command,
        installHint: worker.installHint,
      };
    },
    ds4: () => {
      const worker = configStore.get().workers.ds4;
      return {
        enabled: worker.enabled,
        command: worker.command,
        installHint: worker.installHint,
        chdir: worker.chdir,
      };
    },
    tokenspeed: () => {
      const worker = configStore.get().workers.tokenspeed;
      return {
        enabled: worker.enabled,
        command: worker.command,
        installHint: worker.installHint,
        baseUrl: worker.baseUrl,
        port: worker.port,
        attach: worker.attach,
        toolCallParser: worker.toolCallParser,
        reasoningParser: worker.reasoningParser,
        enablePrefixCaching: worker.enablePrefixCaching,
        extraArgs: worker.extraArgs,
      };
    },
  });
  const autoRoutingAuditStore = new AutoRoutingAuditStore();

  const schemaRegistry = new SchemaRegistry();
  registerDefaultSchemas(schemaRegistry);
  const outputSchema = schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent)?.schema ?? {};

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  registerIoTools(toolRegistry);
  registerGraphTools(toolRegistry, graphStore);
  registerSandboxTools(toolRegistry, sandboxManager);
  if (configStore.get().context.enableArtifactTool) {
    registerArtifactTools(toolRegistry, artifactStore);
  }
  if (configStore.get().context.enableSessionTool) {
    registerSessionTools(toolRegistry, sessionStore);
  }

  const skillRegistry = new SkillRegistry();
  syncPlaygroundFromConfig({ skillRegistry, toolRegistry, configStore });
  const skillRuntime = new SkillRuntime(skillRegistry, toolRegistry);
  if (configStore.get().context.enableToolCatalogTool) {
    registerCatalogTools(toolRegistry, skillRegistry);
  }

  const ycbClient = new YcbClient(configStore);
  const contextBuilder = new ContextBuilder({
    memoryStore,
    embedder,
    reportContextQuality: (event) => {
      void adapterClient.sendContextQuality(event).catch(() => {});
    },
    embeddingVersion: configStore.get().embedding.version,
    contextConfig: configStore.get().context,
    getContextConfig: () => configStore.get().context,
    artifactStore,
    sessionStore,
    graphStore,
    ycbClient,
  });

  const directLlmClient = params.llmClient ?? new ConfigurableLlmClient(configStore);
  const autoRoutingClient = new AutoRoutingLlmClient({
    fallback: directLlmClient,
    manager: modelManager,
    configStore,
    auditStore: autoRoutingAuditStore,
  });
  const llmClient = new AdapterLlmClient(autoRoutingClient, adapterClient, configStore);
  const scheduler = new Scheduler({
    contextBuilder,
    llmClient,
    toolRegistry,
    outputSchema,
    schemaRecord: schemaRegistry.get(DEFAULT_SCHEMA_IDS.llmIntent),
    memoryStore,
    embedder,
    skillRuntime,
    configStore,
    artifactStore,
    sessionStore,
  });

  return {
    scheduler,
    schemaRegistry,
    toolRegistry,
    skillRegistry,
    skillRuntime,
    contextBuilder,
    llmClient,
    embedder,
    memoryStore,
    graphStore,
    sandboxManager,
    modelManager,
    autoRoutingClient,
    autoRoutingAuditStore,
    configStore,
    artifactStore,
    sessionStore,
  };
}

export async function createRuntimeWithStorage(params: {
  llmClient?: LlmClient;
  embedder?: Embedder;
  configStore?: ConfigStore;
  graphStore?: GraphStore;
}): Promise<ReturnType<typeof createRuntime>> {
  const configStore = params.configStore ?? new ConfigStore();
  let memoryStore: MemoryStore | undefined;

  if (configStore.get().vector.backend === "chroma") {
    memoryStore = await createHybridMemoryStore(configStore);
  }

  return createRuntime({
    llmClient: params.llmClient,
    embedder: params.embedder,
    memoryStore,
    configStore,
    graphStore: params.graphStore,
  });
}
