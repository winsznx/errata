import { describe, expect, it } from "vitest";
import { classifyProviderError } from "./model.js";

describe("classifyProviderError", () => {
  it("treats a billing refusal as a quota stop, not a retryable error", () => {
    // #given
    const error = Object.assign(new Error("429 You have no credits remaining. Add credits to continue."), { status: 429 });
    // #when
    const classified = classifyProviderError(error);
    // #then
    expect(classified.code).toBe("QUOTA_EXCEEDED");
  });

  it("keeps an ordinary rate limit retryable", () => {
    // #given
    const error = Object.assign(new Error("429 Rate limit reached for requests per minute"), { status: 429 });
    // #when
    const classified = classifyProviderError(error);
    // #then
    expect(classified.code).toBe("PROVIDER_ERROR");
  });
});
