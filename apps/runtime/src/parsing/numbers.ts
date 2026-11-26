import { Decimal } from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type ParsedNumber =
  | { kind: "number"; raw: string; value: Decimal; negative: boolean }
  | { kind: "dash"; raw: string }
  | { kind: "none" };

const DASHES = new Set(["-", "–", "—", "−"]);
const NUMBER_PATTERN = /^\(?\$?\s*\(?\s*-?[0-9][0-9,]*(\.[0-9]+)?\s*\)?%?$/;

export function normalizeWhitespace(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Parses a displayed financial number. Parentheses denote a negative value; a lone dash means "not applicable or nil", never zero. */
export function parseDisplayedNumber(text: string): ParsedNumber {
  const raw = normalizeWhitespace(text);
  if (!raw) return { kind: "none" };
  const compact = raw.replace(/\s+/g, "");
  if (DASHES.has(compact) || compact === "$–" || compact === "$-" || compact === "$—") return { kind: "dash", raw };
  if (!NUMBER_PATTERN.test(compact)) return { kind: "none" };
  const negative = compact.includes("(") || compact.startsWith("-");
  const digits = compact.replace(/[()$,%\s-]/g, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(digits)) return { kind: "none" };
  const value = new Decimal(digits);
  return { kind: "number", raw, value: negative ? value.negated() : value, negative };
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** Finds "Month DD, YYYY" dates in text and returns them as ISO dates in order of appearance. */
export function findDates(text: string): string[] {
  const out: string[] = [];
  const pattern = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/gi;
  for (const match of text.matchAll(pattern)) {
    const month = MONTHS[match[1]!.toLowerCase()];
    out.push(`${match[3]}-${month}-${match[2]!.padStart(2, "0")}`);
  }
  return out;
}

export function toDecimalString(value: Decimal): string {
  return value.toFixed();
}
