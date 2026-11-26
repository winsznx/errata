import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentRun,
  artifactExport,
  caseSource,
  challenge,
  claim,
  claimBinding,
  claimImpact,
  correctionCase,
  correctionNotice,
  delivery,
  disclosureEvent,
  domainEvent,
  editorialReview,
  financialFact,
  issuer,
  publicationRecipient,
  publicationStatusEvent,
  replacementProposal,
  reportWarning,
  researchReport,
  researchRevision,
  runtimeSession,
  sourceDocument,
  sourceLocator,
  syntheticRecipient,
  toolCall,
  verificationAttestation,
  watchSubscription,
  workspace,
  workspaceSource,
} from "../db/schema.js";
import { eligibleSource, eligibleSources } from "../domain/eligibility.js";
import { DomainError, assert } from "../domain/errors.js";
import { serializeEvent } from "../domain/events.js";
import { evaluateCandidate } from "../domain/publication.js";
import { loadScenario } from "../domain/scenarios.js";
import { readExcerpt } from "../domain/reads.js";

export function pageArgs(query: { cursor?: string; limit?: string }) {
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25) || 25));
  const cursor = query.cursor ? new Date(Buffer.from(query.cursor, "base64url").toString()) : null;
  return { limit, cursor: cursor && !Number.isNaN(cursor.getTime()) ? cursor : null };
}

export function nextCursor<T>(rows: T[], limit: number, at: (row: T) => Date): string | null {
  if (rows.length < limit) return null;
  return Buffer.from(at(rows[rows.length - 1]!).toISOString()).toString("base64url");
}

export async function workspaceOverview(workspaceId: string) {
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
  assert(ws, "NOT_FOUND", "workspace not found");
  const scenario = ws.scenarioId ? await loadScenario(ws.scenarioId) : null;
  const [cases, reports, warnings, pendingApprovals, watch, lastEvents, runs, session] = await Promise.all([
    db.select().from(correctionCase).where(eq(correctionCase.workspaceId, workspaceId)).orderBy(desc(correctionCase.lastUpdatedAt)),
    db.select().from(researchReport).where(eq(researchReport.workspaceId, workspaceId)).orderBy(desc(researchReport.updatedAt)),
    db.select({ n: count() }).from(reportWarning).where(and(eq(reportWarning.workspaceId, workspaceId), eq(reportWarning.state, "ACTIVE"))),
    db.select({ n: count() }).from(researchRevision).where(and(eq(researchRevision.workspaceId, workspaceId), inArray(researchRevision.candidateState, ["READY", "APPROVED"]))),
    db.select({ sub: watchSubscription, name: issuer.legalName }).from(watchSubscription).innerJoin(issuer, eq(issuer.cik, watchSubscription.cik)).where(eq(watchSubscription.workspaceId, workspaceId)),
    db.select().from(domainEvent).where(eq(domainEvent.workspaceId, workspaceId)).orderBy(desc(domainEvent.seq)).limit(12),
    db.select().from(agentRun).where(and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.status, "STARTED"))),
    db.query.runtimeSession.findFirst({ where: and(eq(runtimeSession.workspaceId, workspaceId), eq(runtimeSession.status, "ACTIVE")) }),
  ]);
  return {
    workspace: { id: ws.id, slug: ws.slug, name: ws.name, mode: ws.mode, logicalTime: ws.logicalTime?.toISOString() ?? null, isReference: ws.isReference, expiresAt: ws.expiresAt?.toISOString() ?? null, eventSeq: ws.eventSeq.toString() },
    scenario: scenario ? { id: scenario.id, label: scenario.label, description: scenario.description, position: ws.replayPosition, total: scenario.events.length, next: scenario.events[ws.replayPosition] ? { label: scenario.events[ws.replayPosition]!.label } : null, faults: scenario.faults.map((f) => ({ type: f.type, label: f.label })) } : null,
    counts: {
      activeCases: cases.filter((c) => !["RESOLVED", "NOT_APPLICABLE"].includes(c.status)).length,
      reportsAtRisk: reports.filter((r) => r.reliability === "NON_RELIANCE" || r.reliability === "UNDER_REVIEW").length,
      activeWarnings: warnings[0]?.n ?? 0,
      pendingApprovals: pendingApprovals[0]?.n ?? 0,
      runningAgents: runs.length,
      publishedReports: reports.filter((r) => r.documentState === "PUBLISHED").length,
    },
    cases: cases.slice(0, 6).map(caseRowView),
    reports: reports.slice(0, 8).map(reportRowView),
    watchlist: watch.map(({ sub, name }) => ({ cik: sub.cik, name, active: sub.active, lastCheckedAt: sub.lastCheckedAt?.toISOString() ?? null, lastSuccessAt: sub.lastSuccessAt?.toISOString() ?? null, lastError: sub.lastError })),
    recentEvents: lastEvents.map(serializeEvent),
    runtime: session ? { sessionId: session.id, sdkVersion: session.sdkVersion, model: session.model, heartbeatAt: session.heartbeatAt.toISOString(), status: session.status } : null,
  };
}

function caseRowView(c: typeof correctionCase.$inferSelect) {
  return { id: c.id, title: c.title, issuerCik: c.issuerCik, status: c.status, evidenceEpoch: c.evidenceEpoch, scopeConfirmed: c.scopeConfirmed, periods: c.scope?.periods ?? [], openedAt: c.openedAt.toISOString(), lastUpdatedAt: c.lastUpdatedAt.toISOString() };
}

function reportRowView(r: typeof researchReport.$inferSelect) {
  return { id: r.id, publicId: r.publicId, title: r.title, issuerCiks: r.issuerCiks, documentState: r.documentState, reliability: r.reliability, synthetic: r.synthetic, publisherName: r.publisherName, updatedAt: r.updatedAt.toISOString() };
}

export async function listReports(workspaceId: string, query: { q?: string; status?: string; cursor?: string; limit?: string }) {
  const { limit, cursor } = pageArgs(query);
  const filters = [eq(researchReport.workspaceId, workspaceId)];
  if (query.q) filters.push(ilike(researchReport.title, `%${query.q.replace(/[%_]/g, "")}%`));
  if (query.status === "affected") filters.push(inArray(researchReport.reliability, ["NON_RELIANCE", "UNDER_REVIEW"]));
  else if (query.status === "superseded") filters.push(sql`exists (select 1 from research_revision r where r.report_id = ${researchReport.id} and r.document_state = 'SUPERSEDED')`);
  else if (query.status === "draft") filters.push(eq(researchReport.documentState, "DRAFT"));
  else if (query.status === "published") filters.push(eq(researchReport.documentState, "PUBLISHED"));
  else if (query.status === "review") filters.push(sql`exists (select 1 from research_revision r where r.report_id = ${researchReport.id} and r.candidate_state in ('READY','APPROVED','BLOCKED','CHECKING'))`);
  if (cursor) filters.push(lt(researchReport.updatedAt, cursor));
  const rows = await db.select().from(researchReport).where(and(...filters)).orderBy(desc(researchReport.updatedAt)).limit(limit);
  return { items: rows.map(reportRowView), nextCursor: nextCursor(rows, limit, (r) => r.updatedAt) };
}

export async function revisionView(workspaceId: string | null, revisionId: string, options: { includeInternal: boolean }) {
  const revision = await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, revisionId) });
  assert(revision && (!workspaceId || revision.workspaceId === workspaceId), "NOT_FOUND", "revision not found");
  const claims = await db.select().from(claim).where(eq(claim.revisionId, revisionId)).orderBy(asc(claim.blockId), asc(claim.startOffset));
  const bindings = claims.length ? await db.select({ binding: claimBinding, fact: financialFact, source: sourceDocument }).from(claimBinding).leftJoin(financialFact, eq(financialFact.id, claimBinding.factId)).leftJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId)).where(inArray(claimBinding.claimId, claims.map((c) => c.id))) : [];
  const warnings = await db.select().from(reportWarning).where(and(eq(reportWarning.revisionId, revisionId), eq(reportWarning.state, "ACTIVE")));
  const sources = revision.sourceRefs.length ? await db.select().from(sourceDocument).where(inArray(sourceDocument.id, revision.sourceRefs)) : [];
  return {
    id: revision.id,
    reportId: revision.reportId,
    version: revision.version,
    kind: revision.kind,
    documentState: revision.documentState,
    candidateState: revision.candidateState,
    asOf: revision.asOf.toISOString(),
    publishedAt: revision.publishedAt?.toISOString() ?? null,
    publicationLabel: revision.publicationLabel,
    contentHash: revision.contentHash,
    blocks: revision.blocks,
    warnings: warnings.map((w) => ({ id: w.id, type: w.type, severity: w.severity, headline: w.headline, detail: w.detail, caseId: options.includeInternal ? w.caseId : undefined, appliedAt: w.appliedAt.toISOString() })),
    sources: sources.map((s) => ({ id: s.id, accession: s.accession, form: s.form, filedDate: s.filedDate, url: s.url })),
    claims: claims.map((c) => ({
      id: c.id,
      blockId: c.blockId,
      start: c.startOffset,
      end: c.endOffset,
      category: c.category,
      label: c.label,
      text: c.text,
      material: c.material,
      bindingState: options.includeInternal ? c.bindingState : undefined,
      creationMethod: options.includeInternal ? c.creationMethod : undefined,
      value: c.valueDecimal,
      sources: bindings
        .filter((b) => b.binding.claimId === c.id && b.source)
        .map((b) => ({ accession: b.source!.accession, form: b.source!.form, url: b.source!.url, concept: b.fact!.conceptId, periodEnd: b.fact!.periodEnd, column: b.fact!.sourceColumn, printed: b.fact!.rawText, locatorId: b.fact!.locatorId })),
      derivedFrom: bindings.filter((b) => b.binding.claimId === c.id && b.binding.refClaimId).map((b) => ({ claimId: b.binding.refClaimId, kind: b.binding.kind })),
      formula: c.formula,
    })),
    ...(options.includeInternal ? { epochVector: revision.epochVector, notice: revision.noticeDraft, baseRevisionId: revision.baseRevisionId, caseId: revision.caseId, createdBy: revision.createdBy } : {}),
  };
}

export async function reportDetail(workspaceId: string, reportId: string) {
  const report = await db.query.researchReport.findFirst({ where: and(eq(researchReport.id, reportId), eq(researchReport.workspaceId, workspaceId)) });
  assert(report, "NOT_FOUND", "report not found");
  const revisions = await db.select().from(researchRevision).where(eq(researchRevision.reportId, reportId)).orderBy(desc(researchRevision.createdAt));
  const history = await db.select().from(publicationStatusEvent).where(eq(publicationStatusEvent.reportId, reportId)).orderBy(desc(publicationStatusEvent.occurredAt));
  const notices = await db.select().from(correctionNotice).where(eq(correctionNotice.reportId, reportId)).orderBy(desc(correctionNotice.publishedAt));
  const cases = await db
    .selectDistinct({ id: correctionCase.id, title: correctionCase.title, status: correctionCase.status })
    .from(claimImpact)
    .innerJoin(correctionCase, eq(correctionCase.id, claimImpact.caseId))
    .where(eq(claimImpact.reportId, reportId));
  const current = report.currentRevisionId ? await revisionView(workspaceId, report.currentRevisionId, { includeInternal: true }) : null;
  return {
    report: reportRowView(report),
    current,
    versions: revisions.map((r) => ({ id: r.id, version: r.version, kind: r.kind, documentState: r.documentState, candidateState: r.candidateState, createdAt: r.createdAt.toISOString(), publishedAt: r.publishedAt?.toISOString() ?? null, createdBy: r.createdBy })),
    history: history.map((h) => ({ type: h.type, reason: h.reason, actor: h.actor, revisionId: h.revisionId, at: h.occurredAt.toISOString() })),
    notices: notices.map((n) => ({ id: n.id, type: n.type, publishedAt: n.publishedAt.toISOString(), replacementRevisionId: n.replacementRevisionId })),
    cases,
  };
}

export async function listCases(workspaceId: string, query: { status?: string; cursor?: string; limit?: string; q?: string }) {
  const { limit, cursor } = pageArgs(query);
  const filters = [eq(correctionCase.workspaceId, workspaceId)];
  if (query.status && query.status !== "all") filters.push(eq(correctionCase.status, query.status as typeof correctionCase.$inferSelect.status));
  if (query.q) filters.push(ilike(correctionCase.title, `%${query.q.replace(/[%_]/g, "")}%`));
  if (cursor) filters.push(lt(correctionCase.lastUpdatedAt, cursor));
  const rows = await db.select().from(correctionCase).where(and(...filters)).orderBy(desc(correctionCase.lastUpdatedAt)).limit(limit);
  const counts = rows.length
    ? await db.select({ caseId: claimImpact.caseId, n: count(), reports: sql<number>`count(distinct ${claimImpact.reportId})` }).from(claimImpact).where(inArray(claimImpact.caseId, rows.map((r) => r.id))).groupBy(claimImpact.caseId)
    : [];
  const challenges = rows.length ? await db.select({ caseId: challenge.caseId, n: count() }).from(challenge).where(and(inArray(challenge.caseId, rows.map((r) => r.id)), eq(challenge.status, "OPEN"))).groupBy(challenge.caseId) : [];
  return {
    items: rows.map((r) => ({ ...caseRowView(r), affectedClaims: counts.find((c) => c.caseId === r.id)?.n ?? 0, affectedReports: Number(counts.find((c) => c.caseId === r.id)?.reports ?? 0), openChallenges: challenges.find((c) => c.caseId === r.id)?.n ?? 0 })),
    nextCursor: nextCursor(rows, limit, (r) => r.lastUpdatedAt),
  };
}

export async function caseDetail(workspaceId: string, caseId: string) {
  const c = await db.query.correctionCase.findFirst({ where: and(eq(correctionCase.id, caseId), eq(correctionCase.workspaceId, workspaceId)) });
  assert(c, "NOT_FOUND", "case not found");
  const [origin] = await db.select({ disclosure: disclosureEvent, source: sourceDocument }).from(disclosureEvent).innerJoin(sourceDocument, eq(sourceDocument.id, disclosureEvent.sourceId)).where(eq(disclosureEvent.id, c.originEventId));
  const linked = await db.select({ link: caseSource, source: sourceDocument }).from(caseSource).innerJoin(sourceDocument, eq(sourceDocument.id, caseSource.sourceId)).where(eq(caseSource.caseId, caseId));
  const impacts = await db
    .select({ impact: claimImpact, claim, reportTitle: researchReport.title, publicId: researchReport.publicId })
    .from(claimImpact)
    .innerJoin(claim, eq(claim.id, claimImpact.claimId))
    .innerJoin(researchReport, eq(researchReport.id, claimImpact.reportId))
    .where(eq(claimImpact.caseId, caseId))
    .orderBy(asc(researchReport.title), asc(claim.blockId), asc(claim.startOffset));
  const proposals = await db.select().from(replacementProposal).where(eq(replacementProposal.caseId, caseId)).orderBy(desc(replacementProposal.createdAt));
  const attestations = proposals.length ? await db.select().from(verificationAttestation).where(inArray(verificationAttestation.proposalId, proposals.map((p) => p.id))).orderBy(desc(verificationAttestation.createdAt)) : [];
  const challenges = await db.select().from(challenge).where(eq(challenge.caseId, caseId)).orderBy(desc(challenge.createdAt));
  const candidates = await db.select().from(researchRevision).where(and(eq(researchRevision.caseId, caseId), eq(researchRevision.kind, "candidate"))).orderBy(desc(researchRevision.createdAt));
  const reissued = await db.select().from(researchRevision).where(and(eq(researchRevision.caseId, caseId), eq(researchRevision.documentState, "PUBLISHED")));
  const runs = await db.select().from(agentRun).where(eq(agentRun.caseId, caseId)).orderBy(desc(agentRun.startedAt)).limit(60);
  const events = await db.select().from(domainEvent).where(eq(domainEvent.caseId, caseId)).orderBy(asc(domainEvent.seq));
  const proposalFacts = [...new Set(proposals.flatMap((p) => p.factIds))];
  const facts = proposalFacts.length ? await db.select({ fact: financialFact, source: sourceDocument }).from(financialFact).innerJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId)).where(inArray(financialFact.id, proposalFacts)) : [];
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });

  return {
    case: caseRowView(c),
    logicalTime: ws?.logicalTime?.toISOString() ?? null,
    origin: origin ? { disclosureEventId: origin.disclosure.id, status: origin.disclosure.status, proposedBy: origin.disclosure.proposedBy, confirmedBy: origin.disclosure.confirmedBy, source: { id: origin.source.id, accession: origin.source.accession, form: origin.source.form, filedDate: origin.source.filedDate, acceptedAt: origin.source.acceptedAt?.toISOString() ?? null, url: origin.source.url }, locatorIds: origin.disclosure.evidenceLocatorIds } : null,
    linkedSources: linked.map((l) => ({ relation: l.link.relation, epoch: l.link.evidenceEpoch, linkedBy: l.link.linkedBy, source: { id: l.source.id, accession: l.source.accession, form: l.source.form, filedDate: l.source.filedDate, acceptedAt: l.source.acceptedAt?.toISOString() ?? null, url: l.source.url } })),
    impacts: impacts.map(({ impact, claim: cl, reportTitle, publicId }) => {
      const latest = proposals.find((p) => p.claimId === cl.id && p.epoch === c.evidenceEpoch);
      const fact = latest ? facts.find((f) => latest.factIds.includes(f.fact.id)) : undefined;
      return {
        impactId: impact.id,
        claimId: cl.id,
        reportId: impact.reportId,
        reportTitle,
        publicId,
        label: cl.label,
        category: cl.category,
        classification: impact.classification,
        material: cl.material,
        state: impact.state,
        reason: impact.reason,
        path: impact.path,
        original: { text: cl.text, value: cl.valueDecimal, unit: cl.displayUnit, precision: cl.displayPrecision },
        replacement: latest ? { proposalId: latest.id, kind: latest.kind, status: latest.status, value: latest.status === "VERIFIED" ? latest.value : null, proposedValue: latest.value, proposer: latest.proposerAgent, source: fact ? { accession: fact.source.accession, form: fact.source.form, url: fact.source.url, column: fact.fact.sourceColumn, printed: fact.fact.rawText, label: fact.fact.label, locatorId: fact.fact.locatorId } : null } : null,
      };
    }),
    proposals: proposals.map((p) => ({ id: p.id, claimId: p.claimId, epoch: p.epoch, kind: p.kind, value: p.value, status: p.status, statusReason: p.statusReason, proposer: p.proposerAgent, agentRunId: p.agentRunId, rationale: p.rationale, createdAt: p.createdAt.toISOString() })),
    attestations: attestations.map((a) => ({ id: a.id, proposalId: a.proposalId, epoch: a.epoch, verifier: a.verifierAgent, agentRunId: a.agentRunId, verdict: a.verdict, valid: a.valid, independentValue: a.independentValue, checks: a.deterministicChecks, rationale: a.rationale, sourceHashes: a.sourceHashes, createdAt: a.createdAt.toISOString() })),
    challenges: challenges.map((ch) => ({ id: ch.id, targetKind: ch.targetKind, targetId: ch.targetId, epoch: ch.epoch, raisedBy: ch.raisedBy, reasonCode: ch.reasonCode, explanation: ch.explanation, status: ch.status, resolution: ch.resolution, createdAt: ch.createdAt.toISOString() })),
    candidates: candidates.map((r) => ({ id: r.id, reportId: r.reportId, state: r.candidateState, contentHash: r.contentHash, epochVector: r.epochVector, createdAt: r.createdAt.toISOString(), blockers: ((r.noticeDraft as { blockers?: string[] } | null)?.blockers ?? []) })),
    reissued: reissued.map((r) => ({ id: r.id, reportId: r.reportId, version: r.version, publishedAt: r.publishedAt?.toISOString() ?? null })),
    agentRuns: runs.map(agentRunView),
    timeline: events.map(serializeEvent),
  };
}

export function agentRunView(r: typeof agentRun.$inferSelect) {
  return { id: r.id, role: r.role, taskKey: r.taskKey, trigger: (() => { try { return (JSON.parse(r.trigger) as { event?: string; kind?: string }); } catch { return { event: r.trigger }; } })(), status: r.status, outcome: r.outcome, summary: r.summary, attempt: r.attempt, epoch: r.epoch, caseId: r.caseId, nativeAgentId: r.nativeAgentId, nativeLoopId: r.nativeLoopId, cloudSessionUrl: r.cloudSessionUrl, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, errorCode: r.errorCode, errorMessage: r.errorMessage, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null, heartbeatAt: r.heartbeatAt.toISOString() };
}

export async function candidateView(workspaceId: string, candidateId: string) {
  const candidate = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, candidateId), eq(researchRevision.workspaceId, workspaceId)) });
  assert(candidate && candidate.kind !== "published" || candidate?.candidateState === "PUBLISHED", "NOT_FOUND", "draft not found");
  const view = await revisionView(workspaceId, candidateId, { includeInternal: true });
  const base = candidate!.baseRevisionId ? await revisionView(workspaceId, candidate!.baseRevisionId, { includeInternal: true }) : null;
  const { blockers, epochVector } = candidate!.candidateState === "PUBLISHED" ? { blockers: [], epochVector: candidate!.epochVector } : await evaluateCandidate(db, candidateId);
  const reviews = await db.select().from(editorialReview).where(eq(editorialReview.candidateId, candidateId)).orderBy(desc(editorialReview.createdAt));
  const report = await db.query.researchReport.findFirst({ where: eq(researchReport.id, candidate!.reportId) });
  return { candidate: view, base, liveBlockers: blockers, currentEpochVector: epochVector, reviews: reviews.map((r) => ({ id: r.id, decision: r.decision, actorName: r.actorName, notes: r.notes, valid: r.valid, contentHash: r.contentHash, createdAt: r.createdAt.toISOString() })), report: report ? reportRowView(report) : null };
}

export async function listSources(workspaceId: string, query: { cik?: string; form?: string; cursor?: string; limit?: string }) {
  const sources = await eligibleSources(db, workspaceId);
  const filtered = sources.filter((s) => (!query.cik || s.cik === query.cik) && (!query.form || s.form === query.form)).sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
  const { limit, cursor } = pageArgs(query);
  const page = filtered.filter((s) => !cursor || s.availableAt < cursor).slice(0, limit);
  const factCounts = page.length ? await db.select({ sourceId: financialFact.sourceId, n: count() }).from(financialFact).where(inArray(financialFact.sourceId, page.map((s) => s.id))).groupBy(financialFact.sourceId) : [];
  const issuers = await db.select().from(issuer);
  const pending = await db.select({ n: count() }).from(workspaceSource).where(and(eq(workspaceSource.workspaceId, workspaceId), eq(workspaceSource.eligible, false)));
  return {
    items: page.map((s) => ({ id: s.id, cik: s.cik, issuer: issuers.find((i) => i.cik === s.cik)?.legalName ?? s.cik, accession: s.accession, form: s.form, filedDate: s.filedDate, acceptedAt: s.acceptedAt?.toISOString() ?? null, availableAt: s.availableAt.toISOString(), url: s.url, sha256: s.sha256, bytes: s.bytes, retrievalMode: s.retrievalMode, facts: factCounts.find((f) => f.sourceId === s.id)?.n ?? 0 })),
    nextCursor: nextCursor(page, limit, (s) => s.availableAt),
    notYetPublic: pending[0]?.n ?? 0,
  };
}

export async function sourceDetail(workspaceId: string, sourceId: string, query: { column?: string; q?: string }) {
  const source = await eligibleSource(db, workspaceId, sourceId);
  const filters = [eq(financialFact.sourceId, source.id), isNotNull(financialFact.value)];
  if (query.column) filters.push(eq(financialFact.sourceColumn, query.column as typeof financialFact.$inferSelect.sourceColumn));
  if (query.q) filters.push(or(ilike(financialFact.label, `%${query.q.replace(/[%_]/g, "")}%`), ilike(financialFact.conceptId, `%${query.q.replace(/[%_]/g, "")}%`))!);
  const facts = await db.select({ fact: financialFact, kind: sourceLocator.kind }).from(financialFact).innerJoin(sourceLocator, eq(sourceLocator.id, financialFact.locatorId)).where(and(...filters)).orderBy(desc(financialFact.periodEnd), asc(financialFact.label)).limit(200);
  const textSections = await db.select().from(sourceLocator).where(and(eq(sourceLocator.sourceId, source.id), eq(sourceLocator.kind, "text"))).limit(60);
  const usedBy = await db.select({ n: count() }).from(claimBinding).innerJoin(financialFact, eq(financialFact.id, claimBinding.factId)).where(and(eq(financialFact.sourceId, source.id), eq(claimBinding.workspaceId, workspaceId)));
  return {
    source: { id: source.id, cik: source.cik, accession: source.accession, form: source.form, filedDate: source.filedDate, reportDate: source.reportDate, acceptedAt: source.acceptedAt?.toISOString() ?? null, availabilityPrecision: source.availabilityPrecision, url: source.url, sha256: source.sha256, bytes: source.bytes, retrievedAt: source.retrievedAt.toISOString(), retrievalMode: source.retrievalMode, parseVersion: source.parseVersion, conflict: source.conflict },
    facts: facts.map(({ fact, kind }) => ({ id: fact.id, label: fact.label, concept: fact.conceptId, periodType: fact.periodType, periodStart: fact.periodStart, periodEnd: fact.periodEnd, column: fact.sourceColumn, printed: fact.rawText, value: fact.value, unit: fact.unit, scale: fact.scale, dimensions: fact.dimensions, extraction: fact.extractionMethod, locatorId: fact.locatorId, locatorKind: kind })),
    textSections: textSections.map((t) => ({ locatorId: t.id, path: t.path, excerpt: t.excerpt })),
    claimsCiting: usedBy[0]?.n ?? 0,
  };
}

export async function excerptView(workspaceId: string, locatorId: string) {
  return readExcerpt(workspaceId, locatorId);
}

export async function publicationsView(workspaceId: string) {
  const reports = await db.select().from(researchReport).where(eq(researchReport.workspaceId, workspaceId)).orderBy(desc(researchReport.updatedAt));
  const versions = reports.length ? await db.select({ reportId: researchRevision.reportId, n: count() }).from(researchRevision).where(and(inArray(researchRevision.reportId, reports.map((r) => r.id)), isNotNull(researchRevision.version))).groupBy(researchRevision.reportId) : [];
  const deliveries = await db.select({ status: delivery.status, n: count(), revisionId: delivery.revisionId }).from(delivery).where(eq(delivery.workspaceId, workspaceId)).groupBy(delivery.status, delivery.revisionId);
  const current = reports.map((r) => r.currentRevisionId).filter((x): x is string => Boolean(x));
  const currentRevisions = current.length ? await db.select().from(researchRevision).where(inArray(researchRevision.id, current)) : [];
  return reports.map((r) => {
    const rev = currentRevisions.find((c) => c.id === r.currentRevisionId);
    return { ...reportRowView(r), currentVersion: rev?.version ?? null, publishedAt: rev?.publishedAt?.toISOString() ?? null, versions: versions.find((v) => v.reportId === r.id)?.n ?? 0, deliveries: deliveries.filter((d) => d.revisionId === r.currentRevisionId).map((d) => ({ status: d.status, n: d.n })) };
  });
}

export async function distributionView(workspaceId: string) {
  const recipients = await db.select().from(syntheticRecipient).where(eq(syntheticRecipient.workspaceId, workspaceId));
  const rows = await db.select({ delivery, recipient: syntheticRecipient }).from(delivery).innerJoin(syntheticRecipient, eq(syntheticRecipient.id, delivery.recipientId)).where(eq(delivery.workspaceId, workspaceId)).orderBy(desc(delivery.createdAt));
  const subscriptions = await db.select({ pr: publicationRecipient, title: researchReport.title }).from(publicationRecipient).innerJoin(researchReport, eq(researchReport.id, publicationRecipient.reportId)).where(eq(researchReport.workspaceId, workspaceId));
  return {
    recipients: recipients.map((r) => ({ id: r.id, displayName: r.displayName, organisation: r.organisation, address: r.address, subscriptions: subscriptions.filter((s) => s.pr.recipientId === r.id).map((s) => s.title) })),
    deliveries: rows.map(({ delivery: d, recipient }) => ({ id: d.id, kind: d.kind, subject: d.subject, status: d.status, attempts: d.attemptCount, deliveredAt: d.deliveredAt?.toISOString() ?? null, lastError: d.lastError, recipient: recipient.displayName, recipientId: recipient.id, noticeId: d.noticeId, revisionId: d.revisionId, createdAt: d.createdAt.toISOString() })),
  };
}

export async function runtimeView(workspaceId: string) {
  const sessions = await db.select().from(runtimeSession).where(eq(runtimeSession.workspaceId, workspaceId)).orderBy(desc(runtimeSession.startedAt)).limit(5);
  const runs = await db.select().from(agentRun).where(eq(agentRun.workspaceId, workspaceId)).orderBy(desc(agentRun.startedAt)).limit(200);
  const finished = runs.filter((r) => r.endedAt);
  let overlapPairs = 0;
  let overlapMs = 0;
  const intervals = runs.map((r) => ({ id: r.id, role: r.role, start: r.startedAt.getTime(), end: (r.endedAt ?? new Date()).getTime() }));
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      if (overlap > 0) {
        overlapPairs += 1;
        overlapMs += overlap;
      }
    }
  }
  const challenges = await db.select({ n: count() }).from(challenge).where(eq(challenge.workspaceId, workspaceId));
  const staleRejections = await db.select({ n: count() }).from(domainEvent).where(and(eq(domainEvent.workspaceId, workspaceId), inArray(domainEvent.type, ["agent.stale_result_rejected", "agent.stale"])));
  return {
    sessions: sessions.map((s) => ({ id: s.id, sdkVersion: s.sdkVersion, model: s.model, status: s.status, startedAt: s.startedAt.toISOString(), heartbeatAt: s.heartbeatAt.toISOString(), leaseFence: s.leaseFence })),
    runs: runs.map(agentRunView),
    metrics: {
      runs: runs.length,
      completed: finished.filter((r) => r.status === "COMPLETED").length,
      failed: runs.filter((r) => ["FAILED", "TIMED_OUT"].includes(r.status)).length,
      stale: runs.filter((r) => r.status === "STALE").length,
      overlappingRunPairs: overlapPairs,
      overlapSeconds: Math.round(overlapMs / 100) / 10,
      challenges: challenges[0]?.n ?? 0,
      staleRejections: staleRejections[0]?.n ?? 0,
      inputTokens: runs.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: runs.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    },
  };
}

export async function traceView(workspaceId: string, query: { after?: string; limit?: string; type?: string }) {
  const limit = Math.min(500, Math.max(1, Number(query.limit ?? 200) || 200));
  const filters = [eq(domainEvent.workspaceId, workspaceId)];
  if (query.after && /^\d+$/.test(query.after)) filters.push(gt(domainEvent.seq, BigInt(query.after)));
  if (query.type) filters.push(ilike(domainEvent.type, `${query.type.replace(/[%_]/g, "")}%`));
  const events = await db.select().from(domainEvent).where(and(...filters)).orderBy(asc(domainEvent.seq)).limit(limit);
  return { events: events.map(serializeEvent), next: events.length === limit ? events[events.length - 1]!.seq.toString() : null };
}

export async function traceExport(workspaceId: string) {
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
  const events = await db.select().from(domainEvent).where(eq(domainEvent.workspaceId, workspaceId)).orderBy(asc(domainEvent.seq));
  const runs = await db.select().from(agentRun).where(eq(agentRun.workspaceId, workspaceId)).orderBy(asc(agentRun.startedAt));
  const calls = runs.length ? await db.select().from(toolCall).where(inArray(toolCall.agentRunId, runs.map((r) => r.id))).orderBy(asc(toolCall.startedAt)) : [];
  const runtime = await runtimeView(workspaceId);
  return {
    exportedAt: new Date().toISOString(),
    note: "Errata trace export. Native Mozaik loop ids and Mozaik Cloud session links come from the SDK; tool calls and domain events are recorded by the Errata adapter. No model reasoning or secrets are included.",
    workspace: { id: ws?.id, scenarioId: ws?.scenarioId, logicalTime: ws?.logicalTime?.toISOString() ?? null },
    metrics: runtime.metrics,
    sessions: runtime.sessions,
    agentRuns: runs.map((r) => ({ ...agentRunView(r), toolCalls: calls.filter((c) => c.agentRunId === r.id).map((c) => ({ tool: c.toolName, ok: c.ok, errorCode: c.errorCode, refs: c.sourceRefs, input: c.inputSummary, startedAt: c.startedAt.toISOString(), endedAt: c.endedAt.toISOString() })) })),
    events: events.map(serializeEvent),
  };
}

export async function noticeView(workspaceId: string | null, noticeId: string) {
  const notice = await db.query.correctionNotice.findFirst({ where: eq(correctionNotice.id, noticeId) });
  assert(notice && (!workspaceId || notice.workspaceId === workspaceId), "NOT_FOUND", "notice not found");
  const report = await db.query.researchReport.findFirst({ where: eq(researchReport.id, notice.reportId) });
  const prev = await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, notice.previousRevisionId) });
  const next = notice.replacementRevisionId ? await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, notice.replacementRevisionId) }) : null;
  const exports = await db.select().from(artifactExport).where(and(eq(artifactExport.noticeId, noticeId), eq(artifactExport.status, "READY")));
  return { id: notice.id, type: notice.type, publishedAt: notice.publishedAt.toISOString(), contentHash: notice.contentHash, body: notice.body, report: report ? { publicId: report.publicId, title: report.title, publisherName: report.publisherName } : null, previousVersion: prev?.version ?? null, replacementVersion: next?.version ?? null, exports: exports.map((e) => ({ format: e.format, id: e.id, filename: e.filename })) };
}

export async function watchlistView(workspaceId: string) {
  const rows = await db.select({ sub: watchSubscription, name: issuer.legalName }).from(watchSubscription).innerJoin(issuer, eq(issuer.cik, watchSubscription.cik)).where(eq(watchSubscription.workspaceId, workspaceId));
  return rows.map(({ sub, name }) => ({ cik: sub.cik, name, active: sub.active, forms: sub.forms, intervalSeconds: sub.intervalSeconds, lastCheckedAt: sub.lastCheckedAt?.toISOString() ?? null, lastSuccessAt: sub.lastSuccessAt?.toISOString() ?? null, lastError: sub.lastError }));
}

export function notFound(message: string): never {
  throw new DomainError("NOT_FOUND", message);
}
