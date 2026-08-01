import path from "node:path";

import { ManagedModelManager } from "../models/modelManager.js";

async function main(): Promise<void> {
  const modelPath = path.resolve("data/native-models/ok-model");
  const manager = new ManagedModelManager({
    statePath: "/tmp/kgm-native-demo-state.json",
    artifactDir: "/tmp/kgm-native-demo-artifacts",
  });

  try {
    const created = await manager.createModel({
      pull: {
        sourceType: "local",
        sourceUrl: modelPath,
        modelName: "kgm-native-ok",
        name: "kgm-native-ok",
      },
      runtime: {
        runtime: "native",
        modelName: "kgm-native-ok",
      },
      autoStart: true,
    });

    const result = await manager.completeWithManagedRuntime("kgm-native-ok", "", {
      maxTokens: 4,
      temperature: 0,
    });

    console.log(JSON.stringify({
      runtime: created.runtime,
      artifact: created.artifact,
      result,
    }, null, 2));
  } finally {
    manager.close();
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
