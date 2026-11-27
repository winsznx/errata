import { describe, expect, it } from "vitest";
import { classifyProviderError, retryDelayMs } from "./model.js";

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
