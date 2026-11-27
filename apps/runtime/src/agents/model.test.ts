import { ModelContext, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core";
import { APIConnectionTimeoutError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CallContext, GuardedInferenceRunner, classifyProviderError, retryDelayMs } from "./model.js";

describe("classifyProviderError", () => {
  it("treats a billing refusal as a quota stop, not a retryable error", () => {
    // #given
    const error = Object.assign(new Error("429 You have no credits remaining. Add credits to continue."), { status: 429 });
    // #when
    const classified = classifyProviderError(error);
    // #then
    expect(classified.code).toBe("QUOTA_EXCEEDED");
  });

  it("treats a tokens-per-minute limit as a wait, even when the message links to billing", () => {
    // #given
    const error = Object.assign(new Error("429 Rate limit reached for model on tokens per minute (TPM): Limit 8000. Please try again in 7.24s. Need more tokens? Upgrade at https://console.groq.com/settings/billing"), { status: 429 });
    // #when
    const classified = classifyProviderError(error);
    // #then
    expect(classified.code).toBe("RATE_LIMITED");
  });

  it("reads the provider's wait hint in seconds and minutes", () => {
    expect(retryDelayMs("Please try again in 7.24s.")).toBe(7240);
    expect(retryDelayMs("Please try again in 1m3.5s.")).toBe(63500);
    expect(retryDelayMs("Please try again in 450ms")).toBe(450);
    expect(retryDelayMs("no hint here")).toBeNull();
  });
});

describe("GuardedInferenceRunner", () => {
  const output: InferenceOutput = { items: [], tokenUsage: undefined, rowResponse: { usage: { prompt_tokens: 10, completion_tokens: 2 } } };

  function setup(failures: number) {
    let calls = 0;
    const inner: InferenceRunner = {
      run: async () => {
        calls += 1;
        if (calls <= failures) throw new APIConnectionTimeoutError();
        return output;
      },
      stream: () => {
        throw new Error("not used");
      },
    };
    const runner = new GuardedInferenceRunner(inner);
    const context = ModelContext.rehydrate({ id: crypto.randomUUID(), items: [] });
    const call: CallContext = { workspaceId: crypto.randomUUID(), agentRunId: crypto.randomUUID(), role: "financial-verifier", onUsage: vi.fn(), onFailure: vi.fn(), onWaiting: vi.fn() };
    runner.register(context.id, call);
    const input: InferenceInput = { model: "test-model", context };
    return { runner, input, call, calls: () => calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries an attempt that timed out and returns the next answer", async () => {
    // #given
    vi.useFakeTimers();
    const { runner, input, call } = setup(2);
    // #when
    const pending = runner.run(input);
    await vi.advanceTimersByTimeAsync(10_000);
    // #then
    await expect(pending).resolves.toMatchObject({ items: [] });
    expect(call.onUsage).toHaveBeenCalledWith(10, 2);
  });

  it("gives up after a third timed out attempt and records the failure on the run", async () => {
    // #given
    vi.useFakeTimers();
    const { runner, input, call, calls } = setup(3);
    // #when
    const pending = runner.run(input);
    const settled = expect(pending).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await vi.advanceTimersByTimeAsync(10_000);
    // #then
    await settled;
    expect(calls()).toBe(3);
    expect(call.onFailure).toHaveBeenCalledOnce();
  });
});
