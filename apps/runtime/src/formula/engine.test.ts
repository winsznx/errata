import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { CURRENT_RATIO, WORKING_CAPITAL, computeFormula, displayDecimal, type FormulaInput } from "./engine.js";

const input = (ref: string, value: string, overrides: Partial<FormulaInput> = {}): FormulaInput => ({
  ref,
  value,
  unit: "USD",
  periodEnd: "2025-03-31",
  issuerCik: "0001756180",
  ...overrides,
});

describe("computeFormula", () => {
  it("computes working capital exactly from as-reported and restated inputs", () => {
    const reported = computeFormula(WORKING_CAPITAL("ca", "cl"), [input("ca", "1275416"), input("cl", "706384")]);
    const restated = computeFormula(WORKING_CAPITAL("ca", "cl"), [input("ca", "670496"), input("cl", "794149")]);
    expect(reported).toMatchObject({ ok: true, value: "569032", unit: "USD" });
    expect(restated).toMatchObject({ ok: true, value: "-123653", unit: "USD" });
  });

  it("keeps full precision for ratios and rounds only for display", () => {
    const ratio = computeFormula(CURRENT_RATIO("ca", "cl"), [input("ca", "1275416"), input("cl", "706384")]);
    expect(ratio.ok).toBe(true);
    if (!ratio.ok) return;
    expect(ratio.unit).toBe("pure");
    expect(ratio.value).toBe(new (Decimal.clone({ precision: 40 }))(1275416).dividedBy(706384).toFixed());
    expect(displayDecimal(ratio.value, 2)).toBe("1.81");
  });

  it("avoids binary floating point artifacts", () => {
    const sum = computeFormula({ op: "add", args: [{ op: "ref", ref: "a" }, { op: "ref", ref: "b" }] }, [input("a", "0.1"), input("b", "0.2")]);
    expect(sum).toMatchObject({ ok: true, value: "0.3" });
  });

  it("returns UNDEFINED for division by zero instead of a number", () => {
    const result = computeFormula(CURRENT_RATIO("ca", "cl"), [input("ca", "10"), input("cl", "0")]);
    expect(result).toMatchObject({ ok: false, code: "UNDEFINED" });
  });

  it("rejects mixing units, periods and issuers", () => {
    expect(computeFormula(WORKING_CAPITAL("a", "b"), [input("a", "1"), input("b", "1", { unit: "EUR" })])).toMatchObject({ ok: false, code: "INCOMPATIBLE_UNITS" });
    expect(computeFormula(WORKING_CAPITAL("a", "b"), [input("a", "1"), input("b", "1", { periodEnd: "2024-12-31" })])).toMatchObject({ ok: false, code: "INCOMPATIBLE_PERIODS" });
    expect(computeFormula(WORKING_CAPITAL("a", "b"), [input("a", "1"), input("b", "1", { issuerCik: "0000000001" })])).toMatchObject({ ok: false, code: "INCOMPATIBLE_UNITS" });
  });

  it("rejects arbitrary constants and malformed trees", () => {
    expect(computeFormula({ op: "const", value: "7" }, [])).toMatchObject({ ok: false, code: "INVALID_AST" });
    expect(computeFormula({ op: "eval", code: "process.exit()" }, [])).toMatchObject({ ok: false, code: "INVALID_AST" });
    expect(computeFormula({ op: "ref", ref: "missing" }, [])).toMatchObject({ ok: false, code: "MISSING_INPUT" });
  });

  it("refuses percent change from a zero or negative base", () => {
    const node = { op: "pct_change" as const, from: { op: "ref" as const, ref: "a" }, to: { op: "ref" as const, ref: "b" } };
    expect(computeFormula(node, [input("a", "-123653"), input("b", "100")])).toMatchObject({ ok: false, code: "UNDEFINED" });
    expect(computeFormula(node, [input("a", "706384"), input("b", "794149")])).toMatchObject({ ok: true, unit: "percent" });
  });
});
