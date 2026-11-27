import { Decimal } from "decimal.js";
import type { sourceDocument, sourceLocator } from "../db/schema.js";
import { tableAt } from "../parsing/html-tables.js";
import { findFactElement } from "../parsing/ixbrl.js";
import { extractParagraphs } from "../parsing/filing-text.js";
import { normalizeWhitespace } from "../parsing/numbers.js";
import { getBlob } from "../sources/blob-store.js";
import { filingHash } from "../sources/canonical.js";

type SourceRow = typeof sourceDocument.$inferSelect;
type LocatorRow = typeof sourceLocator.$inferSelect;

export interface ResolvedLocator {
  ok: boolean;
  detail: string;
  excerpt: string | null;
  value: string | null;
}

const documentCache = new Map<string, Buffer>();

async function sourceBytes(source: SourceRow): Promise<Buffer> {
  const cached = documentCache.get(source.sha256);
  if (cached) return cached;
  const bytes = await getBlob(source.storageRef);
  if (filingHash(bytes) !== source.sha256) throw new Error("stored source bytes do not match the recorded filing hash");
  if (documentCache.size > 16) documentCache.delete(documentCache.keys().next().value!);
  documentCache.set(source.sha256, bytes);
  return bytes;
}

/** Re-reads a locator against the immutable source bytes. A citation is accepted only if the bytes still say what the locator claims. */
export async function resolveLocator(source: SourceRow, locator: LocatorRow): Promise<ResolvedLocator> {
  const bytes = await sourceBytes(source);
  const path = locator.path as Record<string, unknown>;
  if (locator.kind === "html_table") {
    const table = tableAt(bytes, Number(path.tableIndex));
    const row = table?.rows.find((r) => r.rowIndex === Number(path.rowIndex));
    if (!table || !row) return { ok: false, detail: "table row not found at the cited location", excerpt: null, value: null };
    if (normalizeWhitespace(row.excerpt) !== normalizeWhitespace(locator.excerpt)) return { ok: false, detail: "row text at the cited location differs from the stored excerpt", excerpt: row.excerpt, value: null };
    const cell = row.values.find((v) => v.columnKey === path.columnKey);
    if (!cell?.value) return { ok: false, detail: "no value in the cited column", excerpt: row.excerpt, value: null };
    return { ok: true, detail: `table ${String(path.tableIndex)}, row "${row.label}", column "${String(path.columnKey)}"`, excerpt: row.excerpt, value: cell.value.times(10 ** table.scale).toFixed() };
  }
  if (locator.kind === "ixbrl") {
    const fact = findFactElement(bytes, String(path.factId));
    if (!fact) return { ok: false, detail: "inline XBRL fact not found", excerpt: null, value: null };
    return { ok: true, detail: `inline XBRL fact ${String(path.factId)} (${String(path.concept)})`, excerpt: locator.excerpt, value: fact.value?.toFixed() ?? null };
  }
  if (locator.kind === "text") {
    const paragraph = extractParagraphs(bytes).find((p) => p.index === Number(path.paragraphIndex));
    if (!paragraph) return { ok: false, detail: "paragraph not found", excerpt: null, value: null };
    const ok = normalizeWhitespace(paragraph.text) === normalizeWhitespace(locator.excerpt);
    return { ok, detail: ok ? `Item ${String(path.item)}, paragraph ${String(path.paragraphIndex)}` : "paragraph text differs from the stored excerpt", excerpt: paragraph.text, value: null };
  }
  return { ok: false, detail: `unsupported locator kind ${locator.kind}`, excerpt: null, value: null };
}

export function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  try {
    return new Decimal(a).equals(new Decimal(b));
  } catch {
    return false;
  }
}
