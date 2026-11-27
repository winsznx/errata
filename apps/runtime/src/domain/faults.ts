import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { caseSource, claim, claimImpact, correctionCase, financialFact, replacementProposal, workspace } from "../db/schema.js";
import { commit } from "./events.js";

export const FAULT_ACTOR = "fault-injection";

/**
 * Labelled fault for the J4 scenario: once the amendment is linked, insert a replacement for total current assets that
 * cites the as-restated figure for the wrong period (June 30 instead of March 31). It bypasses the proposal guards on
 * purpose, so the test is whether the independent verifier catches it. Recorded as fault injection everywhere.
 */
export async function injectWrongPeriodProposal(workspaceId: string, caseId: string): Promise<boolean> {
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
  const faults = (ws?.settings.faults as { type: string; label: string }[] | undefined) ?? [];
  const fault = faults.find((f) => f.type === "inject_wrong_period_proposal");
  const consumed = (ws?.settings.consumedFaults as string[] | undefined) ?? [];
  if (!fault || consumed.includes(fault.type)) return false;

  const caseRow = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) });
  const [target] = await db
    .select({ claim, impact: claimImpact })
    .from(claimImpact)
    .innerJoin(claim, eq(claim.id, claimImpact.claimId))
    .where(and(eq(claimImpact.caseId, caseId), eq(claim.category, "DIRECT"), eq(claimImpact.state, "INVALIDATED")))
    .limit(1);
  const [amendment] = await db.select().from(caseSource).where(and(eq(caseSource.caseId, caseId), eq(caseSource.relation, "amendment")));
  if (!caseRow || !target?.claim.semanticKey || !amendment) return false;
  const conceptId = target.claim.semanticKey.split("|")[1]!;
  const periodEnd = target.claim.semanticKey.split("|")[4]!;
  const wrong = (await db.select().from(financialFact).where(and(eq(financialFact.sourceId, amendment.sourceId), eq(financialFact.conceptId, conceptId), eq(financialFact.sourceColumn, "as_restated")))).find((f) => f.periodEnd !== periodEnd);
  if (!wrong?.value) return false;

  await db.update(workspace).set({ settings: { ...ws!.settings, consumedFaults: [...consumed, fault.type] } }).where(eq(workspace.id, workspaceId));
  await commit(async (tx, record) => {
    const [proposal] = await tx
      .insert(replacementProposal)
      .values({ workspaceId, caseId, claimId: target.claim.id, epoch: caseRow.evidenceEpoch, proposerAgent: FAULT_ACTOR, kind: "fact", factIds: [wrong.id], value: wrong.value, rationale: `${fault.label}. Cites ${wrong.label} for ${wrong.periodEnd} although the claim is about ${periodEnd}.`, status: "PROPOSED" })
      .returning();
    await tx.update(claimImpact).set({ state: "REPLACEMENT_PROPOSED", updatedAt: new Date() }).where(eq(claimImpact.id, target.impact.id));
    await record({
      workspaceId,
      type: "claim.replacement_proposed",
      actor: { kind: "system", id: FAULT_ACTOR },
      caseId,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { proposalId: proposal!.id, claimId: target.claim.id, claimLabel: target.claim.label, kind: "fact", value: wrong.value, factIds: [wrong.id], faultInjection: fault.label },
    });
  });
  return true;
}
