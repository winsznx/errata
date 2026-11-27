import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "../db/client.js";
import { financialFact, issuer, sourceDocument, sourceLocator } from "../db/schema.js";
import { conceptForLabel, semanticKey } from "../parsing/concept-map.js";
import { extractItemSections, extractParagraphs } from "../parsing/filing-text.js";
import { parseTables } from "../parsing/html-tables.js";
import { parseInlineXbrl, scenarioRole } from "../parsing/ixbrl.js";
import { putBlob, sha256 } from "./blob-store.js";
import { filingHash } from "./canonical.js";
import { datasetsDir, loadProvenance, type ProvenanceSource } from "./provenance.js";
import { secFetch } from "./sec-client.js";

export const PARSE_VERSION = "errata-parse-1";
const RELEVANT_TABLE = /total current (assets|liabilities)|as restated|restatement adjustments?/i;

type FactInsert = typeof financialFact.$inferInsert;
type LocatorInsert = typeof sourceLocator.$inferInsert;

export interface IngestResult {
  sourceId: string;
  created: boolean;
  conflict: boolean;
  facts: number;
  locators: number;
}

async function readSnapshot(entry: ProvenanceSource): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(datasetsDir(), entry.path)));
}

/** Loads a manifest source from the verified snapshot or from sec.gov. Either way the bytes must hash to the manifest value. */
export async function loadSourceBytes(entry: ProvenanceSource, mode: "snapshot" | "live"): Promise<{ bytes: Uint8Array; contentType: string }> {
  const loaded = mode === "snapshot" ? { bytes: await readSnapshot(entry), contentType: "text/html" } : await secFetch(entry.url);
  if (mode === "snapshot" && sha256(loaded.bytes) !== entry.snapshotSha256) throw new Error(`snapshot bytes changed for ${entry.accession}`);
  const hash = filingHash(loaded.bytes);
  if (hash !== entry.sha256) throw new Error(`filing hash mismatch for ${entry.accession}: expected ${entry.sha256}, got ${hash}`);
  return loaded;
}

export async function ensureIssuers(tx: DbOrTx = db): Promise<void> {
  const manifest = await loadProvenance();
  for (const row of manifest.issuers) {
    await tx
      .insert(issuer)
      .values({ cik: row.cik, legalName: row.name, aliases: [{ name: row.name, ticker: row.ticker }], verifiedAt: new Date() })
      .onConflictDoNothing();
  }
}

export async function ingestManifestSource(entry: ProvenanceSource, mode: "snapshot" | "live" = "snapshot"): Promise<IngestResult> {
  const existing = await db.query.sourceDocument.findFirst({
    where: and(eq(sourceDocument.accession, entry.accession), eq(sourceDocument.sha256, entry.sha256)),
  });
  if (existing?.parseVersion === PARSE_VERSION) return { sourceId: existing.id, created: false, conflict: existing.conflict, facts: 0, locators: 0 };

  const { bytes, contentType } = await loadSourceBytes(entry, mode);
  const { storageRef } = await putBlob(bytes);
  return db.transaction(async (tx) => {
    const sameAccession = await tx.query.sourceDocument.findMany({ where: eq(sourceDocument.accession, entry.accession) });
    const conflict = sameAccession.some((s) => s.sha256 !== entry.sha256);
    const [doc] = existing
      ? [existing]
      : await tx
          .insert(sourceDocument)
          .values({
            cik: entry.cik,
            accession: entry.accession,
            form: entry.form,
            reportDate: entry.reportDate,
            filedDate: entry.filedDate,
            acceptedAt: entry.acceptedAt ? new Date(entry.acceptedAt) : null,
            availabilityPrecision: entry.availabilityPrecision,
            url: entry.url,
            retrievedAt: new Date(),
            retrievalMode: mode === "snapshot" ? "verified_snapshot" : "live_fetch",
            contentType,
            sha256: entry.sha256,
            bytes: bytes.byteLength,
            storageRef,
            conflict,
          })
          .returning();
    if (!doc) throw new Error("source insert failed");
    const counts = await extractStoredSource(tx, doc.id, entry.cik, entry.form, bytes);
    await tx.update(sourceDocument).set({ parseVersion: PARSE_VERSION }).where(eq(sourceDocument.id, doc.id));
    return { sourceId: doc.id, created: !existing, conflict, ...counts };
  });
}

async function insertLocator(tx: DbOrTx, row: Omit<LocatorInsert, "excerptHash">): Promise<string> {
  const excerptHash = sha256(`${row.kind}:${JSON.stringify(row.path)}:${row.excerpt}`);
  const [inserted] = await tx
    .insert(sourceLocator)
    .values({ ...row, excerptHash })
    .onConflictDoNothing()
    .returning({ id: sourceLocator.id });
  if (inserted) return inserted.id;
  const found = await tx.query.sourceLocator.findFirst({
    where: and(eq(sourceLocator.sourceId, row.sourceId), eq(sourceLocator.kind, row.kind), eq(sourceLocator.excerptHash, excerptHash)),
  });
  if (!found) throw new Error("locator upsert failed");
  return found.id;
}

export async function extractStoredSource(tx: DbOrTx, sourceId: string, cik: string, form: string, bytes: Uint8Array): Promise<{ facts: number; locators: number }> {
  const html = Buffer.from(bytes);
  let locators = 0;
  const facts: FactInsert[] = [];

  const sections = extractItemSections(extractParagraphs(html));
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      await insertLocator(tx, {
        sourceId,
        kind: "text",
        path: { item: section.item, paragraphIndex: paragraph.index },
        excerpt: paragraph.text,
        xbrlFactId: null,
      });
      locators += 1;
    }
  }
  if (form.startsWith("8-K")) return { facts: 0, locators };

  const isAmendment = form.endsWith("/A");
  const xbrlFacts = parseInlineXbrl(html).filter((f) => f.value !== null && f.unit === "USD");
  const reportedIdentities = new Set<string>();
  const prepared = xbrlFacts.map((fact) => {
    const { role, identityDimensions } = scenarioRole(fact.context.dimensions);
    const key = semanticKey({
      cik,
      conceptId: fact.concept,
      periodType: fact.context.periodType,
      periodStart: fact.context.periodStart,
      periodEnd: fact.context.periodEnd,
      dimensions: identityDimensions,
      unit: fact.unit,
    });
    if (role === "as_reported") reportedIdentities.add(key);
    return { fact, role, identityDimensions, key };
  });
  for (const { fact, role, identityDimensions, key } of prepared) {
    const column = role ?? (isAmendment && reportedIdentities.has(key) ? "as_restated" : "ordinary");
    const locatorId = await insertLocator(tx, {
      sourceId,
      kind: "ixbrl",
      path: { factId: fact.factId, concept: fact.concept, contextRef: fact.contextRef },
      excerpt: fact.rowExcerpt || fact.rawText,
      xbrlFactId: fact.factId,
    });
    locators += 1;
    facts.push({
      sourceId,
      locatorId,
      issuerCik: cik,
      conceptId: fact.concept,
      label: fact.rowLabel || fact.concept,
      statementType: fact.context.periodType === "instant" ? "balance_sheet" : "period_statement",
      periodType: fact.context.periodType,
      periodStart: fact.context.periodStart,
      periodEnd: fact.context.periodEnd,
      dimensions: identityDimensions,
      scope: Object.keys(identityDimensions).length ? "dimensional" : "consolidated",
      unit: fact.unit,
      currency: fact.unit === "USD" ? "USD" : null,
      scale: fact.scale,
      rawText: fact.rawText,
      value: fact.value!.toFixed(),
      sourceColumn: column,
      semanticKey: key,
      extractionMethod: "inline_xbrl",
      parseVersion: PARSE_VERSION,
    });
  }

  for (const table of parseTables(html, (text) => RELEVANT_TABLE.test(text))) {
    const isBalanceSheet = table.statementType === "balance_sheet" || table.rows.some((r) => /^total current (assets|liabilities)$/i.test(r.label));
    if (!isBalanceSheet) continue;
    const columnsByKey = new Map(table.columns.map((c) => [c.key, c]));
    for (const row of table.rows) {
      const mapping = conceptForLabel(row.label);
      for (const value of row.values) {
        const column = columnsByKey.get(value.columnKey);
        if (!column?.periodEnd || value.value === null) continue;
        const role = column.role === "ordinary" && isAmendment && /restated/i.test(table.context) ? "as_restated" : column.role;
        const normalized = value.value.times(10 ** table.scale);
        const locatorId = await insertLocator(tx, {
          sourceId,
          kind: "html_table",
          path: { tableIndex: table.tableIndex, rowIndex: row.rowIndex, columnKey: column.key, headerPath: column.headerPath, label: row.label },
          excerpt: row.excerpt,
          xbrlFactId: null,
        });
        locators += 1;
        facts.push({
          sourceId,
          locatorId,
          issuerCik: cik,
          conceptId: mapping.conceptId,
          label: row.label,
          statementType: table.statementType,
          periodType: "instant",
          periodStart: null,
          periodEnd: column.periodEnd,
          dimensions: {},
          scope: "consolidated",
          unit: "USD",
          currency: "USD",
          scale: table.scale,
          rawText: value.raw,
          value: normalized.toFixed(),
          sourceColumn: role === "unknown" ? "unknown" : role,
          semanticKey: semanticKey({
            cik,
            conceptId: mapping.conceptId,
            periodType: "instant",
            periodStart: null,
            periodEnd: column.periodEnd,
            dimensions: {},
            unit: "USD",
          }),
          extractionMethod: `html_table:${mapping.method}`,
          parseVersion: PARSE_VERSION,
        });
      }
    }
  }

  for (let i = 0; i < facts.length; i += 500) {
    await tx.insert(financialFact).values(facts.slice(i, i + 500)).onConflictDoNothing();
  }
  return { facts: facts.length, locators };
}
