import { afterAll, describe, expect, it } from "vitest";
import { sqlClient } from "../db/client.js";
import { createScenarioWorkspace } from "../domain/workspace.js";
import { withIdempotency } from "./auth.js";

afterAll(async () => {
  await sqlClient.end({ timeout: 5 });
});

describe("withIdempotency", () => {
  it("runs an action once when two requests with the same key arrive together", async () => {
    // #given
    const { workspaceId } = await createScenarioWorkspace("nocera-q1-repair");
    let runs = 0;
    const action = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { run: runs };
    };
    // #when
    const results = await Promise.all([withIdempotency(workspaceId, "test", "same-key", { a: 1 }, action), withIdempotency(workspaceId, "test", "same-key", { a: 1 }, action)]);
    // #then
    expect({ runs, results }).toEqual({ runs: 1, results: [{ run: 1 }, { run: 1 }] });
  });

  it("refuses a reused key with a different request", async () => {
    // #given
    const { workspaceId } = await createScenarioWorkspace("nocera-q1-repair");
    await withIdempotency(workspaceId, "test", "reused-key", { a: 1 }, async () => ({ ok: true }));
    // #when
    const reused = withIdempotency(workspaceId, "test", "reused-key", { a: 2 }, async () => ({ ok: true }));
    // #then
    await expect(reused).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });
});
