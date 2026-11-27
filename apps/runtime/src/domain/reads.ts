import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  caseSource,
  challenge,
  claim,
  claimImpact,
  correctionCase,
  financialFact,
  replacementProposal,
  reportWarning,
  researchReport,
  researchRevision,
  sourceDocument,
  sourceLocator,
} from "../db/schema.js";
import { getBlob } from "../sources/blob-store.js";
import { tableAt } from "../parsing/html-tables.js";
import { eligibleSource, eligibleSources } from "./eligibility.js";
import { DomainError, assert } from "./errors.js";
import { resolveLocator } from "./locator.js";

export async function caseSummary(workspaceId: string, caseId: string) {
  const row = await db.query.correctionCase.findFirst({ where: and(eq(correctionCase.id, caseId), eq(correctionCase.workspaceId, workspaceId)) });
  if (!row) throw new DomainError("NOT_FOUND", "case not found");
  const impacts = await db
    .select({ impact: claimImpact, claim, reportTitle: researchReport.title })
    .from(claimImpact)
    .innerJoin(claim, eq(claim.id, claimImpact.claimId))
    .innerJoin(researchReport, eq(researchReport.id, claimImpact.reportId))
    .where(eq(claimImpact.caseId, caseId))
    .orderBy(asc(researchReport.title), asc(claim.startOffset));
  const proposals = await db.select().from(replacementProposal).where(and(eq(replacementProposal.caseId, caseId), eq(replacementProposal.epoch, row.evidenceEpoch))).orderBy(desc(replacementProposal.createdAt));
  const challenges = await db.select().from(challenge).where(and(eq(challenge.caseId, caseId), eq(challenge.status, "OPEN")));
  const amendments = await db
    .select({ sourceId: caseSource.sourceId, accession: sourceDocument.accession, form: sourceDocument.form, epoch: caseSource.evidenceEpoch })
    .from(caseSource)
    .innerJoin(sourceDocument, eq(sourceDocument.id, caseSource.sourceId))
    .where(and(eq(caseSource.caseId, caseId), eq(caseSource.relation, "amendment")));
  return {
    caseId: row.id,
    issuerCik: row.issuerCik,
    title: row.title,
    status: row.status,
    evidenceEpoch: row.evidenceEpoch,
    scopeConfirmed: row.scopeConfirmed,
    periods: row.scope?.periods ?? [],
    amendments,
    claims: impacts.map(({ impact, claim: c, reportTitle }) => ({
      claimId: c.id,
      reportId: impact.reportId,
      reportTitle,
      label: c.label,
      category: c.category,
      material: c.material,
      text: c.text,
      classification: impact.classification,
      state: impact.state,
      formulaInputs: c.formula ? [...JSON.stringify(c.formula).matchAll(/"ref":"([0-9a-f-]{36})"/g)].map((m) => m[1]) : [],
    })),
    proposals: proposals.map((p) => ({ proposalId: p.id, claimId: p.claimId, kind: p.kind, status: p.status, proposer: p.proposerAgent, statusReason: p.statusReason })),
    openChallenges: challenges.map((c) => ({ challengeId: c.id, targetKind: c.targetKind, targetId: c.targetId, reasonCode: c.reasonCode, raisedBy: c.raisedBy, explanation: c.explanation })),
  };
}

export async function openCasesForIssuer(workspaceId: string, cik?: string) {
  const rows = await db
    .select()
    .from(correctionCase)
    .where(and(eq(correctionCase.workspaceId, workspaceId), cik ? eq(correctionCase.issuerCik, cik) : sql`true`, sql`${correctionCase.status} not in ('RESOLVED','NOT_APPLICABLE')`));
  return rows.map((r) => ({ caseId: r.id, issuerCik: r.issuerCik, title: r.title, status: r.status, evidenceEpoch: r.evidenceEpoch, scopeConfirmed: r.scopeConfirmed, periods: r.scope?.periods ?? [] }));
}

export async function listEligibleFilings(workspaceId: string, cik?: string) {
  const sources = await eligibleSources(db, workspaceId);
  return sources
    .filter((s) => !cik || s.cik === cik)
    .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
    .map((s) => ({ sourceId: s.id, cik: s.cik, accession: s.accession, form: s.form, filedDate: s.filedDate, reportDate: s.reportDate, availableAt: s.availableAt.toISOString(), url: s.url }));
}

/** Lists navigable sections without values: Item paragraphs for 8-Ks, statement table rows with one labelled locator per column for periodic reports. */
export async function sourceSections(workspaceId: string, sourceId: string, options: { periodEnds?: string[]; rowQuery?: string } = {}) {
  const source = await eligibleSource(db, workspaceId, sourceId);
  const textLocators = await db.select().from(sourceLocator).where(and(eq(sourceLocator.sourceId, source.id), eq(sourceLocator.kind, "text"))).orderBy(sql`(${sourceLocator.path}->>'paragraphIndex')::int`);
  const cells = await db
    .select({ locator: sourceLocator, column: financialFact.sourceColumn, periodEnd: financialFact.periodEnd, concept: financialFact.conceptId })
    .from(sourceLocator)
    .innerJoin(financialFact, eq(financialFact.locatorId, sourceLocator.id))
    .where(and(eq(sourceLocator.sourceId, source.id), eq(sourceLocator.kind, "html_table"), options.periodEnds?.length ? inArray(financialFact.periodEnd, options.periodEnds) : sql`true`));
  const query = options.rowQuery?.toLowerCase();
  type Cell = { column: string; header: string; periodEnd: string; locatorId: string };
  type Row = { label: string; concept: string; cells: Cell[] };
  const tables = new Map<number, { tableIndex: number; periodEnds: Set<string>; rows: Map<string, Row> }>();
  for (const { locator, column, periodEnd, concept } of cells) {
    const path = locator.path as { tableIndex: number; label: string; rowIndex: number; headerPath?: string[] };
    if (query && !path.label.toLowerCase().includes(query)) continue;
    const table = tables.get(path.tableIndex) ?? { tableIndex: path.tableIndex, periodEnds: new Set<string>(), rows: new Map<string, Row>() };
    table.periodEnds.add(periodEnd);
    const rowKey = `${path.rowIndex}`;
    const row: Row = table.rows.get(rowKey) ?? { label: path.label, concept, cells: [] };
    if (!row.cells.some((c) => c.locatorId === locator.id)) row.cells.push({ column, header: (path.headerPath ?? []).join(" / "), periodEnd, locatorId: locator.id });
    table.rows.set(rowKey, row);
    tables.set(path.tableIndex, table);
  }
  return {
    source: { sourceId: source.id, accession: source.accession, form: source.form, filedDate: source.filedDate, cik: source.cik },
    textSections: source.form.startsWith("8-K") ? textLocators.map((l) => ({ locatorId: l.id, item: (l.path as { item: string }).item, preview: l.excerpt.slice(0, 200) })) : [],
    tables: [...tables.values()].slice(0, 6).map((t) => ({ tableIndex: t.tableIndex, periodEnds: [...t.periodEnds].sort(), rows: [...t.rows.values()].slice(0, 30) })),
    note: "Each table cell has its own locator. Cite the locator of the cell you read, for example the as_restated column for a corrected figure.",
  };
}

/** Re-reads one locator from the stored filing bytes. Table rows come back with their column headers so the reader can pick the right column. */
export async function readExcerpt(workspaceId: string, locatorId: string) {
  const [locator] = await db.select().from(sourceLocator).where(eq(sourceLocator.id, locatorId));
  assert(locator, "NOT_FOUND", "locator not found");
  const source = await eligibleSource(db, workspaceId, locator.sourceId);
  const resolved = await resolveLocator(source, locator);
  assert(resolved.ok, "CONFLICT", `the cited location no longer matches the filing: ${resolved.detail}`);
  const base = { locatorId, kind: locator.kind, source: { accession: source.accession, form: source.form, filedDate: source.filedDate, url: source.url }, where: resolved.detail };
  if (locator.kind === "html_table") {
    const path = locator.path as { tableIndex: number; rowIndex: number };
    const table = tableAt(await getBlob(source.storageRef), path.tableIndex);
    const row = table?.rows.find((r) => r.rowIndex === path.rowIndex);
    const cited = (locator.path as { columnKey?: string; headerPath?: string[] }).headerPath?.join(" / ") ?? null;
    return {
      ...base,
      citedColumn: cited,
      tableContext: table?.context.slice(-300) ?? null,
      scaleNote: table?.scale ? `values in the table are stated in units of 10^${table.scale}` : "values are stated in whole units",
      rowLabel: row?.label ?? null,
      cells: row?.values.map((v) => ({ column: table!.columns.find((c) => c.key === v.columnKey)?.headerPath.join(" / ") ?? v.columnKey, printed: v.raw })) ?? [],
    };
  }
  return { ...base, text: resolved.excerpt };
}

export async function proposalForVerifier(workspaceId: string, proposalId: string) {
  const [row] = await db
    .select({ proposal: replacementProposal, claim })
    .from(replacementProposal)
    .innerJoin(claim, eq(claim.id, replacementProposal.claimId))
    .where(and(eq(replacementProposal.id, proposalId), eq(replacementProposal.workspaceId, workspaceId)));
  assert(row, "NOT_FOUND", "proposal not found");
  const [conceptId, periodType, periodEnd, unit] = row.claim.semanticKey ? (() => {
    const parts = row.claim.semanticKey!.split("|");
    return [parts[1], parts[2], parts[4], parts[6]];
  })() : [null, null, null, null];
  const amendments = await db
    .select({ sourceId: caseSource.sourceId, accession: sourceDocument.accession, form: sourceDocument.form })
    .from(caseSource)
    .innerJoin(sourceDocument, eq(sourceDocument.id, caseSource.sourceId))
    .where(and(eq(caseSource.caseId, row.proposal.caseId), eq(caseSource.relation, "amendment")));
  return {
    proposalId: row.proposal.id,
    caseId: row.proposal.caseId,
    epoch: row.proposal.epoch,
    kind: row.proposal.kind,
    status: row.proposal.status,
    proposer: row.proposal.proposerAgent,
    rationale: row.proposal.rationale,
    claim: { claimId: row.claim.id, label: row.claim.label, category: row.claim.category, text: row.claim.text, material: row.claim.material, identity: { conceptId, periodType, periodEnd, unit }, formula: row.claim.formula },
    amendmentSources: amendments,
    note: "The proposed value is withheld. Read the evidence yourself and submit the value you find.",
  };
}

export async function reportForEditing(workspaceId: string, reportId: string) {
  const report = await db.query.researchReport.findFirst({ where: and(eq(researchReport.id, reportId), eq(researchReport.workspaceId, workspaceId)) });
  assert(report?.currentRevisionId, "NOT_FOUND", "report not found");
  const revision = (await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, report.currentRevisionId) }))!;
  const claims = await db.select().from(claim).where(eq(claim.revisionId, revision.id)).orderBy(asc(claim.startOffset));
  const impacts = claims.length ? await db.select().from(claimImpact).where(inArray(claimImpact.claimId, claims.map((c) => c.id))) : [];
  const warnings = await db.select().from(reportWarning).where(and(eq(reportWarning.revisionId, revision.id), eq(reportWarning.state, "ACTIVE")));
  const verified = impacts.length
    ? await db.select({ claimId: replacementProposal.claimId, value: replacementProposal.value }).from(replacementProposal).innerJoin(correctionCase, eq(correctionCase.id, replacementProposal.caseId)).where(and(inArray(replacementProposal.claimId, claims.map((c) => c.id)), eq(replacementProposal.status, "VERIFIED"), eq(replacementProposal.epoch, correctionCase.evidenceEpoch)))
    : [];
  const verifiedIds = new Set(verified.map((v) => v.claimId));
  const verifiedValues = new Map(verified.map((v) => [v.claimId, v.value]));
  return {
    reportId: report.id,
    title: report.title,
    baseRevisionId: revision.id,
    version: revision.version,
    activeCases: [...new Set(warnings.map((w) => w.caseId))],
    blocks: revision.blocks.map((b) => ({
      blockId: b.id,
      kind: b.kind,
      text: b.text,
      claims: claims
        .filter((c) => c.blockId === b.id)
        .map((c) => {
          const impact = impacts.find((i) => i.claimId === c.id);
          const replacement = verifiedValues.get(c.id) ?? null;
          return {
            claimId: c.id,
            label: c.label,
            category: c.category,
            text: c.text,
            material: c.material,
            impactState: impact?.state ?? "UNAFFECTED",
            verifiedReplacementAvailable: verifiedIds.has(c.id),
            previousValue: c.valueDecimal,
            verifiedValue: replacement,
            signChange: c.valueDecimal && replacement ? (Number(c.valueDecimal) >= 0) !== (Number(replacement) >= 0) : null,
          };
        }),
    })),
  };
}
