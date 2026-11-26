import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { db, sqlClient } from "./client.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(async () => {
      console.log("migrations applied");
      await sqlClient.end();
    })
    .catch(async (error: unknown) => {
      console.error("migration failed", error);
      await sqlClient.end();
      process.exit(1);
    });
}
