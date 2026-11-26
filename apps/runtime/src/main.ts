import { ENV } from "./config/env.js";
import { sqlClient } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./api/server.js";
import { startWorkers } from "./jobs/handlers.js";

process.on("unhandledRejection", (reason) => {
  console.error("[runtime] unhandled rejection (agent loop errors are recorded on their agent run)", reason instanceof Error ? reason.message : reason);
});

await runMigrations();
const app = await buildServer();
const workers = startWorkers({ liveMonitor: ENV.ENABLE_LIVE_MONITOR });
await app.listen({ port: ENV.RUNTIME_PORT, host: ENV.RUNTIME_HOST });
app.log.info({ build: ENV.BUILD_COMMIT, model: ENV.MODEL_ID }, "errata runtime ready");

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  for (const worker of workers) worker.stop();
  await app.close();
  await sqlClient.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
