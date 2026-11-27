import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { ENV } from "../config/env.js";
import { db, type Tx } from "../db/client.js";
import {
  claim,
  claimBinding,
  claimDependency,
  delivery,
  financialFact,
  publicationRecipient,
  publicationStatusEvent,
  researchReport,
  researchRevision,
  sourceDocument,
  syntheticRecipient,
  watchSubscription,
  workspace,
  workspaceSource,
} from "../db/schema.js";
import { computeFormula, displayDecimal, formulaRefs, remapRefs, type FormulaInput } from "../formula/engine.js";
import { parseDisplayedNumber } from "../parsing/numbers.js";
import { ensureIssuers, ingestManifestSource } from "../sources/ingest.js";
import { loadProvenance, sourceAvailableAt, type ProvenanceSource } from "../sources/provenance.js";
import { contentHash, locatePhrase, parseMarkdown } from "./document.js";
import { commit } from "./events.js";
import { loadFixtureMarkdown, loadFixtures, loadScenario, type FixtureClaim, type FixtureReport } from "./scenarios.js";

export const SYNTHETIC_PUBLICATION_LABEL = "Simulated publication time for a synthetic note";

export function randomId(bytes = 6): string {
  return randomBytes(bytes).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
}

export function recipientToken(recipientId: string): string {
  return createHmac("sha256", ENV.SESSION_SECRET).update(`recipient:${recipientId}`).digest("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SeedError extends Error {}

function displayedValue(fixtureClaim: FixtureClaim): string | null {
  const parsed = parseDisplayedNumber(fixtureClaim.match.replace(/\s*(thousand|million)$/i, ""));
  if (parsed.kind !== "number") return null;
  return parsed.value.times(10 ** (fixtureClaim.displayScale ?? 0)).toFixed();
}

async function factFor(tx: Tx, sourceId: string, concept: string, periodEnd: string) {
  const rows = await tx.query.financialFact.findMany({
    where: and(eq(financialFact.sourceId, sourceId), eq(financialFact.conceptId, concept), eq(financialFact.periodEnd, periodEnd), eq(financialFact.sourceColumn, "ordinary")),
  });
  const undimensioned = rows.filter((r) => Object.keys(r.dimensions).length === 0);
  return undimensioned.find((r) => r.extractionMethod === "inline_xbrl") ?? undimensioned[0] ?? null;
}

async function seedReport(
  tx: Tx,
  workspaceId: string,
  report: FixtureReport,
  publisherName: string,
  sourceIdByRef: Map<string, { id: string; availableAt: Date }>,
  recipientIdByName: Map<string, string>,
): Promise<string> {
  const markdown = await loadFixtureMarkdown(report);
  const blocks = parseMarkdown(markdown);
  const title = blocks.find((b) => b.kind === "heading")?.text ?? report.key;
  const asOf = new Date(report.asOf);
  const sourceIds = report.sourceRefs.map((ref) => {
    const source = sourceIdByRef.get(ref);
    if (!source) throw new SeedError(`${report.key}: source ${ref} is not loaded in this workspace`);
    if (source.availableAt > asOf) throw new SeedError(`${report.key}: source ${ref} was not public at the note's as-of time`);
    return source.id;
  });

  const [reportRow] = await tx
    .insert(researchReport)
    .values({ workspaceId, publicId: randomId(8), title, issuerCiks: report.issuerCiks, documentState: "PUBLISHED", reliability: "CLEAR", synthetic: true, publisherName })
    .returning();
  if (!reportRow) throw new SeedError("report insert failed");

  const [revision] = await tx
    .insert(researchRevision)
    .values({
      reportId: reportRow.id,
      workspaceId,
      version: 1,
      kind: "published",
      blocks,
      markdown,
      contentHash: contentHash({ blocks }),
      asOf,
      sourceRefs: sourceIds,
      documentState: "PUBLISHED",
      publishedAt: asOf,
      publicationLabel: SYNTHETIC_PUBLICATION_LABEL,
      createdBy: "seed:fixture",
    })
    .returning();
  if (!revision) throw new SeedError("revision insert failed");
  await tx.update(researchReport).set({ currentRevisionId: revision.id }).where(eq(researchReport.id, reportRow.id));

  const claimIdByKey = new Map<string, string>();
  const valueByKey = new Map<string, FormulaInput>();
  for (const fixtureClaim of report.claims) {
    const located = locatePhrase(blocks, fixtureClaim.match, fixtureClaim.occurrence);
    if (!located) throw new SeedError(`${report.key}/${fixtureClaim.key}: "${fixtureClaim.match}" not found`);
    const material = fixtureClaim.material ?? fixtureClaim.category !== "OTHER";
    let semanticKey: string | null = null;
    let valueDecimal: string | null = null;
    let factRow: Awaited<ReturnType<typeof factFor>> = null;

    if (fixtureClaim.binding) {
      const source = sourceIdByRef.get(fixtureClaim.binding.sourceRef);
      if (!source) throw new SeedError(`${report.key}/${fixtureClaim.key}: binding source missing`);
      factRow = await factFor(tx, source.id, fixtureClaim.binding.concept, fixtureClaim.binding.periodEnd);
      if (!factRow?.value) throw new SeedError(`${report.key}/${fixtureClaim.key}: no fact ${fixtureClaim.binding.concept} at ${fixtureClaim.binding.periodEnd}`);
      const shown = displayedValue(fixtureClaim);
      const factValue = new Decimal(factRow.value).toFixed();
      if (shown !== factValue) throw new SeedError(`${report.key}/${fixtureClaim.key}: note shows ${shown} but the filing reports ${factValue}`);
      semanticKey = factRow.semanticKey;
      valueDecimal = factValue;
      valueByKey.set(fixtureClaim.key, { ref: fixtureClaim.key, value: factValue, unit: factRow.unit, periodEnd: factRow.periodEnd, issuerCik: factRow.issuerCik });
    }
    if (fixtureClaim.formula) {
      const inputs = formulaRefs(fixtureClaim.formula).map((ref) => {
        const input = valueByKey.get(ref);
        if (!input) throw new SeedError(`${report.key}/${fixtureClaim.key}: formula input ${ref} must be declared first`);
        return input;
      });
      const result = computeFormula(fixtureClaim.formula, inputs);
      if (!result.ok) throw new SeedError(`${report.key}/${fixtureClaim.key}: ${result.message}`);
      const precision = fixtureClaim.displayPrecision ?? 0;
      const shown = displayedValue(fixtureClaim);
      const expected = displayDecimal(result.value, precision);
      const shownNormalized = result.unit === "pure" ? fixtureClaim.match : shown;
      if (shownNormalized !== expected) throw new SeedError(`${report.key}/${fixtureClaim.key}: note shows ${fixtureClaim.match} but the formula gives ${expected}`);
      valueDecimal = result.value;
      valueByKey.set(fixtureClaim.key, { ref: fixtureClaim.key, value: result.value, unit: result.unit, periodEnd: inputs[0]!.periodEnd, issuerCik: inputs[0]!.issuerCik });
    }

    const [claimRow] = await tx
      .insert(claim)
      .values({
        revisionId: revision.id,
        workspaceId,
        lineageId: crypto.randomUUID(),
        blockId: located.blockId,
        startOffset: located.start,
        endOffset: located.end,
        category: fixtureClaim.category,
        text: fixtureClaim.match,
        label: fixtureClaim.label,
        material,
        semanticKey,
        bindingState: fixtureClaim.category === "OTHER" || (fixtureClaim.category === "QUALITATIVE" && !fixtureClaim.dependsOn) ? "UNMAPPED" : "BOUND",
        formula: fixtureClaim.formula
          ? remapRefs(fixtureClaim.formula, (ref) => {
              const id = claimIdByKey.get(ref);
              if (!id) throw new SeedError(`${report.key}/${fixtureClaim.key}: formula input ${ref} is not a declared claim`);
              return id;
            })
          : null,
        displayPrecision: fixtureClaim.displayPrecision ?? null,
        displayUnit: fixtureClaim.displayUnit ?? (factRow ? factRow.unit : null),
        valueDecimal,
        reason: fixtureClaim.reason ?? null,
        creationMethod: "seeded_fixture",
        proposedBy: "seed:fixture",
      })
      .returning({ id: claim.id });
    if (!claimRow) throw new SeedError("claim insert failed");
    claimIdByKey.set(fixtureClaim.key, claimRow.id);

    if (factRow) {
      await tx.insert(claimBinding).values({ claimId: claimRow.id, workspaceId, kind: "fact", factId: factRow.id, justification: `Fixture binding to ${factRow.conceptId} at ${factRow.periodEnd}, verified equal to the displayed figure`, createdBy: "seed:fixture" });
      await tx.insert(claimDependency).values({ workspaceId, fromNode: `fact:${factRow.semanticKey}`, toNode: `claim:${claimRow.id}`, type: "CITES" }).onConflictDoNothing();
    }
    for (const ref of fixtureClaim.formula ? formulaRefs(fixtureClaim.formula) : []) {
      const inputClaimId = claimIdByKey.get(ref)!;
      await tx.insert(claimBinding).values({ claimId: claimRow.id, workspaceId, kind: "derived_input", refClaimId: inputClaimId, justification: `Formula input ${ref}`, createdBy: "seed:fixture" });
      await tx.insert(claimDependency).values({ workspaceId, fromNode: `claim:${inputClaimId}`, toNode: `claim:${claimRow.id}`, type: "DERIVES_FROM" }).onConflictDoNothing();
    }
    for (const ref of fixtureClaim.dependsOn ?? []) {
      const inputClaimId = claimIdByKey.get(ref);
      if (!inputClaimId) throw new SeedError(`${report.key}/${fixtureClaim.key}: dependency ${ref} must be declared first`);
      await tx.insert(claimBinding).values({ claimId: claimRow.id, workspaceId, kind: "qualifies", refClaimId: inputClaimId, justification: `Conclusion relies on ${ref}`, createdBy: "seed:fixture" });
      await tx.insert(claimDependency).values({ workspaceId, fromNode: `claim:${inputClaimId}`, toNode: `claim:${claimRow.id}`, type: "QUALIFIES" }).onConflictDoNothing();
    }
  }

  await tx.insert(publicationStatusEvent).values({ workspaceId, reportId: reportRow.id, revisionId: revision.id, type: "PUBLISHED", actor: "seed:fixture", reason: "Synthetic note seeded as version 1", occurredAt: asOf });
  for (const name of report.recipients) {
    const recipientId = recipientIdByName.get(name);
    if (!recipientId) throw new SeedError(`${report.key}: unknown recipient ${name}`);
    await tx.insert(publicationRecipient).values({ reportId: reportRow.id, recipientId, originalVersion: 1 });
    await tx.insert(delivery).values({
      workspaceId,
      revisionId: revision.id,
      recipientId,
      kind: "publication",
      subject: title,
      logicalKey: `publication:${revision.id}:${recipientId}`,
      status: "SIMULATED_DELIVERED",
      attemptCount: 1,
      deliveredAt: asOf,
    });
  }
  return reportRow.id;
}

export interface CreatedWorkspace {
  workspaceId: string;
  slug: string;
}

export async function createScenarioWorkspace(scenarioId: string, options: { reference?: boolean } = {}): Promise<CreatedWorkspace> {
  const scenario = await loadScenario(scenarioId);
  const fixtures = await loadFixtures();
  const manifest = await loadProvenance();
  const entryByRef = new Map(manifest.sources.map((s) => [s.ref, s]));
  const neededRefs = [...new Set([...scenario.preloadedSources, ...scenario.events.map((e) => e.sourceRef), ...fixtures.reports.filter((r) => scenario.reports.includes(r.key)).flatMap((r) => r.sourceRefs)])];
  await ensureIssuers();
  const entries: ProvenanceSource[] = neededRefs.map((ref) => {
    const entry = entryByRef.get(ref);
    if (!entry) throw new SeedError(`scenario ${scenarioId} references unknown source ${ref}`);
    return entry;
  });
  for (const entry of entries) await ingestManifestSource(entry, "snapshot");

  const { result } = await commit(async (tx, record) => {
    const slug = `${scenario.id.split("-")[0]}-${randomId(5)}`;
    const [ws] = await tx
      .insert(workspace)
      .values({
        slug,
        name: scenario.label,
        mode: "replay",
        scenarioId: scenario.id,
        logicalTime: new Date(scenario.initialAsOf),
        isReference: options.reference ?? false,
        expiresAt: options.reference ? null : new Date(Date.now() + ENV.DEMO_TTL_HOURS * 3_600_000),
        settings: { faults: scenario.faults },
      })
      .returning();
    if (!ws) throw new SeedError("workspace insert failed");

    const docs = await tx.query.sourceDocument.findMany({ where: inArray(sourceDocument.accession, entries.map((e) => e.accession)) });
    const sourceIdByRef = new Map<string, { id: string; availableAt: Date }>();
    for (const entry of entries) {
      const doc = docs.find((d) => d.accession === entry.accession && d.sha256 === entry.sha256);
      if (!doc) throw new SeedError(`source ${entry.ref} was not ingested`);
      const availableAt = sourceAvailableAt(entry);
      const eligible = scenario.preloadedSources.includes(entry.ref) || fixtures.reports.some((r) => scenario.reports.includes(r.key) && r.sourceRefs.includes(entry.ref));
      if (eligible && availableAt > new Date(scenario.initialAsOf)) throw new SeedError(`preloaded source ${entry.ref} is after the scenario start`);
      await tx.insert(workspaceSource).values({ workspaceId: ws.id, sourceId: doc.id, availableAt, eligible });
      sourceIdByRef.set(entry.ref, { id: doc.id, availableAt });
    }
    for (const cik of scenario.watchlist) {
      await tx.insert(watchSubscription).values({ workspaceId: ws.id, cik, forms: ["8-K", "10-K", "10-K/A", "10-Q", "10-Q/A"], intervalSeconds: ENV.SEC_POLL_INTERVAL_SECONDS });
    }
    const recipientIdByName = new Map<string, string>();
    for (const recipient of fixtures.recipients) {
      const recipientId = crypto.randomUUID();
      const token = recipientToken(recipientId);
      await tx.insert(syntheticRecipient).values({ id: recipientId, workspaceId: ws.id, displayName: recipient.displayName, organisation: recipient.organisation, address: recipient.address, tokenHash: hashToken(token), tokenHint: token.slice(0, 6) });
      recipientIdByName.set(recipient.displayName, recipientId);
    }
    const reportIds: string[] = [];
    for (const key of scenario.reports) {
      const report = fixtures.reports.find((r) => r.key === key);
      if (!report) throw new SeedError(`unknown fixture report ${key}`);
      reportIds.push(await seedReport(tx, ws.id, report, fixtures.publisher.name, sourceIdByRef, recipientIdByName));
    }
    await record({
      workspaceId: ws.id,
      type: "workspace.created",
      actor: { kind: "system", id: "seed" },
      payload: { scenarioId: scenario.id, logicalTime: scenario.initialAsOf, reports: reportIds.length, synthetic: true },
    });
    return { workspaceId: ws.id, slug };
  });
  return result;
}

/** A workspace that watches EDGAR for new filings from now on. It starts without research; notes are added through intake. */
export async function createLiveWorkspace(): Promise<CreatedWorkspace> {
  await ensureIssuers();
  const manifest = await loadProvenance();
  const fixtures = await loadFixtures();
  const { result } = await commit(async (tx, record) => {
    const slug = `live-${randomId(5)}`;
    const [ws] = await tx
      .insert(workspace)
      .values({ slug, name: "Live EDGAR monitor", mode: "live", logicalTime: null, expiresAt: new Date(Date.now() + ENV.DEMO_TTL_HOURS * 3_600_000), settings: {} })
      .returning();
    for (const issuerRow of manifest.issuers) {
      await tx.insert(watchSubscription).values({ workspaceId: ws!.id, cik: issuerRow.cik, forms: ["8-K", "10-K", "10-K/A", "10-Q", "10-Q/A"], intervalSeconds: ENV.SEC_POLL_INTERVAL_SECONDS });
    }
    for (const recipient of fixtures.recipients) {
      const recipientId = crypto.randomUUID();
      const token = recipientToken(recipientId);
      await tx.insert(syntheticRecipient).values({ id: recipientId, workspaceId: ws!.id, displayName: recipient.displayName, organisation: recipient.organisation, address: recipient.address, tokenHash: hashToken(token), tokenHint: token.slice(0, 6) });
    }
    await record({ workspaceId: ws!.id, type: "workspace.created", actor: { kind: "system", id: "seed" }, payload: { mode: "live", watchlist: manifest.issuers.map((i) => i.cik), reports: 0, synthetic: true } });
    return { workspaceId: ws!.id, slug };
  });
  return result;
}

export async function getWorkspaceBySlug(slug: string) {
  return db.query.workspace.findFirst({ where: eq(workspace.slug, slug) });
}
