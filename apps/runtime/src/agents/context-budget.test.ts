import { DeveloperMessageItem, FunctionCallItem, FunctionCallOutputItem, ModelContext, UserMessageItem } from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import { estimateTokens, fitContext } from "./context-budget.js";

function loopContext(results: string[]): ModelContext {
  const items = [DeveloperMessageItem.create("You are the Financial Verifier."), UserMessageItem.create("Verify proposal p1.")];
  results.forEach((result, i) => {
    items.push(FunctionCallItem.rehydrate({ callId: `c${i}`, name: `tool_${i}`, args: "{}" }));
    items.push(FunctionCallOutputItem.create(`c${i}`, result));
  });
  return ModelContext.rehydrate({ id: "ctx", items });
}

describe("fitContext", () => {
  it("leaves a context that already fits untouched", () => {
    // #given
    const context = loopContext(["small"]);
    // #when
    const fit = fitContext(context, [], 5000);
    // #then
    expect(fit).toMatchObject({ fits: true, compacted: 0 });
  });

  it("omits the oldest tool results first and keeps every call paired with an output", () => {
    // #given
    const big = "x".repeat(8000);
    const context = loopContext([big, big, "latest result"]);
    // #when
    const fit = fitContext(context, [], estimateTokens(big) + 600);
    // #then
    const outputs = context.items.filter((i) => i instanceof FunctionCallOutputItem) as FunctionCallOutputItem[];
    expect(fit.fits).toBe(true);
    expect(outputs.map((o) => o.callId)).toEqual(["c0", "c1", "c2"]);
    expect(outputs[0]!.output.text).toMatch(/^\[omitted/);
    expect(outputs[2]!.output.text).toBe("latest result");
  });

  it("reports when even the newest result cannot fit", () => {
    // #given
    const context = loopContext(["y".repeat(40_000)]);
    // #when
    const fit = fitContext(context, [], 2000);
    // #then
    expect(fit.fits).toBe(false);
  });
});
