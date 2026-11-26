import { Decimal } from "decimal.js";

export interface DisplayFormat {
  unit: string;
  precision: number;
  scale: number;
  suffix: string;
}

/** Recovers how a claim was printed so a replacement reads the same way: currency sign, scale suffix and decimals. */
export function displayFormatFor(claim: { text: string; displayUnit: string | null; displayPrecision: number | null }): DisplayFormat {
  const suffixMatch = /\s(thousand|million|billion)$/i.exec(claim.text);
  const suffix = suffixMatch ? ` ${suffixMatch[1]!.toLowerCase()}` : "";
  const scale = suffix === " thousand" ? 3 : suffix === " million" ? 6 : suffix === " billion" ? 9 : 0;
  const unit = claim.displayUnit ?? (claim.text.includes("$") ? "USD" : "pure");
  return { unit, precision: claim.displayPrecision ?? 0, scale, suffix };
}

export function formatValue(value: string, format: DisplayFormat): string {
  const scaled = new Decimal(value).dividedBy(new Decimal(10).pow(format.scale)).toDecimalPlaces(format.precision, Decimal.ROUND_HALF_UP);
  const [whole, fraction] = scaled.abs().toFixed(format.precision).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const sign = scaled.isNegative() && !scaled.isZero() ? "-" : "";
  if (format.unit === "USD") return `${sign}$${body}${format.suffix}`;
  if (format.unit === "percent") return `${sign}${body}%`;
  return `${sign}${body}${format.suffix}`;
}

export function formatDelta(oldValue: string, newValue: string, format: DisplayFormat): string {
  const delta = new Decimal(newValue).minus(new Decimal(oldValue));
  const formatted = formatValue(delta.abs().toFixed(), format);
  return delta.isZero() ? "no change" : `${delta.isNegative() ? "-" : "+"}${formatted}`;
}
