const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const DATETIME = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function fmtDate(iso: string | null | undefined): string {
  return iso ? DATE.format(new Date(iso)) : "Not set";
}

export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? `${DATETIME.format(new Date(iso))} UTC` : "Not set";
}

export function fmtTime(iso: string | null | undefined): string {
  return iso ? TIME.format(new Date(iso)) : "";
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function duration(startIso: string, endIso: string | null, now = Date.now()): string {
  const ms = (endIso ? new Date(endIso).getTime() : now) - new Date(startIso).getTime();
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats an exact decimal string for display. Rounding is done on the digit string, never through floating point. */
export function money(value: string | null | undefined, unit: string | null | undefined = "USD", precision = 0): string {
  if (value === null || value === undefined) return "Awaiting evidence";
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw = "0", fractionRaw = ""] = unsigned.split(".");
  let whole = wholeRaw;
  let fraction = fractionRaw.padEnd(precision + 1, "0");
  if (precision >= 0) {
    const keep = fraction.slice(0, precision);
    const roundUp = Number(fraction.charAt(precision)) >= 5;
    let digits = `${whole}${keep}`;
    if (roundUp) {
      const carried = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
      digits = carried;
    }
    whole = digits.slice(0, digits.length - precision) || "0";
    fraction = precision > 0 ? digits.slice(digits.length - precision) : "";
  }
  const body = fraction ? `${groupDigits(whole)}.${fraction}` : groupDigits(whole);
  const isZero = /^[0.,]+$/.test(body);
  const sign = negative && !isZero ? "-" : "";
  if (unit === "USD") return `${sign}$${body}`;
  if (unit === "percent") return `${sign}${body}%`;
  return `${sign}${body}`;
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 10) : "";
}

export function humanize(value: string): string {
  const text = value.replace(/[_.]/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const ROLE_LABEL: Record<string, string> = {
  "filing-monitor": "Filing Monitor",
  "impact-analyst": "Impact Analyst",
  "financial-verifier": "Financial Verifier",
  "publication-editor": "Publication Editor",
};

export function actorLabel(actor: { kind: string; id: string }): string {
  if (actor.kind === "agent") return ROLE_LABEL[actor.id] ?? actor.id;
  if (actor.kind === "human") return actor.id.startsWith("editor") ? "Editor" : actor.id.startsWith("analyst") ? "Analyst" : "Operator";
  const system: Record<string, string> = { propagation: "Errata rules", "case-engine": "Errata rules", replay: "Replay clock", outbox: "Delivery", "fault-injection": "Fault injection", runtime: "Runtime", "live-monitor": "Live monitor", seed: "Workspace setup" };
  return system[actor.id] ?? "System";
}
