/**
 * Lightweight AutoRouting for standalone Playground (no full runtime / Adapter stack).
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ConfigStore } from "../core/configStore.js";
import { ConfigurableLlmClient, type LlmClient } from "../llm/client.js";
import { AutoRoutingLlmClient } from "../llm/autoRoutingClient.js";
import { ManagedModelManager } from "../models/modelManager.js";
import { AutoRoutingAuditStore } from "../routing/autoRoutingAuditStore.js";

export type LightweightAutoRoutingHandle = {
  llmClient: LlmClient;
  autoRoutingClient: AutoRoutingLlmClient;
  configStore: ConfigStore;
  modelManager: ManagedModelManager;
  close: () => void;
};

/**
 * Build AutoRouting + ConfigurableLlmClient from env/config disk, suitable for
 * `createPlaygroundServer` when no combined runtime is present.
 */
export function createLightweightAutoRoutingLlm(options?: {
  stateRoot?: string;
  configPath?: string;
}): LightweightAutoRoutingHandle {
  const stateRoot =
    options?.stateRoot ??
    process.env.KGM_MODEL_STATE_PATH ??
    path.join(os.tmpdir(), "kgm-playground-standalone", "models");
  const artifactDir =
    process.env.KGM_MODEL_ARTIFACT_DIR ?? path.join(path.dirname(stateRoot), "artifacts");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });

  const configPath = options?.configPath ?? process.env.KGM_CONFIG_PATH ?? "data/kgm.config.json";
  const configStore = new ConfigStore({
    persistPath: configPath,
    loadFromDisk: fs.existsSync(configPath),
    autoPersist: false,
  });

  const modelManager = new ManagedModelManager({
    statePath: stateRoot,
    artifactDir,
  });
  const auditStore = new AutoRoutingAuditStore({
    filePath: path.join(path.dirname(stateRoot), "auto-routing-audit.json"),
  });
  const fallback = new ConfigurableLlmClient(configStore);
  const autoRoutingClient = new AutoRoutingLlmClient({
    fallback,
    manager: modelManager,
    configStore,
    auditStore,
  });

  return {
    llmClient: autoRoutingClient,
    autoRoutingClient,
    configStore,
    modelManager,
    close: () => {
      try {
        modelManager.close();
      } catch {
        /* ignore */
      }
    },
  };
}
