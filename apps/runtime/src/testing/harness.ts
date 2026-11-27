import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { claim, claimImpact, financialFact, researchReport, researchRevision, sourceDocument, sourceLocator, toolCall, agentRun, runtimeSession } from "../db/schema.js";
import { advanceReplay, checkDisclosureScope, linkAmendment, proposeDisclosureScope, type ActorContext } from "../domain/cases.js";
import { findFactCandidates, proposeReplacement, submitVerification } from "../domain/claims-work.js";
import { proposeRevisionPatch, reviewConclusions } from "../domain/publication.js";
import { createScenarioWorkspace } from "../domain/workspace.js";

/**
 * Test harness for browser tests only. It walks the Nocera scenario to a ready correction draft through the same
 * domain guards the agents use, with every action attributed to a "test-harness" actor so it can never be mistaken
 * for agent output. Disabled unless ENABLE_TEST_HARNESS=true and refused in production.
 */
export async function prepareReadyNoceraWorkspace(): Promise<{ workspaceId: string; slug: string; caseId: string; candidateId: string; reportId: string }> {
  const { workspaceId, slug } = await createScenarioWorkspace("nocera-q1-repair");
  const as = (role: string, epoch?: number, agentRunId?: string): ActorContext => ({ workspaceId, actor: { kind: "agent", id: `test-harness:${role}` }, epoch: epoch ?? null, agentRunId: agentRunId ?? null });
  const operator = { kind: "human" as const, id: "operator:test-harness" };

  await advanceReplay(workspaceId, 0, operator);
  const [notice] = await db.select().from(sourceDocument).where(eq(sourceDocument.accession, "0001683168-26-006537"));
  const [scopeLocator] = (await db.select().from(sourceLocator).where(and(eq(sourceLocator.sourceId, notice!.id), eq(sourceLocator.kind, "text")))).filter((l) => l.excerpt.includes("should no longer be relied upon"));
  const periods = [
    { start: "2024-01-01", end: "2024-12-31", type: "duration" as const, label: "Fiscal year 2024" },
    { start: "2025-01-01", end: "2025-12-31", type: "duration" as const, label: "Fiscal year 2025" },
    { start: "2025-01-01", end: "2025-03-31", type: "duration" as const, label: "Quarter ended March 31, 2025" },
    { start: "2025-04-01", end: "2025-06-30", type: "duration" as const, label: "Quarter ended June 30, 2025" },
    { start: "2025-07-01", end: "2025-09-30", type: "duration" as const, label: "Quarter ended September 30, 2025" },
  ];
  const proposed = await proposeDisclosureScope(as("filing-monitor"), { sourceId: notice!.id, classification: "NON_RELIANCE", periods, locatorIds: [scopeLocator!.id], summary: "Test harness: Item 4.02 scope" });
  const caseId = proposed.result.caseId!;
  await checkDisclosureScope(as("financial-verifier"), { caseId, verdict: "confirm", periods, locatorIds: [scopeLocator!.id], explanation: "Test harness: same periods read from Item 4.02" });

  await advanceReplay(workspaceId, 1, operator);
  const [amendment] = await db.select().from(sourceDocument).where(eq(sourceDocument.accession, "0001683168-26-006788"));
  const [restated] = await db.select({ locatorId: financialFact.locatorId }).from(financialFact).where(and(eq(financialFact.sourceId, amendment!.id), eq(financialFact.sourceColumn, "as_restated"), eq(financialFact.periodEnd, "2025-03-31"))).limit(1);
  await linkAmendment(as("filing-monitor"), { caseId, sourceId: amendment!.id, locatorIds: [restated!.locatorId], summary: "Test harness: restated Q1 2025 balance sheet" });

  const [session] = await db.insert(runtimeSession).values({ workspaceId, sdkVersion: "test-harness", model: "none", leaseFence: 0, leaseHolder: "test-harness", leaseUntil: new Date(), status: "ENDED" }).returning();
  const [run] = await db.insert(agentRun).values({ workspaceId, runtimeSessionId: session!.id, nativeAgentId: "test-harness", role: "test-harness:financial-verifier", epoch: 2, taskKey: "test-harness", trigger: "test-harness", status: "COMPLETED", model: "none", startedAt: new Date(), endedAt: new Date(), heartbeatAt: new Date(), summary: "Test harness run, not an agent" }).returning();

  const impacts = await db.select({ impact: claimImpact, claim }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(eq(claimImpact.caseId, caseId));
  for (const candidate of impacts.filter((i) => i.impact.classification === "candidate")) {
    const { result } = await proposeReplacement(as("impact-analyst", 2), { caseId, claimId: candidate.claim.id, kind: "unaffected", factIds: [], rationale: "Test harness: mention without figures" });
    await submitVerification(as("financial-verifier", 2, run!.id), { proposalId: result.proposalId, verdict: "verified", locatorIds: [], independentValue: null, rationale: "Test harness: no figures, no bindings" });
  }
  const byLabel = (label: string) => impacts.find((i) => i.claim.label === label)!.claim;
  for (const label of ["Total current assets, March 31, 2025", "Total current liabilities, March 31, 2025", "Table: total current assets", "Table: total current liabilities"]) {
    const target = byLabel(label);
    const candidate = (await findFactCandidates(as("impact-analyst", 2), { caseId, claimId: target.id })).find((f) => f.column === "as_restated")!;
    const { result } = await proposeReplacement(as("impact-analyst", 2), { caseId, claimId: target.id, kind: "fact", factIds: [candidate.factId], rationale: "Test harness: as restated column" });
    await db.insert(toolCall).values({ agentRunId: run!.id, toolName: "read_source_excerpt", inputSummary: candidate.locatorId, ok: true, sourceRefs: [candidate.locatorId], startedAt: new Date(), endedAt: new Date() });
    await submitVerification(as("financial-verifier", 2, run!.id), { proposalId: result.proposalId, verdict: "verified", locatorIds: [candidate.locatorId], independentValue: candidate.value!, rationale: "Test harness: read the restated cell" });
  }
  for (const label of ["Working capital, March 31, 2025", "Table: working capital", "Current ratio, March 31, 2025"]) {
    const { result } = await proposeReplacement(as("impact-analyst", 2), { caseId, claimId: byLabel(label).id, kind: "formula", rationale: "Test harness: recompute" });
    await submitVerification(as("financial-verifier", 2, run!.id), { proposalId: result.proposalId, verdict: "verified", locatorIds: [], independentValue: result.value, rationale: "Test harness: recomputed" });
  }
  const noteImpact = impacts.find((i) => i.claim.label === "Total current assets, March 31, 2025")!;
  const report = (await db.query.researchReport.findFirst({ where: and(eq(researchReport.workspaceId, workspaceId), eq(researchReport.id, noteImpact.impact.reportId)) }))!;
  const base = (await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, report.currentRevisionId!) }))!;
  const id = (label: string) => byLabel(label).id;
  const block = (label: string) => byLabel(label).blockId;
  const drafted = await proposeRevisionPatch(as("publication-editor", 2), {
    caseId,
    reportId: report.id,
    baseRevisionId: base.id,
    patches: [
      { blockId: block("Headline conclusion"), text: "Nocera Q1 2025: restated figures show a working capital deficit" },
      { blockId: block("Total current assets, March 31, 2025"), text: `After the restatement, total current assets at March 31, 2025 were {{claim:${id("Total current assets, March 31, 2025")}}}, not {{previous:${id("Total current assets, March 31, 2025")}}}. Total current liabilities were {{claim:${id("Total current liabilities, March 31, 2025")}}}.` },
      { blockId: block("Working capital, March 31, 2025"), text: `That leaves working capital of {{claim:${id("Working capital, March 31, 2025")}}} and a current ratio of {{claim:${id("Current ratio, March 31, 2025")}}}.` },
      { blockId: block("Table: total current assets"), text: `Measure | March 31, 2025, as restated\nTotal current assets | {{claim:${id("Table: total current assets")}}}\nTotal current liabilities | {{claim:${id("Table: total current liabilities")}}}\nWorking capital | {{claim:${id("Table: working capital")}}}` },
      { blockId: block("Liquidity conclusion"), text: "On the restated figures, current liabilities exceed current assets, so the earlier view that liquidity had room to spare no longer holds." },
    ],
    notice: { whatChanged: "The current asset, current liability, working capital and current ratio figures now use the restated balance sheet.", why: "Nocera said its earlier statements should no longer be relied upon and filed restated figures in 10-K/A No. 2.", conclusions: "The headline and the liquidity conclusion were rewritten because restated current liabilities exceed current assets." },
  });
  await reviewConclusions(as("financial-verifier", 2), { candidateId: drafted.result.candidateId, verdict: "consistent", explanation: "Test harness: rewritten sentences match a working capital deficit" });
  return { workspaceId, slug, caseId, candidateId: drafted.result.candidateId, reportId: report.id };
}
