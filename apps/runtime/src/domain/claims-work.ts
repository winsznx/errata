import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../db/client.js";
import {
  agentRun,
  calculation,
  caseSource,
  challenge,
  claim,
  claimBinding,
  claimImpact,
  financialFact,
  replacementProposal,
  reportWarning,
  researchReport,
  sourceDocument,
  sourceLocator,
  toolCall,
  verificationAttestation,
} from "../db/schema.js";
import { CALC_VERSION, computeFormula, formulaRefs, type FormulaInput } from "../formula/engine.js";
import { guardEpoch, lockCase, recomputeCaseStatus, type ActorContext } from "./cases.js";
import { eligibleSource, eligibleSources } from "./eligibility.js";
import { DomainError, assert } from "./errors.js";
import { commit } from "./events.js";
import { FORMULA_AGREEMENT_DIGITS, agreesToSignificantDigits, resolveLocator, sameDecimal } from "./locator.js";

export type ProposalKind = "fact" | "formula" | "unchanged" | "unaffected";

const OPEN_IMPACT_STATES = ["INVALIDATED", "REPLACEMENT_PROPOSED", "REJECTED", "UNDER_REVIEW"] as const;

async function claimWithImpact(tx: DbOrTx, caseId: string, claimId: string) {
  const [row] = await tx.select({ claim, impact: claimImpact }).from(claimImpact).innerJoin(claim, eq(claim.id, claimImpact.claimId)).where(and(eq(claimImpact.caseId, caseId), eq(claimImpact.claimId, claimId)));
  if (!row) throw new DomainError("NOT_FOUND", "the claim is not part of this case", { claimId });
  return row;
}

async function amendmentSourceIds(tx: Tx, caseId: string): Promise<string[]> {
  const rows = await tx.select({ id: caseSource.sourceId }).from(caseSource).where(and(eq(caseSource.caseId, caseId), eq(caseSource.relation, "amendment")));
  return rows.map((r) => r.id);
}

/** Read-only: facts in eligible sources that share the claim's economic identity, across every column. */
export async function findFactCandidates(ctx: ActorContext, input: { caseId: string; claimId: string }) {
  const { claim: c } = await claimWithImpact(db, input.caseId, input.claimId);
  assert(c.semanticKey, "INVALID_INPUT", "this claim is not bound to a single reported fact; use its formula inputs instead");
  const eligible = await eligibleSources(db, ctx.workspaceId);
  const eligibleIds = eligible.map((s) => s.id);
  if (!eligibleIds.length) return [];
  const facts = await db
    .select({ fact: financialFact, accession: sourceDocument.accession, form: sourceDocument.form, filedDate: sourceDocument.filedDate, locatorKind: sourceLocator.kind })
    .from(financialFact)
    .innerJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId))
    .innerJoin(sourceLocator, eq(sourceLocator.id, financialFact.locatorId))
    .where(and(eq(financialFact.semanticKey, c.semanticKey), inArray(financialFact.sourceId, eligibleIds)));
  return facts.map(({ fact, accession, form, filedDate, locatorKind }) => ({
    factId: fact.id,
    sourceId: fact.sourceId,
    accession,
    form,
    filedDate,
    column: fact.sourceColumn,
    label: fact.label,
    rawText: fact.rawText,
    value: fact.value,
    unit: fact.unit,
    periodEnd: fact.periodEnd,
    locatorId: fact.locatorId,
    locatorKind,
    extractionMethod: fact.extractionMethod,
  }));
}

export interface ReplacementInput {
  caseId: string;
  claimId: string;
  kind: ProposalKind;
  factIds?: string[];
  formula?: unknown;
  rationale: string;
}

export async function verifiedInputs(tx: DbOrTx, caseId: string, epoch: number, formula: unknown, derivedClaimId: string): Promise<FormulaInput[]> {
  const inputBindings = await tx.query.claimBinding.findMany({ where: and(eq(claimBinding.claimId, derivedClaimId), eq(claimBinding.kind, "derived_input")) });
  const allowed = new Set(inputBindings.map((b) => b.refClaimId));
  const refs = formulaRefs(formula as Parameters<typeof formulaRefs>[0]);
  const inputs: FormulaInput[] = [];
  for (const ref of refs) {
    assert(allowed.has(ref), "INVALID_INPUT", `formula input ${ref} is not one of this claim's recorded inputs`);
    const accepted = await tx.query.replacementProposal.findFirst({
      where: and(eq(replacementProposal.caseId, caseId), eq(replacementProposal.claimId, ref), eq(replacementProposal.epoch, epoch), eq(replacementProposal.status, "VERIFIED")),
    });
    assert(accepted?.value, "BLOCKED", `input claim ${ref} has no verified replacement on the current evidence revision yet`, { inputClaimId: ref });
    const inputClaim = await tx.query.claim.findFirst({ where: eq(claim.id, ref) });
    const [fact] = accepted.factIds.length ? await tx.select().from(financialFact).where(eq(financialFact.id, accepted.factIds[0]!)) : [];
    inputs.push({ ref, value: accepted.value, unit: fact?.unit ?? inputClaim?.displayUnit ?? "USD", periodEnd: fact?.periodEnd ?? "", issuerCik: fact?.issuerCik ?? "" });
  }
  return inputs;
}

export async function proposeReplacement(ctx: ActorContext, input: ReplacementInput) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const { claim: c, impact } = await claimWithImpact(tx, caseRow.id, input.claimId);
    assert((OPEN_IMPACT_STATES as readonly string[]).includes(impact.state), "CONFLICT", `claim is already ${impact.state}`);
    const amendments = await amendmentSourceIds(tx, caseRow.id);

    let value: string | null = null;
    let factIds: string[] = [];
    let sourceHashes: string[] = [];
    let formula: unknown = null;

    if (input.kind === "unaffected") {
      assert(impact.classification === "candidate", "INVALID_INPUT", "only claims under candidate review can be proposed as unaffected");
    } else {
      assert(amendments.length > 0, "BLOCKED", "no amended filing is linked to this case yet, so there is no corrected evidence to cite");
    }

    if (input.kind === "fact" || input.kind === "unchanged") {
      assert(c.semanticKey, "INVALID_INPUT", "claim is not bound to a reported fact");
      assert(input.factIds?.length === 1, "INVALID_INPUT", "cite exactly one fact");
      const [fact] = await tx.select().from(financialFact).where(eq(financialFact.id, input.factIds[0]!));
      assert(fact, "NOT_FOUND", "fact not found");
      const source = await eligibleSource(tx, ctx.workspaceId, fact.sourceId);
      assert(amendments.includes(source.id), "INVALID_INPUT", "the cited fact must come from an amended filing linked to this case");
      assert(fact.semanticKey === c.semanticKey, "INVALID_INPUT", "the cited fact has a different issuer, concept, period or unit than the claim", { claimKey: c.semanticKey, factKey: fact.semanticKey });
      if (input.kind === "fact") assert(fact.sourceColumn === "as_restated", "INVALID_INPUT", `cite the as-restated column, not ${fact.sourceColumn}`);
      else {
        assert(fact.sourceColumn === "as_restated" || fact.sourceColumn === "ordinary", "INVALID_INPUT", "an unchanged figure must cite the amended filing's current value");
        assert(sameDecimal(fact.value, c.valueDecimal), "INVALID_INPUT", "the amended value differs from the original, so it is not unchanged");
      }
      value = fact.value;
      factIds = [fact.id];
      sourceHashes = [source.sha256];
    }

    if (input.kind === "formula") {
      assert(c.category === "DERIVED" && c.formula, "INVALID_INPUT", "only derived claims take a formula replacement");
      formula = input.formula ?? c.formula;
      const inputs = await verifiedInputs(tx, caseRow.id, caseRow.evidenceEpoch, formula, c.id);
      const result = computeFormula(formula, inputs);
      assert(result.ok, "INVALID_INPUT", result.ok ? "" : `${result.code}: ${result.message}`);
      value = result.value;
    }

    const [proposal] = await tx
      .insert(replacementProposal)
      .values({ workspaceId: ctx.workspaceId, caseId: caseRow.id, claimId: c.id, epoch: caseRow.evidenceEpoch, proposerAgent: ctx.actor.id, agentRunId: ctx.agentRunId ?? null, kind: input.kind, factIds, formula, value, rationale: input.rationale.slice(0, 2000), sourceHashes, status: "PROPOSED" })
      .returning();
    if (formula && proposal) {
      const inputs = await verifiedInputs(tx, caseRow.id, caseRow.evidenceEpoch, formula, c.id);
      const result = computeFormula(formula, inputs);
      await tx.insert(calculation).values({ workspaceId: ctx.workspaceId, claimId: c.id, proposalId: proposal.id, ast: formula, inputs: inputs.map((i) => ({ ref: i.ref, value: i.value, unit: i.unit })), exactResult: result.ok ? result.value : null, unit: result.ok ? result.unit : null, rounding: "display only, half up", calcVersion: CALC_VERSION, error: result.ok ? null : result.message });
    }
    await tx.update(claimImpact).set({ state: "REPLACEMENT_PROPOSED", epoch: caseRow.evidenceEpoch, updatedAt: new Date(), rowVersion: impact.rowVersion + 1 }).where(eq(claimImpact.id, impact.id));
    await record({
      workspaceId: ctx.workspaceId,
      type: "claim.replacement_proposed",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { proposalId: proposal!.id, claimId: c.id, claimLabel: c.label, kind: input.kind, value, factIds, agentRunId: ctx.agentRunId ?? null },
    });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { proposalId: proposal!.id, value };
  });
}

export interface VerificationInput {
  proposalId: string;
  verdict: "verified" | "rejected";
  locatorIds: string[];
  independentValue: string | null;
  rationale: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function locatorsReadInRun(tx: Tx, agentRunId: string | null | undefined): Promise<Set<string>> {
  if (!agentRunId) return new Set();
  const calls = await tx.select({ refs: toolCall.sourceRefs }).from(toolCall).where(and(eq(toolCall.agentRunId, agentRunId), eq(toolCall.toolName, "read_source_excerpt"), eq(toolCall.ok, true)));
  return new Set(calls.flatMap((c) => c.refs));
}

export async function submitVerification(ctx: ActorContext, input: VerificationInput) {
  return commit(async (tx, record) => {
    const [proposal] = await tx.select().from(replacementProposal).where(and(eq(replacementProposal.id, input.proposalId), eq(replacementProposal.workspaceId, ctx.workspaceId))).for("update");
    assert(proposal, "NOT_FOUND", "proposal not found");
    const caseRow = await lockCase(tx, ctx.workspaceId, proposal.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    assert(proposal.epoch === caseRow.evidenceEpoch, "STALE_EVIDENCE", "the proposal was made on an older evidence revision", { proposalEpoch: proposal.epoch, currentEpoch: caseRow.evidenceEpoch });
    assert(proposal.status === "PROPOSED", "CONFLICT", `proposal is already ${proposal.status}`);
    assert(proposal.proposerAgent !== ctx.actor.id, "SELF_VERIFICATION", "a participant cannot verify its own proposal");
    const { claim: c, impact } = await claimWithImpact(tx, caseRow.id, proposal.claimId);

    const checks: CheckResult[] = [];
    const readInRun = await locatorsReadInRun(tx, ctx.agentRunId);
    const independentFactIds: string[] = [];
    const hashes: string[] = [];

    if (proposal.kind === "fact" || proposal.kind === "unchanged") {
      assert(input.locatorIds.length > 0, "INVALID_INPUT", "cite the locator you read to check this figure");
      const [proposedFact] = await tx.select().from(financialFact).where(eq(financialFact.id, proposal.factIds[0]!));
      for (const locatorId of input.locatorIds) {
        const [locator] = await tx.select().from(sourceLocator).where(eq(sourceLocator.id, locatorId));
        if (!locator) {
          checks.push({ name: "locator_exists", ok: false, detail: `locator ${locatorId} does not exist` });
          continue;
        }
        checks.push({ name: "independent_read", ok: readInRun.has(locatorId), detail: readInRun.has(locatorId) ? "verifier read this excerpt itself in this run" : "verifier did not read this excerpt in this run" });
        let source: Awaited<ReturnType<typeof eligibleSource>>;
        try {
          source = await eligibleSource(tx, ctx.workspaceId, locator.sourceId);
          checks.push({ name: "eligible_at_replay_clock", ok: true, detail: `${source.form} ${source.accession}` });
        } catch {
          checks.push({ name: "eligible_at_replay_clock", ok: false, detail: "cited source is not public at the replay clock" });
          continue;
        }
        hashes.push(source.sha256);
        const resolved = await resolveLocator(source, locator);
        checks.push({ name: "locator_resolves", ok: resolved.ok, detail: resolved.detail });
        const facts = await tx.select().from(financialFact).where(eq(financialFact.locatorId, locatorId));
        const match = facts.find((f) => f.semanticKey === c.semanticKey && (proposal.kind === "unchanged" ? f.sourceColumn !== "as_reported" && f.sourceColumn !== "adjustment" : f.sourceColumn === "as_restated"));
        checks.push({ name: "identity_and_column", ok: Boolean(match), detail: match ? `${match.conceptId} ${match.periodEnd} ${match.sourceColumn}` : "no fact at this locator matches the claim's identity and the corrected column" });
        if (match) independentFactIds.push(match.id);
        checks.push({ name: "bytes_match_recorded_value", ok: Boolean(match && sameDecimal(resolved.value, match.value)), detail: `source shows ${resolved.value ?? "nothing"}` });
      }
      checks.push({ name: "verifier_value_matches_source", ok: independentFactIds.length > 0 && sameDecimal(input.independentValue, proposal.value), detail: `verifier read ${input.independentValue ?? "nothing"}, proposal says ${proposal.value}` });
      checks.push({ name: "proposal_fact_matches", ok: Boolean(proposedFact && sameDecimal(proposedFact.value, proposal.value)), detail: "proposal value equals its cited fact" });
    }

    if (proposal.kind === "formula") {
      try {
        const inputs = await verifiedInputs(tx, caseRow.id, caseRow.evidenceEpoch, proposal.formula, c.id);
        const result = computeFormula(proposal.formula, inputs);
        checks.push({ name: "recomputed_in_code", ok: result.ok && sameDecimal(result.value, proposal.value), detail: result.ok ? `recomputed ${result.value}` : result.message });
        checks.push({ name: "verifier_value_matches_recomputation", ok: result.ok && agreesToSignificantDigits(input.independentValue, result.value, FORMULA_AGREEMENT_DIGITS), detail: `verifier computed ${input.independentValue ?? "nothing"}; code recomputed ${result.ok ? result.value : "nothing"}; must agree to ${FORMULA_AGREEMENT_DIGITS} significant digits` });
      } catch (error) {
        checks.push({ name: "inputs_verified", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }

    if (proposal.kind === "unaffected") {
      const numeric = /\d/.test(c.text);
      const bindings = await tx.$count(claimBinding, eq(claimBinding.claimId, c.id));
      checks.push({ name: "no_figures_in_claim", ok: !numeric, detail: numeric ? "claim text contains figures" : "claim text has no figures" });
      checks.push({ name: "no_bound_facts", ok: bindings === 0, detail: `${bindings} bindings` });
      checks.push({ name: "not_material", ok: !c.material, detail: c.material ? "claim is marked material" : "claim is not material" });
    }

    const allPass = checks.length > 0 && checks.every((check) => check.ok);
    const verified = input.verdict === "verified" && allPass;
    const [attestation] = await tx
      .insert(verificationAttestation)
      .values({
        workspaceId: ctx.workspaceId,
        proposalId: proposal.id,
        epoch: caseRow.evidenceEpoch,
        verifierAgent: ctx.actor.id,
        agentRunId: ctx.agentRunId ?? null,
        verdict: verified ? "VERIFIED" : "REJECTED",
        independentFactIds,
        independentValue: input.independentValue,
        comparison: { proposalValue: proposal.value, independentValue: input.independentValue, verifierVerdict: input.verdict },
        sourceHashes: hashes,
        calcVersion: CALC_VERSION,
        deterministicChecks: checks,
        rationale: input.rationale.slice(0, 2000),
        valid: true,
      })
      .returning();
    const alreadyVerified = await tx.$count(replacementProposal, and(eq(replacementProposal.caseId, caseRow.id), eq(replacementProposal.claimId, c.id), eq(replacementProposal.epoch, caseRow.evidenceEpoch), eq(replacementProposal.status, "VERIFIED")));
    const nextImpact = verified ? (proposal.kind === "unchanged" ? "UNCHANGED_VERIFIED" : proposal.kind === "unaffected" ? "UNAFFECTED" : "VERIFIED_REPLACEMENT") : alreadyVerified ? impact.state : "REJECTED";
    await tx.update(replacementProposal).set({ status: verified ? "VERIFIED" : "REJECTED", statusReason: verified ? null : checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join("; ") || input.rationale.slice(0, 500), updatedAt: new Date() }).where(eq(replacementProposal.id, proposal.id));
    await tx.update(claimImpact).set({ state: nextImpact, updatedAt: new Date(), rowVersion: impact.rowVersion + 1 }).where(eq(claimImpact.id, impact.id));
    let challengeId: string | null = null;
    if (!verified) {
      const failed = checks.filter((x) => !x.ok);
      const [raised] = await tx
        .insert(challenge)
        .values({ workspaceId: ctx.workspaceId, caseId: caseRow.id, targetKind: "replacement_proposal", targetId: proposal.id, epoch: caseRow.evidenceEpoch, raisedBy: ctx.actor.id, reasonCode: failed[0]?.name.toUpperCase() ?? "VERIFIER_REJECTED", explanation: (failed.map((x) => `${x.name}: ${x.detail}`).join("; ") || input.rationale).slice(0, 1500), refs: input.locatorIds, status: "OPEN" })
        .returning();
      challengeId = raised!.id;
      await record({ workspaceId: ctx.workspaceId, type: "challenge.raised", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { challengeId, targetKind: "replacement_proposal", targetId: proposal.id, claimId: c.id, proposer: proposal.proposerAgent, failedChecks: failed.map((x) => x.name), explanation: input.rationale.slice(0, 500) } });
    } else {
      await tx.update(challenge).set({ status: "RESOLVED", resolution: `Superseded by verified proposal ${proposal.id}`, resolvedAt: new Date() }).where(and(eq(challenge.caseId, caseRow.id), eq(challenge.status, "OPEN"), sql`${challenge.targetId} in (select id::text from replacement_proposal where claim_id = ${c.id})`));
    }
    if (verified && nextImpact === "UNAFFECTED") await clearCandidateWarning(tx, caseRow.id, impact.reportId, record);
    await record({
      workspaceId: ctx.workspaceId,
      type: verified ? "claim.verified" : "claim.rejected",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { attestationId: attestation!.id, proposalId: proposal.id, claimId: c.id, claimLabel: c.label, reportId: impact.reportId, kind: proposal.kind, value: proposal.value, checks, challengeId, agentRunId: ctx.agentRunId ?? null },
    });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { verified, attestationId: attestation!.id, checks, challengeId };
  });
}

/** A note that was only under review is cleared once every claim that put it under review is verified as unaffected. */
async function clearCandidateWarning(tx: Tx, caseId: string, reportId: string, record: (input: import("./events.js").EventInput) => Promise<unknown>): Promise<void> {
  const remaining = await tx.select({ state: claimImpact.state }).from(claimImpact).where(and(eq(claimImpact.caseId, caseId), eq(claimImpact.reportId, reportId)));
  if (remaining.some((r) => r.state !== "UNAFFECTED")) return;
  const report = await tx.query.researchReport.findFirst({ where: eq(researchReport.id, reportId) });
  if (!report?.currentRevisionId) return;
  await tx.update(reportWarning).set({ state: "RESOLVED", resolvedAt: new Date() }).where(and(eq(reportWarning.caseId, caseId), eq(reportWarning.reportId, reportId), eq(reportWarning.state, "ACTIVE")));
  const stillActive = await tx.$count(reportWarning, and(eq(reportWarning.revisionId, report.currentRevisionId), eq(reportWarning.state, "ACTIVE")));
  if (!stillActive) await tx.update(researchReport).set({ reliability: "CLEAR", updatedAt: new Date(), rowVersion: report.rowVersion + 1 }).where(eq(researchReport.id, report.id));
  await record({ workspaceId: report.workspaceId, type: "report.warning_cleared", actor: { kind: "system", id: "case-engine" }, caseId, payload: { reportId, reason: "Every claim under review was verified as not relying on the affected figures" } });
}

/** A human asks the Financial Verifier for one more independent check of a proposal still waiting for a verdict. */
export async function requestRecheck(ctx: ActorContext & { actorName: string }, input: { caseId: string; proposalId: string }) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    const [proposal] = await tx.select().from(replacementProposal).where(and(eq(replacementProposal.id, input.proposalId), eq(replacementProposal.workspaceId, ctx.workspaceId), eq(replacementProposal.caseId, caseRow.id)));
    assert(proposal, "NOT_FOUND", "proposal not found");
    assert(proposal.status === "PROPOSED", "CONFLICT", "only proposals still waiting for a check can be rechecked");
    assert(proposal.epoch === caseRow.evidenceEpoch, "STALE_EVIDENCE", "this proposal belongs to an older evidence revision");
    const running = await tx.$count(agentRun, and(eq(agentRun.workspaceId, ctx.workspaceId), eq(agentRun.status, "STARTED"), sql`${agentRun.taskKey} like ${`verify:${proposal.id}%`}`));
    assert(!running, "CONFLICT", "a check of this proposal is already running");
    await record({ workspaceId: ctx.workspaceId, type: "verification.recheck_requested", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { proposalId: proposal.id, claimId: proposal.claimId, actorName: ctx.actorName } });
    return { proposalId: proposal.id };
  });
}

export async function raiseChallenge(ctx: ActorContext, input: { caseId: string; targetKind: string; targetId: string; reasonCode: string; explanation: string; refs: string[] }) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const [raised] = await tx
      .insert(challenge)
      .values({ workspaceId: ctx.workspaceId, caseId: caseRow.id, targetKind: input.targetKind, targetId: input.targetId, epoch: caseRow.evidenceEpoch, raisedBy: ctx.actor.id, reasonCode: input.reasonCode.slice(0, 60), explanation: input.explanation.slice(0, 1500), refs: input.refs.slice(0, 20), status: "OPEN" })
      .returning();
    await record({ workspaceId: ctx.workspaceId, type: "challenge.raised", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { challengeId: raised!.id, targetKind: input.targetKind, targetId: input.targetId, reasonCode: input.reasonCode, explanation: input.explanation.slice(0, 500) } });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { challengeId: raised!.id };
  });
}

export async function resolveChallenge(ctx: ActorContext, input: { challengeId: string; resolution: string }) {
  return commit(async (tx, record) => {
    const [row] = await tx.select().from(challenge).where(and(eq(challenge.id, input.challengeId), eq(challenge.workspaceId, ctx.workspaceId))).for("update");
    assert(row, "NOT_FOUND", "challenge not found");
    assert(row.status === "OPEN", "CONFLICT", "challenge is already closed");
    assert(row.raisedBy !== ctx.actor.id || ctx.actor.kind === "human", "FORBIDDEN", "the participant that raised a challenge cannot close it alone");
    await tx.update(challenge).set({ status: "RESOLVED", resolution: input.resolution.slice(0, 1000), resolvedAt: new Date() }).where(eq(challenge.id, row.id));
    await record({ workspaceId: ctx.workspaceId, type: "challenge.resolved", actor: ctx.actor, caseId: row.caseId, payload: { challengeId: row.id, resolution: input.resolution.slice(0, 500) } });
    await recomputeCaseStatus(tx, row.caseId, record);
    return { resolved: true };
  });
}
