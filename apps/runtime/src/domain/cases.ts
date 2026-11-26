import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import {
  caseSource,
  challenge,
  claim,
  claimImpact,
  correctionCase,
  disclosureEvent,
  editorialReview,
  financialFact,
  reportWarning,
  researchReport,
  researchRevision,
  sourceDocument,
  sourceLocator,
  verificationAttestation,
  workspace,
  workspaceSource,
} from "../db/schema.js";
import { loadProvenance } from "../sources/provenance.js";
import { loadScenario } from "./scenarios.js";
import { findDates } from "../parsing/numbers.js";
import { eligibleSource } from "./eligibility.js";
import { DomainError, assert } from "./errors.js";
import { commit, type Actor, type CommittedEvent, type EventInput } from "./events.js";
import { factInScope, factNodesForIssuer, parseFactNode, reachableClaims, type ScopePeriod } from "./graph.js";

export interface ActorContext {
  workspaceId: string;
  actor: Actor;
  agentRunId?: string | null;
  epoch?: number | null;
}

type Record_ = (input: EventInput) => Promise<CommittedEvent>;

const NON_RELIANCE_LANGUAGE = /(no longer be relied upon|should not be relied upon|should no longer be relied|contained material errors and should be restated|should be restated)/i;

export async function lockCase(tx: Tx, workspaceId: string, caseId: string) {
  const [row] = await tx
    .select()
    .from(correctionCase)
    .where(and(eq(correctionCase.id, caseId), eq(correctionCase.workspaceId, workspaceId)))
    .for("update");
  if (!row) throw new DomainError("NOT_FOUND", "case not found", { caseId });
  return row;
}

export function guardEpoch(ctx: ActorContext, currentEpoch: number): void {
  if (ctx.epoch !== undefined && ctx.epoch !== null && ctx.epoch !== currentEpoch) {
    throw new DomainError("STALE_EVIDENCE", `work started on evidence revision ${ctx.epoch} but the case is now on revision ${currentEpoch}`, { expectedEpoch: ctx.epoch, currentEpoch });
  }
}

async function locatorsForSource(tx: Tx, sourceId: string, locatorIds: string[]) {
  assert(locatorIds.length > 0 && locatorIds.length <= 20, "INVALID_INPUT", "cite between 1 and 20 source locators");
  const rows = await tx.query.sourceLocator.findMany({ where: and(eq(sourceLocator.sourceId, sourceId), inArray(sourceLocator.id, locatorIds)) });
  assert(rows.length === new Set(locatorIds).size, "INVALID_INPUT", "every cited locator must belong to the disclosure document", { locatorIds });
  return rows;
}

function validatePeriods(periods: ScopePeriod[], excerptText: string): void {
  assert(periods.length > 0 && periods.length <= 12, "INVALID_INPUT", "scope needs between 1 and 12 periods");
  const written = new Set(findDates(excerptText));
  for (const period of periods) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(period.end), "INVALID_INPUT", `period end ${period.end} must be YYYY-MM-DD`);
    assert(written.has(period.end), "INVALID_INPUT", `period ending ${period.end} is not stated in the cited excerpt`, { periodEnd: period.end });
  }
}

function sameScope(a: ScopePeriod[], b: ScopePeriod[]): boolean {
  const key = (p: ScopePeriod[]) => [...new Set(p.map((x) => x.end))].sort().join(",");
  return key(a) === key(b);
}

/** Advances a replay to the next scheduled public filing. Idempotent on the expected position. */
export async function advanceReplay(workspaceId: string, expectedPosition: number, actor: Actor) {
  const { result } = await commit(async (tx, record) => {
    const [ws] = await tx.select().from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    assert(ws, "NOT_FOUND", "workspace not found");
    assert(ws.mode === "replay" && ws.scenarioId, "CONFLICT", "workspace is not a replay");
    assert(ws.replayPosition === expectedPosition, "CONFLICT", "replay has already moved on", { currentPosition: ws.replayPosition });
    const scenario = await loadScenario(ws.scenarioId);
    const next = scenario.events[ws.replayPosition];
    assert(next, "REPLAY_FINISHED", "every scheduled disclosure has been released");
    const entry = (await loadProvenance()).sources.find((s) => s.ref === next.sourceRef);
    assert(entry, "NOT_FOUND", "scenario source missing from manifest");
    const [link] = await tx
      .select({ link: workspaceSource })
      .from(workspaceSource)
      .innerJoin(sourceDocument, eq(sourceDocument.id, workspaceSource.sourceId))
      .where(and(eq(workspaceSource.workspaceId, workspaceId), eq(sourceDocument.accession, entry.accession), eq(sourceDocument.sha256, entry.sha256)));
    assert(link, "NOT_FOUND", "scenario source is not linked to the workspace");
    const logicalTime = link.link.availableAt > (ws.logicalTime ?? new Date(0)) ? link.link.availableAt : ws.logicalTime!;
    await tx.update(workspaceSource).set({ eligible: true }).where(and(eq(workspaceSource.workspaceId, workspaceId), eq(workspaceSource.sourceId, link.link.sourceId)));
    await tx.update(workspace).set({ replayPosition: ws.replayPosition + 1, logicalTime, updatedAt: new Date() }).where(eq(workspace.id, workspaceId));
    const source = await eligibleSource(tx, workspaceId, link.link.sourceId);
    const [disclosure] = await tx
      .insert(disclosureEvent)
      .values({ workspaceId, sourceId: source.id, type: source.form, status: "DISCOVERED", eventKey: `${source.accession}` })
      .onConflictDoNothing()
      .returning();
    await record({ workspaceId, type: "replay.advanced", actor, payload: { position: ws.replayPosition + 1, of: scenario.events.length, label: next.label, logicalTime: logicalTime.toISOString() } });
    const discovered = await record({
      workspaceId,
      type: "filing.discovered",
      actor: { kind: "system", id: "replay" },
      payload: {
        disclosureEventId: disclosure?.id ?? null,
        sourceId: source.id,
        cik: source.cik,
        accession: source.accession,
        form: source.form,
        filedDate: source.filedDate,
        eligibleAt: link.link.availableAt.toISOString(),
        label: next.label,
      },
    });
    return { position: ws.replayPosition + 1, of: scenario.events.length, logicalTime: logicalTime.toISOString(), eventId: discovered.id, sourceId: source.id };
  });
  return result;
}

interface PropagationResult {
  affectedReportIds: string[];
  impacts: number;
  candidates: number;
}

async function propagate(tx: Tx, caseRow: typeof correctionCase.$inferSelect, periods: ScopePeriod[], confirmed: boolean, record: Record_, causationId: string | null): Promise<PropagationResult> {
  const nodes = (await factNodesForIssuer(tx, caseRow.workspaceId, caseRow.issuerCik)).filter((node) => {
    const parts = parseFactNode(node);
    return parts ? factInScope(parts, caseRow.issuerCik, periods) !== null : false;
  });
  const reached = await reachableClaims(tx, caseRow.workspaceId, nodes);
  const reachedIds = reached.map((r) => r.claimId);
  const claimRows = reachedIds.length
    ? await tx
        .select({ claim, revision: researchRevision })
        .from(claim)
        .innerJoin(researchRevision, eq(researchRevision.id, claim.revisionId))
        .where(and(inArray(claim.id, reachedIds), inArray(researchRevision.documentState, ["PUBLISHED", "SUPERSEDED"])))
    : [];
  const state = confirmed ? "INVALIDATED" : "UNDER_REVIEW";
  const affectedRevisions = new Map<string, string>();
  for (const { claim: c, revision } of claimRows) {
    const path = reached.find((r) => r.claimId === c.id)!.path;
    const factNode = path[0] ? parseFactNode(path[0]) : null;
    const period = factNode ? periods.find((p) => p.end === factNode.periodEnd) : null;
    const reason =
      c.category === "DIRECT"
        ? `Cites ${factNode?.conceptId ?? "a reported figure"} for ${period?.label ?? factNode?.periodEnd}, which the disclosure says should no longer be relied upon`
        : c.category === "DERIVED"
          ? `Calculated from figures for ${period?.label ?? factNode?.periodEnd} that the disclosure says should no longer be relied upon`
          : `Conclusion rests on figures for ${period?.label ?? factNode?.periodEnd} that the disclosure says should no longer be relied upon`;
    const existing = await tx.query.claimImpact.findFirst({ where: and(eq(claimImpact.caseId, caseRow.id), eq(claimImpact.claimId, c.id)) });
    if (!existing) {
      await tx.insert(claimImpact).values({ caseId: caseRow.id, claimId: c.id, reportId: revision.reportId, classification: c.category.toLowerCase(), path, reason, state, epoch: caseRow.evidenceEpoch });
    } else if (existing.state === "UNDER_REVIEW" && confirmed) {
      await tx.update(claimImpact).set({ state, reason, path, updatedAt: new Date(), rowVersion: existing.rowVersion + 1 }).where(eq(claimImpact.id, existing.id));
    }
    if (c.material) affectedRevisions.set(revision.id, revision.reportId);
  }

  const issuerReports = await tx
    .select()
    .from(researchReport)
    .where(and(eq(researchReport.workspaceId, caseRow.workspaceId), sql`${researchReport.issuerCiks} @> ${JSON.stringify([caseRow.issuerCik])}::jsonb`));
  let candidates = 0;
  const candidateRevisions = new Map<string, string>();
  for (const report of issuerReports) {
    if ([...affectedRevisions.values()].includes(report.id) || !report.currentRevisionId) continue;
    const unmapped = await tx.query.claim.findMany({
      where: and(eq(claim.revisionId, report.currentRevisionId), inArray(claim.category, ["QUALITATIVE", "UNRESOLVED"]), eq(claim.bindingState, "UNMAPPED")),
    });
    for (const c of unmapped) {
      const existing = await tx.query.claimImpact.findFirst({ where: and(eq(claimImpact.caseId, caseRow.id), eq(claimImpact.claimId, c.id)) });
      if (existing) continue;
      await tx.insert(claimImpact).values({
        caseId: caseRow.id,
        claimId: c.id,
        reportId: report.id,
        classification: "candidate",
        path: [`issuer:${caseRow.issuerCik}`, `claim:${c.id}`],
        reason: "The note covers this issuer but the claim has no recorded dependency on a reported figure, so it needs review before it can be cleared",
        state: "UNDER_REVIEW",
        epoch: caseRow.evidenceEpoch,
      });
      candidates += 1;
      candidateRevisions.set(report.currentRevisionId, report.id);
    }
  }

  for (const [revisionId, reportId] of [...affectedRevisions, ...candidateRevisions]) {
    const isAffected = affectedRevisions.has(revisionId);
    const type = isAffected && confirmed ? "NON_RELIANCE" : "UNDER_REVIEW";
    const headline = type === "NON_RELIANCE" ? "Figures in this note rely on financial statements the issuer says should no longer be relied upon" : "Under review after a new disclosure from the issuer";
    const detail =
      type === "NON_RELIANCE"
        ? "Corrected figures are not available yet. The original text is unchanged and stays visible for reference."
        : "Errata is checking whether this note depends on the affected financial statements.";
    const existing = await tx.query.reportWarning.findFirst({ where: and(eq(reportWarning.revisionId, revisionId), eq(reportWarning.caseId, caseRow.id)) });
    if (existing && existing.type === type) continue;
    if (existing) {
      await tx.update(reportWarning).set({ type, severity: type === "NON_RELIANCE" ? "high" : "medium", headline, detail, state: "ACTIVE" }).where(eq(reportWarning.id, existing.id));
    } else {
      await tx.insert(reportWarning).values({ workspaceId: caseRow.workspaceId, reportId, revisionId, caseId: caseRow.id, type, severity: type === "NON_RELIANCE" ? "high" : "medium", headline, detail, state: "ACTIVE" });
    }
    const report = await tx.query.researchReport.findFirst({ where: eq(researchReport.id, reportId) });
    if (report && report.currentRevisionId === revisionId) {
      const reliability = type === "NON_RELIANCE" ? "NON_RELIANCE" : report.reliability === "NON_RELIANCE" ? "NON_RELIANCE" : "UNDER_REVIEW";
      await tx.update(researchReport).set({ reliability, updatedAt: new Date(), rowVersion: report.rowVersion + 1 }).where(eq(researchReport.id, reportId));
    }
    await record({
      workspaceId: caseRow.workspaceId,
      type: "report.warning_applied",
      actor: { kind: "system", id: "propagation" },
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      causationId,
      payload: { reportId, revisionId, warningType: type, headline },
    });
  }

  const unaffected = await tx
    .select({ id: researchReport.id, title: researchReport.title })
    .from(researchReport)
    .where(and(eq(researchReport.workspaceId, caseRow.workspaceId), sql`not (${researchReport.issuerCiks} @> ${JSON.stringify([caseRow.issuerCik])}::jsonb)`));
  if (unaffected.length) {
    await record({
      workspaceId: caseRow.workspaceId,
      type: "case.reports_unaffected",
      actor: { kind: "system", id: "propagation" },
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      causationId,
      payload: { reports: unaffected.map((r) => ({ reportId: r.id, title: r.title, reason: "The note does not cover this issuer" })) },
    });
  }
  if (claimRows.length) {
    await record({
      workspaceId: caseRow.workspaceId,
      type: confirmed ? "claim.invalidated" : "claim.affected",
      actor: { kind: "system", id: "propagation" },
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      causationId,
      payload: { claimIds: claimRows.map((r) => r.claim.id), reportIds: [...new Set(affectedRevisions.values())] },
    });
  }
  return { affectedReportIds: [...new Set(affectedRevisions.values())], impacts: claimRows.length, candidates };
}

export interface ScopeInput {
  sourceId: string;
  classification: "NON_RELIANCE" | "AMENDMENT" | "UNRELATED";
  periods: ScopePeriod[];
  locatorIds: string[];
  summary: string;
}

export async function proposeDisclosureScope(ctx: ActorContext, input: ScopeInput) {
  return commit(async (tx, record) => {
    const source = await eligibleSource(tx, ctx.workspaceId, input.sourceId);
    const disclosure = await tx.query.disclosureEvent.findFirst({ where: and(eq(disclosureEvent.workspaceId, ctx.workspaceId), eq(disclosureEvent.sourceId, source.id)) });
    assert(disclosure, "NOT_FOUND", "no disclosure event for this source");
    const locators = await locatorsForSource(tx, source.id, input.locatorIds);
    const excerpt = locators.map((l) => l.excerpt).join("\n");

    if (input.classification !== "NON_RELIANCE") {
      await tx.update(disclosureEvent).set({ status: "CLASSIFIED", scope: { classification: input.classification }, evidenceLocatorIds: input.locatorIds, proposedBy: ctx.actor.id, reason: input.summary.slice(0, 1000), updatedAt: new Date() }).where(eq(disclosureEvent.id, disclosure.id));
      await record({ workspaceId: ctx.workspaceId, type: "filing.classified", actor: ctx.actor, payload: { disclosureEventId: disclosure.id, sourceId: source.id, classification: input.classification, summary: input.summary.slice(0, 500) } });
      return { caseId: null, classification: input.classification };
    }

    assert(NON_RELIANCE_LANGUAGE.test(excerpt), "INVALID_INPUT", "the cited excerpt does not contain non-reliance language");
    validatePeriods(input.periods, excerpt);
    const existingCase = await tx.query.correctionCase.findFirst({ where: and(eq(correctionCase.workspaceId, ctx.workspaceId), eq(correctionCase.originEventId, disclosure.id)) });
    assert(!existingCase?.scopeConfirmed, "CONFLICT", "scope for this disclosure is already confirmed", { caseId: existingCase?.id });

    await tx
      .update(disclosureEvent)
      .set({ status: "SCOPE_PROPOSED", scope: { classification: "NON_RELIANCE", periods: input.periods }, evidenceLocatorIds: input.locatorIds, proposedBy: ctx.actor.id, reason: input.summary.slice(0, 1000), updatedAt: new Date() })
      .where(eq(disclosureEvent.id, disclosure.id));
    const issuerName = (await tx.query.issuer.findFirst({ where: (t, { eq: e }) => e(t.cik, source.cik) }))?.legalName ?? source.cik;
    const caseRow =
      existingCase ??
      (
        await tx
          .insert(correctionCase)
          .values({ workspaceId: ctx.workspaceId, issuerCik: source.cik, originEventId: disclosure.id, status: "INVESTIGATING", title: `${issuerName} non-reliance (${source.form}, filed ${source.filedDate})`, scope: { periods: input.periods } })
          .returning()
      )[0]!;
    if (existingCase) await tx.update(correctionCase).set({ scope: { periods: input.periods }, lastUpdatedAt: new Date() }).where(eq(correctionCase.id, caseRow.id));
    const proposed = await record({
      workspaceId: ctx.workspaceId,
      type: "filing.scope_proposed",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { disclosureEventId: disclosure.id, sourceId: source.id, periods: input.periods, locatorIds: input.locatorIds, summary: input.summary.slice(0, 500), agentRunId: ctx.agentRunId ?? null },
    });
    const propagation = await propagate(tx, caseRow, input.periods, false, record, proposed.id);
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { caseId: caseRow.id, ...propagation };
  });
}

export interface ScopeCheckInput {
  caseId: string;
  verdict: "confirm" | "dispute";
  periods: ScopePeriod[];
  locatorIds: string[];
  explanation: string;
}

export async function checkDisclosureScope(ctx: ActorContext, input: ScopeCheckInput) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const disclosure = await tx.query.disclosureEvent.findFirst({ where: eq(disclosureEvent.id, caseRow.originEventId) });
    assert(disclosure, "NOT_FOUND", "origin disclosure missing");
    assert(!caseRow.scopeConfirmed, "CONFLICT", "scope is already confirmed");
    assert(disclosure.proposedBy && disclosure.proposedBy !== ctx.actor.id, "SELF_VERIFICATION", "the scope must be checked by a different participant than the one that proposed it");
    const locators = await locatorsForSource(tx, disclosure.sourceId, input.locatorIds);
    const excerpt = locators.map((l) => l.excerpt).join("\n");
    const proposedPeriods = ((disclosure.scope as { periods?: ScopePeriod[] } | null)?.periods ?? []) as ScopePeriod[];

    if (input.verdict === "confirm") {
      validatePeriods(input.periods, excerpt);
      assert(NON_RELIANCE_LANGUAGE.test(excerpt), "INVALID_INPUT", "the independently cited excerpt does not contain non-reliance language");
    }
    if (input.verdict === "dispute" || !sameScope(input.periods, proposedPeriods)) {
      const [raised] = await tx
        .insert(challenge)
        .values({ workspaceId: ctx.workspaceId, caseId: caseRow.id, targetKind: "disclosure_scope", targetId: disclosure.id, epoch: caseRow.evidenceEpoch, raisedBy: ctx.actor.id, reasonCode: "SCOPE_MISMATCH", explanation: input.explanation.slice(0, 1500), refs: input.locatorIds, status: "OPEN" })
        .returning();
      await record({
        workspaceId: ctx.workspaceId,
        type: "challenge.raised",
        actor: ctx.actor,
        caseId: caseRow.id,
        evidenceEpoch: caseRow.evidenceEpoch,
        payload: { challengeId: raised!.id, targetKind: "disclosure_scope", targetId: disclosure.id, reasonCode: "SCOPE_MISMATCH", proposedPeriods: proposedPeriods.map((p) => p.end), checkedPeriods: input.periods.map((p) => p.end), explanation: input.explanation.slice(0, 500) },
      });
      await recomputeCaseStatus(tx, caseRow.id, record);
      return { confirmed: false, challengeId: raised!.id };
    }

    await tx.update(disclosureEvent).set({ status: "SCOPE_CONFIRMED", confirmedBy: ctx.actor.id, updatedAt: new Date() }).where(eq(disclosureEvent.id, disclosure.id));
    await tx.update(correctionCase).set({ scopeConfirmed: true, scope: { periods: proposedPeriods }, rowVersion: caseRow.rowVersion + 1, lastUpdatedAt: new Date() }).where(eq(correctionCase.id, caseRow.id));
    await tx
      .update(challenge)
      .set({ status: "RESOLVED", resolution: `Scope confirmed by ${ctx.actor.id}`, resolvedAt: new Date() })
      .where(and(eq(challenge.caseId, caseRow.id), eq(challenge.targetKind, "disclosure_scope"), eq(challenge.status, "OPEN")));
    const detected = await record({
      workspaceId: ctx.workspaceId,
      type: "filing.non_reliance_detected",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { disclosureEventId: disclosure.id, periods: proposedPeriods, proposedBy: disclosure.proposedBy, confirmedBy: ctx.actor.id, locatorIds: input.locatorIds, explanation: input.explanation.slice(0, 500) },
    });
    const propagation = await propagate(tx, { ...caseRow, scopeConfirmed: true }, proposedPeriods, true, record, detected.id);
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { confirmed: true, ...propagation };
  });
}

export interface AmendmentLinkInput {
  caseId: string;
  sourceId: string;
  locatorIds: string[];
  summary: string;
}

export async function linkAmendment(ctx: ActorContext, input: AmendmentLinkInput) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    assert(caseRow.scopeConfirmed, "BLOCKED", "the non-reliance scope must be confirmed before an amendment can be linked");
    const source = await eligibleSource(tx, ctx.workspaceId, input.sourceId);
    assert(source.cik === caseRow.issuerCik, "INVALID_INPUT", "the amendment is from a different issuer");
    assert(/^(10-K|10-Q)(\/A)?$/.test(source.form), "INVALID_INPUT", `form ${source.form} cannot carry restated statements`);
    const already = await tx.query.caseSource.findFirst({ where: and(eq(caseSource.caseId, caseRow.id), eq(caseSource.sourceId, source.id)) });
    assert(!already, "CONFLICT", "this filing is already linked to the case");
    await locatorsForSource(tx, source.id, input.locatorIds);
    const periods = caseRow.scope?.periods ?? [];
    const restated = await tx.query.financialFact.findMany({
      where: and(eq(financialFact.sourceId, source.id), eq(financialFact.sourceColumn, "as_restated"), inArray(financialFact.periodEnd, periods.map((p) => p.end))),
      limit: 1,
    });
    assert(restated.length > 0, "INVALID_INPUT", "the filing has no restated figures for any period in the case scope");

    const newEpoch = caseRow.evidenceEpoch + 1;
    await tx.insert(caseSource).values({ caseId: caseRow.id, sourceId: source.id, relation: "amendment", evidenceEpoch: newEpoch, linkedBy: ctx.actor.id });
    await tx.update(correctionCase).set({ evidenceEpoch: newEpoch, rowVersion: caseRow.rowVersion + 1, lastUpdatedAt: new Date() }).where(eq(correctionCase.id, caseRow.id));
    await tx.update(verificationAttestation).set({ valid: false }).where(and(lt(verificationAttestation.epoch, newEpoch), sql`${verificationAttestation.proposalId} in (select id from replacement_proposal where case_id = ${caseRow.id})`));
    await tx.update(editorialReview).set({ valid: false }).where(sql`${editorialReview.candidateId} in (select id from research_revision where case_id = ${caseRow.id})`);
    await tx.update(researchRevision).set({ candidateState: "EXPIRED" }).where(and(eq(researchRevision.caseId, caseRow.id), eq(researchRevision.documentState, "DRAFT"), ne(researchRevision.candidateState, "PUBLISHED")));
    await tx.execute(sql`update replacement_proposal set status = 'SUPERSEDED', status_reason = 'Evidence revision advanced', updated_at = now() where case_id = ${caseRow.id} and epoch < ${newEpoch} and status in ('PROPOSED', 'VERIFIED')`);
    const linked = await record({
      workspaceId: ctx.workspaceId,
      type: "filing.amendment_received",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: newEpoch,
      payload: { sourceId: source.id, accession: source.accession, form: source.form, locatorIds: input.locatorIds, summary: input.summary.slice(0, 500), agentRunId: ctx.agentRunId ?? null },
    });
    await record({
      workspaceId: ctx.workspaceId,
      type: "evidence.superseded",
      actor: { kind: "system", id: "case-engine" },
      caseId: caseRow.id,
      evidenceEpoch: newEpoch,
      causationId: linked.id,
      payload: { previousEpoch: caseRow.evidenceEpoch, newEpoch, reason: `Amended filing ${source.accession} linked` },
    });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { epoch: newEpoch };
  });
}

/** Derives the case status from durable impact, proposal, challenge and publication state. */
export async function recomputeCaseStatus(tx: Tx, caseId: string, record: Record_): Promise<string> {
  const caseRow = (await tx.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) }))!;
  const impacts = await tx.select({ impact: claimImpact, material: claim.material }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(eq(claimImpact.caseId, caseId));
  const openChallenges = await tx.$count(challenge, and(eq(challenge.caseId, caseId), eq(challenge.status, "OPEN")));
  const amendments = await tx.$count(caseSource, and(eq(caseSource.caseId, caseId), eq(caseSource.relation, "amendment")));
  const material = impacts.filter((i) => i.material && i.impact.classification !== "candidate");
  const affectedReportIds = [...new Set(material.map((i) => i.impact.reportId))];
  const reissued = affectedReportIds.length
    ? await tx.$count(researchRevision, and(eq(researchRevision.caseId, caseId), eq(researchRevision.documentState, "PUBLISHED"), inArray(researchRevision.reportId, affectedReportIds)))
    : 0;
  const readyCandidates = await tx.$count(researchRevision, and(eq(researchRevision.caseId, caseId), inArray(researchRevision.candidateState, ["READY", "APPROVED"])));
  const withdrawn = affectedReportIds.length ? await tx.$count(researchReport, and(inArray(researchReport.id, affectedReportIds), eq(researchReport.documentState, "WITHDRAWN"))) : 0;

  let status: typeof caseRow.status;
  if (!caseRow.scopeConfirmed) status = openChallenges ? "NEEDS_REVIEW" : "INVESTIGATING";
  else if (!affectedReportIds.length && !impacts.some((i) => i.impact.state === "UNDER_REVIEW")) status = "NOT_APPLICABLE";
  else if (openChallenges || material.some((i) => i.impact.state === "REJECTED" || i.impact.state === "UNRESOLVED")) status = "NEEDS_REVIEW";
  else if (!amendments) status = "AWAITING_EVIDENCE";
  else if (reissued + withdrawn >= affectedReportIds.length && affectedReportIds.length > 0) status = "RESOLVED";
  else if (reissued + withdrawn > 0) status = "PARTIALLY_REISSUED";
  else if (readyCandidates > 0) status = "READY_FOR_APPROVAL";
  else status = "VERIFYING";

  if (status !== caseRow.status) {
    await tx.update(correctionCase).set({ status, lastUpdatedAt: new Date(), rowVersion: caseRow.rowVersion + 1 }).where(eq(correctionCase.id, caseId));
    await record({ workspaceId: caseRow.workspaceId, type: "case.status_changed", actor: { kind: "system", id: "case-engine" }, caseId, evidenceEpoch: caseRow.evidenceEpoch, payload: { from: caseRow.status, to: status } });
  }
  return status;
}
