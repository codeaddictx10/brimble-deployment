import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createApiServer } from "./server";
import { loadApiConfig } from "./config";

const config = loadApiConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });

const { app } = createApiServer({ config });

app.listen(config.port, "0.0.0.0", () => {
  console.log(`API listening on port ${config.port}`);
});

