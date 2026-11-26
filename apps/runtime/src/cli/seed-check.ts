import { sqlClient } from "../db/client.js";
import { createScenarioWorkspace } from "../domain/workspace.js";
import { loadScenarios } from "../domain/scenarios.js";

for (const scenario of await loadScenarios()) {
  const created = await createScenarioWorkspace(scenario.id);
  console.log(scenario.id, "->", created.slug);
}
await sqlClient.end();
