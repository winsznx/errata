import { Decimal } from "decimal.js";
import { z } from "zod";

export const CALC_VERSION = "errata-calc-1";
const PRECISION = 40;
const ALLOWED_CONSTANTS = new Set(["100"]);

const D = Decimal.clone({ precision: PRECISION, rounding: Decimal.ROUND_HALF_UP });

export type FormulaNode =
  | { op: "ref"; ref: string }
  | { op: "const"; value: string }
  | { op: "add" | "sub" | "mul" | "div"; args: [FormulaNode, FormulaNode] }
  | { op: "round"; arg: FormulaNode; places: number }
  | { op: "pct_change"; from: FormulaNode; to: FormulaNode };

export const FORMULA_SCHEMA: z.ZodType<FormulaNode> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("ref"), ref: z.string().min(1).max(120) }),
    z.object({ op: z.literal("const"), value: z.string() }),
    z.object({ op: z.enum(["add", "sub", "mul", "div"]), args: z.tuple([FORMULA_SCHEMA, FORMULA_SCHEMA]) }),
    z.object({ op: z.literal("round"), arg: FORMULA_SCHEMA, places: z.number().int().min(0).max(10) }),
    z.object({ op: z.literal("pct_change"), from: FORMULA_SCHEMA, to: FORMULA_SCHEMA }),
  ]),
);

export interface FormulaInput {
  ref: string;
  value: string;
  unit: string;
  periodEnd: string;
  issuerCik: string;
}

type Unit = string;
type Evaluated = { value: Decimal; unit: Unit; periodEnd: string | null; issuerCik: string | null };

export type FormulaErrorCode = "INVALID_AST" | "MISSING_INPUT" | "INCOMPATIBLE_UNITS" | "INCOMPATIBLE_PERIODS" | "UNDEFINED" | "DEPTH_EXCEEDED";

export type FormulaResult =
  | { ok: true; value: string; unit: Unit; steps: string[]; inputs: FormulaInput[]; calcVersion: string }
  | { ok: false; code: FormulaErrorCode; message: string; steps: string[]; calcVersion: string };

class FormulaError extends Error {
  constructor(
    readonly code: FormulaErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function sameContext(a: Evaluated, b: Evaluated, op: string): void {
  if (a.periodEnd && b.periodEnd && a.periodEnd !== b.periodEnd) {
    throw new FormulaError("INCOMPATIBLE_PERIODS", `${op} mixes periods ${a.periodEnd} and ${b.periodEnd}`);
  }
  if (a.issuerCik && b.issuerCik && a.issuerCik !== b.issuerCik) {
    throw new FormulaError("INCOMPATIBLE_UNITS", `${op} mixes issuers ${a.issuerCik} and ${b.issuerCik}`);
  }
}

function merge(a: Evaluated, b: Evaluated): Pick<Evaluated, "periodEnd" | "issuerCik"> {
  return { periodEnd: a.periodEnd ?? b.periodEnd, issuerCik: a.issuerCik ?? b.issuerCik };
}

function evaluate(node: FormulaNode, inputs: Map<string, FormulaInput>, steps: string[], depth: number): Evaluated {
  if (depth > 12) throw new FormulaError("DEPTH_EXCEEDED", "formula nesting too deep");
  switch (node.op) {
    case "ref": {
      const input = inputs.get(node.ref);
      if (!input) throw new FormulaError("MISSING_INPUT", `missing input ${node.ref}`);
      steps.push(`${node.ref} = ${input.value} ${input.unit} (${input.periodEnd})`);
      return { value: new D(input.value), unit: input.unit, periodEnd: input.periodEnd, issuerCik: input.issuerCik };
    }
    case "const": {
      if (!ALLOWED_CONSTANTS.has(node.value)) throw new FormulaError("INVALID_AST", `constant ${node.value} is not allowed`);
      return { value: new D(node.value), unit: "pure", periodEnd: null, issuerCik: null };
    }
    case "add":
    case "sub": {
      const a = evaluate(node.args[0], inputs, steps, depth + 1);
      const b = evaluate(node.args[1], inputs, steps, depth + 1);
      if (a.unit !== b.unit) throw new FormulaError("INCOMPATIBLE_UNITS", `${node.op} needs matching units, got ${a.unit} and ${b.unit}`);
      sameContext(a, b, node.op);
      const value = node.op === "add" ? a.value.plus(b.value) : a.value.minus(b.value);
      steps.push(`${node.op}(${a.value.toFixed()}, ${b.value.toFixed()}) = ${value.toFixed()} ${a.unit}`);
      return { value, unit: a.unit, ...merge(a, b) };
    }
    case "mul": {
      const a = evaluate(node.args[0], inputs, steps, depth + 1);
      const b = evaluate(node.args[1], inputs, steps, depth + 1);
      if (a.unit !== "pure" && b.unit !== "pure") throw new FormulaError("INCOMPATIBLE_UNITS", "mul needs at least one dimensionless operand");
      const value = a.value.times(b.value);
      const unit = a.unit === "pure" ? b.unit : a.unit;
      steps.push(`mul(${a.value.toFixed()}, ${b.value.toFixed()}) = ${value.toFixed()} ${unit}`);
      return { value, unit, ...merge(a, b) };
    }
    case "div": {
      const a = evaluate(node.args[0], inputs, steps, depth + 1);
      const b = evaluate(node.args[1], inputs, steps, depth + 1);
      if (b.value.isZero()) throw new FormulaError("UNDEFINED", "division by zero");
      sameContext(a, b, "div");
      let unit: Unit;
      if (a.unit === b.unit) unit = "pure";
      else if (b.unit === "pure") unit = a.unit;
      else throw new FormulaError("INCOMPATIBLE_UNITS", `div of ${a.unit} by ${b.unit} is not a supported ratio`);
      const value = a.value.dividedBy(b.value);
      steps.push(`div(${a.value.toFixed()}, ${b.value.toFixed()}) = ${value.toFixed()} ${unit}`);
      return { value, unit, ...merge(a, b) };
    }
    case "round": {
      const a = evaluate(node.arg, inputs, steps, depth + 1);
      const value = a.value.toDecimalPlaces(node.places, Decimal.ROUND_HALF_UP);
      steps.push(`round(${a.value.toFixed()}, ${node.places}) = ${value.toFixed()}`);
      return { ...a, value };
    }
    case "pct_change": {
      const from = evaluate(node.from, inputs, steps, depth + 1);
      const to = evaluate(node.to, inputs, steps, depth + 1);
      if (from.unit !== to.unit) throw new FormulaError("INCOMPATIBLE_UNITS", "pct_change needs matching units");
      if (from.value.lte(0)) throw new FormulaError("UNDEFINED", "percent change is undefined when the base is zero or negative");
      const value = to.value.minus(from.value).dividedBy(from.value).times(100);
      steps.push(`pct_change(${from.value.toFixed()} -> ${to.value.toFixed()}) = ${value.toFixed()} percent`);
      return { value, unit: "percent", periodEnd: null, issuerCik: from.issuerCik };
    }
  }
}

export function computeFormula(ast: unknown, inputs: FormulaInput[]): FormulaResult {
  const steps: string[] = [];
  const parsed = FORMULA_SCHEMA.safeParse(ast);
  if (!parsed.success) return { ok: false, code: "INVALID_AST", message: parsed.error.issues[0]?.message ?? "invalid formula", steps, calcVersion: CALC_VERSION };
  const byRef = new Map(inputs.map((i) => [i.ref, i]));
  try {
    const result = evaluate(parsed.data, byRef, steps, 0);
    return { ok: true, value: result.value.toFixed(), unit: result.unit, steps, inputs, calcVersion: CALC_VERSION };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, code: error.code, message: error.message, steps, calcVersion: CALC_VERSION };
    throw error;
  }
}

export function formulaRefs(node: FormulaNode): string[] {
  switch (node.op) {
    case "ref":
      return [node.ref];
    case "const":
      return [];
    case "round":
      return formulaRefs(node.arg);
    case "pct_change":
      return [...formulaRefs(node.from), ...formulaRefs(node.to)];
    default:
      return [...formulaRefs(node.args[0]), ...formulaRefs(node.args[1])];
  }
}

export function remapRefs(node: FormulaNode, map: (ref: string) => string): FormulaNode {
  switch (node.op) {
    case "ref":
      return { op: "ref", ref: map(node.ref) };
    case "const":
      return node;
    case "round":
      return { ...node, arg: remapRefs(node.arg, map) };
    case "pct_change":
      return { ...node, from: remapRefs(node.from, map), to: remapRefs(node.to, map) };
    default:
      return { op: node.op, args: [remapRefs(node.args[0], map), remapRefs(node.args[1], map)] };
  }
}

export const WORKING_CAPITAL = (assets: string, liabilities: string): FormulaNode => ({
  op: "sub",
  args: [
    { op: "ref", ref: assets },
    { op: "ref", ref: liabilities },
  ],
});

export const CURRENT_RATIO = (assets: string, liabilities: string): FormulaNode => ({
  op: "div",
  args: [
    { op: "ref", ref: assets },
    { op: "ref", ref: liabilities },
  ],
});

export function displayDecimal(value: string, places: number): string {
  return new D(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}
