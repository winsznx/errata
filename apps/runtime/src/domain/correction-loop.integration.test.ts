import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db/client.js";
import {
  agentRun,
  claim,
  claimImpact,
  correctionCase,
  correctionNotice,
  delivery,
  financialFact,
  reportWarning,
  researchReport,
  researchRevision,
  runtimeSession,
  sourceDocument,
  sourceLocator,
  toolCall,
} from "../db/schema.js";
import { advanceReplay, checkDisclosureScope, linkAmendment, proposeDisclosureScope, type ActorContext } from "./cases.js";
import { findFactCandidates, proposeReplacement, submitVerification } from "./claims-work.js";
import { DomainError } from "./errors.js";
import { proposeRevisionPatch, reissue, reviewCandidate } from "./publication.js";
import { createScenarioWorkspace } from "./workspace.js";

const human = { kind: "human" as const, id: "editor:test" };

async function textLocators(accession: string) {
  const [source] = await db.select().from(sourceDocument).where(eq(sourceDocument.accession, accession));
  const locators = await db.select().from(sourceLocator).where(and(eq(sourceLocator.sourceId, source!.id), eq(sourceLocator.kind, "text")));
  return { source: source!, locators };
}

async function fakeRun(workspaceId: string, role: string, epoch: number) {
  const [session] = await db.insert(runtimeSession).values({ workspaceId, sdkVersion: "test", model: "none", leaseFence: 1, leaseHolder: "test", leaseUntil: new Date(Date.now() + 60_000), status: "ACTIVE" }).returning();
  const [run] = await db
    .insert(agentRun)
    .values({ workspaceId, runtimeSessionId: session!.id, nativeAgentId: role, role, epoch, taskKey: "test", trigger: "test", status: "STARTED", model: "none", startedAt: new Date(), heartbeatAt: new Date() })
    .returning();
  return run!.id;
}

async function recordRead(agentRunId: string, locatorId: string) {
  await db.insert(toolCall).values({ agentRunId, toolName: "read_source_excerpt", inputSummary: locatorId, ok: true, sourceRefs: [locatorId], startedAt: new Date(), endedAt: new Date() });
}

afterAll(async () => {
  await sqlClient.end();
});

describe("Nocera correction loop through the domain guards", () => {
  it("warns, waits for evidence, verifies the restatement and reissues the note", async () => {
    const { workspaceId } = await createScenarioWorkspace("nocera-q1-repair");
    const monitor: ActorContext = { workspaceId, actor: { kind: "agent", id: "filing-monitor" } };
    const verifierBase: ActorContext = { workspaceId, actor: { kind: "agent", id: "financial-verifier" } };
    const analystBase: ActorContext = { workspaceId, actor: { kind: "agent", id: "impact-analyst" } };

    const step1 = await advanceReplay(workspaceId, 0, human);
    expect(step1.position).toBe(1);
    await expect(advanceReplay(workspaceId, 0, human)).rejects.toMatchObject({ code: "CONFLICT" });

    const { source: notice, locators } = await textLocators("0001683168-26-006537");
    const scopeLocator = locators.find((l) => l.excerpt.includes("should no longer be relied upon"))!;
    const periods = [
      { start: "2024-01-01", end: "2024-12-31", type: "duration" as const, label: "Fiscal year 2024" },
      { start: "2025-01-01", end: "2025-12-31", type: "duration" as const, label: "Fiscal year 2025" },
      { start: "2025-01-01", end: "2025-03-31", type: "duration" as const, label: "Quarter ended March 31, 2025" },
      { start: "2025-04-01", end: "2025-06-30", type: "duration" as const, label: "Quarter ended June 30, 2025" },
      { start: "2025-07-01", end: "2025-09-30", type: "duration" as const, label: "Quarter ended September 30, 2025" },
    ];
    await expect(proposeDisclosureScope(monitor, { sourceId: notice.id, classification: "NON_RELIANCE", periods: [{ ...periods[0]!, end: "2023-12-31" }], locatorIds: [scopeLocator.id], summary: "bad" })).rejects.toBeInstanceOf(DomainError);
    const proposed = await proposeDisclosureScope(monitor, { sourceId: notice.id, classification: "NON_RELIANCE", periods, locatorIds: [scopeLocator.id], summary: "Board concluded statements should no longer be relied upon" });
    const caseId = proposed.result.caseId!;
    expect(proposed.result).toMatchObject({ impacts: 8 });

    await expect(checkDisclosureScope(monitor, { caseId, verdict: "confirm", periods, locatorIds: [scopeLocator.id], explanation: "self" })).rejects.toMatchObject({ code: "SELF_VERIFICATION" });
    const confirmed = await checkDisclosureScope(verifierBase, { caseId, verdict: "confirm", periods, locatorIds: [scopeLocator.id], explanation: "Independently read Item 4.02" });
    expect(confirmed.result.confirmed).toBe(true);

    const reports = await db.select().from(researchReport).where(eq(researchReport.workspaceId, workspaceId));
    const nocera = reports.find((r) => r.title.startsWith("Nocera"))!;
    const joint = reports.find((r) => r.title.startsWith("The Joint"))!;
    const roundup = reports.find((r) => r.title.startsWith("Small-cap"))!;
    expect(nocera.reliability).toBe("NON_RELIANCE");
    expect(joint.reliability).toBe("CLEAR");
    expect(roundup.reliability).toBe("UNDER_REVIEW");
    const caseAfterScope = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) });
    expect(caseAfterScope!.status).toBe("AWAITING_EVIDENCE");

    const impacts = await db.select({ impact: claimImpact, claim }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(eq(claimImpact.caseId, caseId));
    const byLabel = (label: string) => impacts.find((i) => i.claim.label === label)!;
    const ca = byLabel("Total current assets, March 31, 2025").claim;
    await expect(proposeReplacement({ ...analystBase, epoch: 1 }, { caseId, claimId: ca.id, kind: "fact", factIds: [], rationale: "too early" })).rejects.toMatchObject({ code: "BLOCKED" });

    await advanceReplay(workspaceId, 1, human);
    const [amendment] = await db.select().from(sourceDocument).where(eq(sourceDocument.accession, "0001683168-26-006788"));
    const restatedLocator = await db.select({ locatorId: financialFact.locatorId }).from(financialFact).where(and(eq(financialFact.sourceId, amendment!.id), eq(financialFact.sourceColumn, "as_restated"), eq(financialFact.periodEnd, "2025-03-31"))).limit(1);
    const linked = await linkAmendment({ ...monitor, epoch: 1 }, { caseId, sourceId: amendment!.id, locatorIds: [restatedLocator[0]!.locatorId], summary: "Restated Q1 2025 balance sheet" });
    expect(linked.result.epoch).toBe(2);

    await expect(proposeReplacement({ ...analystBase, epoch: 1 }, { caseId, claimId: ca.id, kind: "fact", factIds: [], rationale: "stale" })).rejects.toMatchObject({ code: "STALE_EVIDENCE" });

    const analyst = { ...analystBase, epoch: 2 };
    const verifierRun = await fakeRun(workspaceId, "financial-verifier", 2);
    const verifier = { ...verifierBase, epoch: 2, agentRunId: verifierRun };
    for (const label of ["Total current assets, March 31, 2025", "Total current liabilities, March 31, 2025", "Table: total current assets", "Table: total current liabilities"]) {
      const target = byLabel(label).claim;
      const candidates = await findFactCandidates(analyst, { caseId, claimId: target.id });
      const restated = candidates.find((f) => f.column === "as_restated")!;
      expect(candidates.some((f) => f.column === "as_reported")).toBe(true);
      const { result } = await proposeReplacement(analyst, { caseId, claimId: target.id, kind: "fact", factIds: [restated.factId], rationale: "As restated column" });
      await expect(submitVerification({ ...verifier, actor: analyst.actor }, { proposalId: result.proposalId, verdict: "verified", locatorIds: [restated.locatorId], independentValue: restated.value, rationale: "self" })).rejects.toMatchObject({ code: "SELF_VERIFICATION" });
      await recordRead(verifierRun, restated.locatorId);
      const verified = await submitVerification(verifier, { proposalId: result.proposalId, verdict: "verified", locatorIds: [restated.locatorId], independentValue: restated.value, rationale: "Read the restated table myself" });
      expect(verified.result.verified).toBe(true);
    }
    const wcClaims = ["Working capital, March 31, 2025", "Table: working capital", "Current ratio, March 31, 2025"].map((l) => byLabel(l).claim);
    const values: string[] = [];
    for (const target of wcClaims) {
      const inputs = await db.query.claim.findMany({ where: inArray(claim.id, (target.formula as { args: { ref: string }[] }).args.map((a) => a.ref)) });
      expect(inputs).toHaveLength(2);
      const { result } = await proposeReplacement(analyst, { caseId, claimId: target.id, kind: "formula", rationale: "Recompute from verified inputs" });
      values.push(result.value!);
      const verified = await submitVerification(verifier, { proposalId: result.proposalId, verdict: "verified", locatorIds: [], independentValue: result.value, rationale: "Recomputed" });
      expect(verified.result.checks.filter((check) => !check.ok)).toEqual([]);
    }
    expect(values[0]).toBe("-123653");

    const base = (await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, nocera.currentRevisionId!) }))!;
    const blockOf = (label: string) => byLabel(label).claim.blockId;
    const id = (label: string) => byLabel(label).claim.id;
    const patches = [
      { blockId: blockOf("Total current assets, March 31, 2025"), text: `After the restatement, Nocera's total current assets at March 31, 2025 were {{claim:${id("Total current assets, March 31, 2025")}}}, down from {{previous:${id("Total current assets, March 31, 2025")}}} as originally reported. Total current liabilities were {{claim:${id("Total current liabilities, March 31, 2025")}}}.` },
      { blockId: blockOf("Working capital, March 31, 2025"), text: `That leaves working capital of {{claim:${id("Working capital, March 31, 2025")}}} and a current ratio of {{claim:${id("Current ratio, March 31, 2025")}}}.` },
      { blockId: blockOf("Table: total current assets"), text: `Measure | March 31, 2025, as restated\nTotal current assets | {{claim:${id("Table: total current assets")}}}\nTotal current liabilities | {{claim:${id("Table: total current liabilities")}}}\nWorking capital | {{claim:${id("Table: working capital")}}}` },
      { blockId: blockOf("Liquidity conclusion"), text: "On the restated figures, current liabilities exceed current assets, so the earlier view that the balance sheet showed room to spare no longer holds." },
    ];
    await expect(proposeRevisionPatch({ workspaceId, actor: { kind: "agent", id: "publication-editor" }, epoch: 2 }, { caseId, reportId: nocera.id, baseRevisionId: base.id, patches: [{ blockId: patches[0]!.blockId, text: "Current assets were $670,496." }], notice: { whatChanged: "x", why: "y", conclusions: "z" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const drafted = await proposeRevisionPatch(
      { workspaceId, actor: { kind: "agent", id: "publication-editor" }, epoch: 2 },
      { caseId, reportId: nocera.id, baseRevisionId: base.id, patches, notice: { whatChanged: "Current assets, current liabilities, working capital and the current ratio for March 31, 2025 now use the restated balance sheet.", why: "Nocera said its earlier statements should no longer be relied upon and filed restated figures in 10-K/A No. 2.", conclusions: "The liquidity conclusion was rewritten because restated current liabilities exceed current assets." } },
    );
    expect(drafted.result.blockers).toEqual([]);
    const candidate = (await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, drafted.result.candidateId) }))!;
    expect(candidate.markdown).toContain("$670,496");
    expect(candidate.markdown).toContain("-$123,653");
    expect(candidate.markdown).toContain("0.84");

    const reviewer = { workspaceId, actor: human, actorName: "Test Editor", principalId: crypto.randomUUID() };
    const review = await reviewCandidate(reviewer, { candidateId: candidate.id, decision: "approve", contentHash: candidate.contentHash, epochVector: candidate.epochVector });
    const reissueInput = { candidateId: candidate.id, approvalId: review.result.reviewId, candidateHash: candidate.contentHash, expectedBaseRevisionId: base.id, evidenceEpochs: candidate.epochVector };
    const [first, second] = await Promise.allSettled([reissue(reviewer, reissueInput), reissue(reviewer, reissueInput)]);
    const outcomes = [first, second].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);

    const after = (await db.query.researchReport.findFirst({ where: eq(researchReport.id, nocera.id) }))!;
    expect(after.currentRevisionId).toBe(candidate.id);
    expect(after.reliability).toBe("CLEAR");
    const oldWarnings = await db.select().from(reportWarning).where(eq(reportWarning.revisionId, base.id));
    expect(oldWarnings.some((w) => w.type === "NON_RELIANCE" && w.state === "ACTIVE")).toBe(true);
    const notices = await db.select().from(correctionNotice).where(eq(correctionNotice.reportId, nocera.id));
    expect(notices).toHaveLength(1);
    const deliveries = await db.select().from(delivery).where(and(eq(delivery.noticeId, notices[0]!.id)));
    expect(deliveries).toHaveLength(3);
    const finalCase = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) });
    expect(["RESOLVED", "PARTIALLY_REISSUED"]).toContain(finalCase!.status);
  });
});
