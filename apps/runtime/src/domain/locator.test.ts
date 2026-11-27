import { describe, expect, it } from "vitest";
import { agreesToSignificantDigits } from "./locator.js";

const exact = "0.8442949622803781154418125565857288745563";

describe("agreesToSignificantDigits", () => {
  it("accepts a verifier value that matches the exact quotient to twelve significant digits", () => {
    expect(agreesToSignificantDigits("0.84429496228037811544", exact, 12)).toBe(true);
  });

  it("rejects a value rounded for display", () => {
    expect(agreesToSignificantDigits("0.844295", exact, 12)).toBe(false);
  });

  it("rejects a different formula's result", () => {
    expect(agreesToSignificantDigits("1.18440", exact, 12)).toBe(false);
  });

  it("compares integers exactly", () => {
    expect(agreesToSignificantDigits("-123653", "-123653", 12)).toBe(true);
    expect(agreesToSignificantDigits("-123654", "-123653", 12)).toBe(false);
  });
});
