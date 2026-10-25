import {
  applySchema,
  checkDatabase,
  connectDatabase,
  MemoryRepository,
  readDatabaseConfig,
} from "@memeval/database";
import { createApp } from "./app";
import { readApiEnv } from "./env";
import { MemoryService } from "./services/memory-service";

const env = readApiEnv();
const database = await connectDatabase(readDatabaseConfig());
const applied = await applySchema(database);
if (applied.length > 0) {
  console.log(`Applied schema: ${applied.join(", ")}`);
}

const app = createApp({
  memories: new MemoryService(new MemoryRepository(database)),
  checkDatabase: () => checkDatabase(database),
  webOrigin: env.WEB_ORIGIN,
});

console.log(`API listening on http://127.0.0.1:${env.API_PORT}`);

export default {
  port: env.API_PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
