import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createStore } from "@brimble/core/server";

import { loadWorkerConfig } from "./config";
import { createPipelineDependencies, processNextDeployment } from "./pipeline";

const config = loadWorkerConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
mkdirSync(config.workspaceRoot, { recursive: true });

const store = createStore(config.databasePath, { publicBaseUrl: config.publicBaseUrl });
store.resetInFlightWork();

const dependencies = createPipelineDependencies(config, store);

console.log("Worker started.");

while (true) {
  const processed = await processNextDeployment(config, dependencies);

  if (!processed) {
    await new Promise((resolve) => {
      setTimeout(resolve, config.pollIntervalMs);
    });
  }
}
