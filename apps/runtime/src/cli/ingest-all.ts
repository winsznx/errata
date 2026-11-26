import { sqlClient } from "../db/client.js";
import { ensureIssuers, ingestManifestSource } from "../sources/ingest.js";
import { loadProvenance } from "../sources/provenance.js";

const mode = process.argv.includes("--live") ? "live" : "snapshot";
await ensureIssuers();
for (const entry of (await loadProvenance()).sources) {
  const started = performance.now();
  const result = await ingestManifestSource(entry, mode);
  console.log(`${entry.ref.padEnd(22)} ${entry.accession} facts=${result.facts} locators=${result.locators} created=${result.created} ${(performance.now() - started).toFixed(0)}ms`);
}
await sqlClient.end();
