import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DbOrTx, Tx } from "../db/client.js";
import {
  challenge,
  claim,
  claimBinding,
  claimDependency,
  claimImpact,
  correctionCase,
  correctionNotice,
  delivery,
  editorialReview,
  financialFact,
  publicationRecipient,
  publicationStatusEvent,
  replacementProposal,
  reportWarning,
  researchReport,
  researchRevision,
  sourceDocument,
  type Block,
} from "../db/schema.js";
import { enqueueJob } from "../jobs/outbox.js";
import { guardEpoch, lockCase, recomputeCaseStatus, type ActorContext } from "./cases.js";
import { blocksToMarkdown, contentHash, rebuildTableRows, sameEpochVector, scanNumericTokens } from "./document.js";
import { assert } from "./errors.js";
import { commit } from "./events.js";
import { displayFormatFor, formatDelta, formatValue } from "./format.js";

const PLACEHOLDER = /\{\{(claim|previous):([0-9a-f-]{36})\}\}/g;
const RESOLVED_STATES = ["VERIFIED_REPLACEMENT", "UNCHANGED_VERIFIED"] as const;

export interface PatchInput {
  caseId: string;
  reportId: string;
  baseRevisionId: string;
  patches: { blockId: string; text: string }[];
  notice: { whatChanged: string; why: string; conclusions: string };
}

export interface NoticeChange {
  claimId: string;
  label: string;
  previous: string;
  replacement: string;
  delta: string;
  kind: string;
  sources: { accession: string; form: string; url: string; column: string }[];
}

interface ConclusionReview {
  verdict: "consistent" | "inconsistent";
  explanation: string;
  reviewer: string;
  epoch: number;
  at: string;
}

interface CandidateMeta {
  conclusionReview?: ConclusionReview;
  notice: PatchInput["notice"];
  changes: NoticeChange[];
  blockers: string[];
  patchedBlockIds: string[];
  rewrittenQualitative: string[];
}

function assertNoLiteralFigures(text: string, where: string): void {
  const stripped = text.replace(PLACEHOLDER, "");
  const tokens = scanNumericTokens([{ id: "check", kind: "paragraph", text: stripped }]);
  assert(tokens.length === 0, "INVALID_INPUT", `${where} contains literal figures (${tokens.map((t) => t.text).join(", ")}). Use {{claim:<id>}} for corrected values and {{previous:<id>}} for the original values so code inserts verified numbers.`);
}

async function verifiedReplacement(tx: DbOrTx, caseId: string, epoch: number, claimId: string) {
  return tx.query.replacementProposal.findFirst({
    where: and(eq(replacementProposal.caseId, caseId), eq(replacementProposal.claimId, claimId), eq(replacementProposal.epoch, epoch), eq(replacementProposal.status, "VERIFIED")),
  });
}

async function proposalSources(tx: DbOrTx, factIds: string[]) {
  if (!factIds.length) return [];
  const rows = await tx
    .select({ accession: sourceDocument.accession, form: sourceDocument.form, url: sourceDocument.url, column: financialFact.sourceColumn })
    .from(financialFact)
    .innerJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId))
    .where(inArray(financialFact.id, factIds));
  return rows;
}

async function activeCasesForRevision(tx: DbOrTx, revisionId: string) {
  return tx
    .selectDistinct({ id: correctionCase.id, epoch: correctionCase.evidenceEpoch })
    .from(reportWarning)
    .innerJoin(correctionCase, eq(correctionCase.id, reportWarning.caseId))
    .where(and(eq(reportWarning.revisionId, revisionId), eq(reportWarning.state, "ACTIVE")))
    .orderBy(asc(correctionCase.id));
}

/** Recomputes whether a candidate may be approved. Runs on draft, on review and again inside the reissue transaction. */
export async function evaluateCandidate(tx: DbOrTx, candidateId: string): Promise<{ blockers: string[]; epochVector: { caseId: string; epoch: number }[] }> {
  const candidate = await tx.query.researchRevision.findFirst({ where: eq(researchRevision.id, candidateId) });
  assert(candidate, "NOT_FOUND", "candidate not found");
  const report = await tx.query.researchReport.findFirst({ where: eq(researchReport.id, candidate.reportId) });
  const blockers: string[] = [];
  if (!report || report.currentRevisionId !== candidate.baseRevisionId) blockers.push("The note has a newer published version than this draft's base");
  const cases = candidate.baseRevisionId ? await activeCasesForRevision(tx, candidate.baseRevisionId) : [];
  const epochVector = cases.map((c) => ({ caseId: c.id, epoch: c.epoch }));
  if (!sameEpochVector(epochVector, candidate.epochVector)) blockers.push("Evidence changed after this draft was prepared");
  const meta = (candidate.noticeDraft ?? {}) as Partial<CandidateMeta>;
  for (const c of cases) {
    const open = await tx.$count(challenge, and(eq(challenge.caseId, c.id), eq(challenge.status, "OPEN")));
    if (open) blockers.push(`${open} open challenge${open > 1 ? "s" : ""} on the case`);
    const impacts = await tx
      .select({ impact: claimImpact, claim })
      .from(claimImpact)
      .innerJoin(claim, eq(claim.id, claimImpact.claimId))
      .where(and(eq(claimImpact.caseId, c.id), eq(claimImpact.reportId, candidate.reportId), eq(claim.revisionId, candidate.baseRevisionId!)));
    for (const { impact, claim: affected } of impacts) {
      if (!affected.material) continue;
      if (affected.category === "QUALITATIVE") {
        if (!meta.rewrittenQualitative?.includes(affected.id)) blockers.push(`"${affected.label}" depends on changed figures and has not been rewritten`);
        continue;
      }
      if (impact.classification === "candidate") {
        if (impact.state !== "UNAFFECTED") blockers.push(`"${affected.label}" is still under review`);
        continue;
      }
      if (!(RESOLVED_STATES as readonly string[]).includes(impact.state)) blockers.push(`"${affected.label}" is ${impact.state.toLowerCase().replace(/_/g, " ")}`);
      else if (impact.state === "VERIFIED_REPLACEMENT" && !meta.patchedBlockIds?.includes(affected.blockId)) blockers.push(`"${affected.label}" still shows the original figure`);
    }
  }
  if (meta.rewrittenQualitative?.length) {
    if (!meta.conclusionReview) blockers.push("The rewritten conclusion has not yet been checked against the corrected figures");
    else if (meta.conclusionReview.verdict !== "consistent") blockers.push(`The Financial Verifier found the rewritten conclusion inconsistent with the corrected figures: ${meta.conclusionReview.explanation}`);
  }
  const claims = await tx.query.claim.findMany({ where: eq(claim.revisionId, candidateId) });
  const tokens = scanNumericTokens(candidate.blocks);
  for (const token of tokens) {
    const covered = claims.some((c) => c.blockId === token.blockId && c.startOffset <= token.start && c.endOffset >= token.end);
    if (!covered) blockers.push(`Figure "${token.text}" in the draft is not tied to verified evidence`);
  }
  return { blockers: [...new Set(blockers)], epochVector };
}

/**
 * Gives each claim of a new revision the incoming dependency edges of the claim it replaces, so a later disclosure
 * about the same figures reaches the current version too. Edges from a claim that was itself carried over point at
 * its new copy; edges from facts and from claims that stayed behind are kept as they are.
 */
async function carryDependencies(tx: Tx, workspaceId: string, carriedOver: Map<string, string>): Promise<void> {
  if (!carriedOver.size) return;
  const edges = await tx.select().from(claimDependency).where(and(eq(claimDependency.workspaceId, workspaceId), inArray(claimDependency.toNode, [...carriedOver.keys()].map((id) => `claim:${id}`))));
  const remap = (node: string) => (node.startsWith("claim:") ? `claim:${carriedOver.get(node.slice(6)) ?? node.slice(6)}` : node);
  for (const edge of edges) {
    await tx.insert(claimDependency).values({ workspaceId, fromNode: remap(edge.fromNode), toNode: remap(edge.toNode), type: edge.type }).onConflictDoNothing();
  }
}

export async function proposeRevisionPatch(ctx: ActorContext, input: PatchInput) {
  return commit(async (tx, record) => {
    const caseRow = await lockCase(tx, ctx.workspaceId, input.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const report = await tx.query.researchReport.findFirst({ where: and(eq(researchReport.id, input.reportId), eq(researchReport.workspaceId, ctx.workspaceId)) });
    assert(report, "NOT_FOUND", "report not found");
    assert(report.currentRevisionId === input.baseRevisionId, "CONFLICT", "the base revision is no longer current", { currentRevisionId: report.currentRevisionId });
    const base = await tx.query.researchRevision.findFirst({ where: eq(researchRevision.id, input.baseRevisionId) });
    assert(base, "NOT_FOUND", "base revision not found");
    assert(input.patches.length > 0 && input.patches.length <= 40, "INVALID_INPUT", "provide between 1 and 40 block patches");
    for (const p of input.patches) assertNoLiteralFigures(p.text, `Patch for block ${p.blockId}`);
    assertNoLiteralFigures(`${input.notice.whatChanged} ${input.notice.why} ${input.notice.conclusions}`, "The notice text");

    const baseClaims = await tx.query.claim.findMany({ where: eq(claim.revisionId, base.id) });
    const claimById = new Map(baseClaims.map((c) => [c.id, c]));
    const verifiedValue = new Map<string, { value: string; factIds: string[]; kind: string }>();
    const resolveText = async (text: string): Promise<{ text: string; refs: { claimId: string; kind: "claim" | "previous"; start: number; end: number }[] }> => {
      let out = "";
      let last = 0;
      const refs: { claimId: string; kind: "claim" | "previous"; start: number; end: number }[] = [];
      for (const match of text.matchAll(PLACEHOLDER)) {
        const kind = match[1] as "claim" | "previous";
        const claimId = match[2]!;
        const original = claimById.get(claimId);
        assert(original, "INVALID_INPUT", `placeholder refers to unknown claim ${claimId}`);
        let value: string | null = original.valueDecimal;
        if (kind === "claim") {
          let resolved = verifiedValue.get(claimId);
          if (!resolved) {
            const proposal = await verifiedReplacement(tx, caseRow.id, caseRow.evidenceEpoch, claimId);
            assert(proposal?.value, "UNVERIFIED_CLAIM", `"${original.label}" has no verified replacement on the current evidence revision`, { claimId });
            resolved = { value: proposal.value, factIds: proposal.factIds, kind: proposal.kind };
            verifiedValue.set(claimId, resolved);
          }
          value = resolved.value;
        }
        assert(value, "INVALID_INPUT", `no value available for ${original.label}`);
        const formatted = formatValue(value, displayFormatFor(original));
        out += text.slice(last, match.index);
        const start = out.length;
        out += formatted;
        refs.push({ claimId, kind, start, end: out.length });
        last = (match.index ?? 0) + match[0].length;
      }
      out += text.slice(last);
      return { text: out, refs };
    };

    const patchByBlock = new Map(input.patches.map((p) => [p.blockId, p.text]));
    for (const blockId of patchByBlock.keys()) assert(base.blocks.some((b) => b.id === blockId), "INVALID_INPUT", `block ${blockId} is not in the base revision`);
    const blocks: Block[] = [];
    const placements: { blockId: string; claimId: string; kind: "claim" | "previous"; start: number; end: number }[] = [];
    const rewrittenQualitative: string[] = [];
    for (const block of base.blocks) {
      const patch = patchByBlock.get(block.id);
      if (patch === undefined) {
        blocks.push(block);
        continue;
      }
      const resolved = await resolveText(patch);
      const id = `${block.id}-r${caseRow.evidenceEpoch}`;
      const next: Block = { ...block, id, text: resolved.text, ...(block.kind === "table" ? { rows: rebuildTableRows(resolved.text) } : {}) };
      blocks.push(next);
      for (const ref of resolved.refs) placements.push({ blockId: id, ...ref });
      for (const c of baseClaims) if (c.blockId === block.id && c.category === "QUALITATIVE" && c.material) rewrittenQualitative.push(c.id);
    }

    const notice = {
      whatChanged: (await resolveText(input.notice.whatChanged)).text,
      why: (await resolveText(input.notice.why)).text,
      conclusions: (await resolveText(input.notice.conclusions)).text,
    };
    const changes: NoticeChange[] = [];
    for (const [claimId, resolved] of verifiedValue) {
      const original = claimById.get(claimId)!;
      const format = displayFormatFor(original);
      changes.push({
        claimId,
        label: original.label,
        previous: formatValue(original.valueDecimal!, format),
        replacement: formatValue(resolved.value, format),
        delta: formatDelta(original.valueDecimal!, resolved.value, format),
        kind: resolved.kind,
        sources: await proposalSources(tx, resolved.factIds),
      });
    }
    const cases = await activeCasesForRevision(tx, base.id);
    const epochVector = cases.map((c) => ({ caseId: c.id, epoch: c.epoch }));
    await tx
      .update(researchRevision)
      .set({ candidateState: "EXPIRED" })
      .where(and(eq(researchRevision.reportId, report.id), eq(researchRevision.documentState, "DRAFT"), inArray(researchRevision.candidateState, ["DRAFT", "CHECKING", "BLOCKED", "READY", "CHANGES_REQUESTED"])));
    const meta: CandidateMeta = { notice, changes, blockers: [], patchedBlockIds: [...patchByBlock.keys()], rewrittenQualitative };
    const markdown = blocksToMarkdown(blocks);
    const [candidate] = await tx
      .insert(researchRevision)
      .values({
        reportId: report.id,
        workspaceId: ctx.workspaceId,
        baseRevisionId: base.id,
        kind: "candidate",
        blocks,
        markdown,
        contentHash: contentHash({ blocks, notice, changes, epochVector, base: base.id }),
        asOf: new Date(),
        sourceRefs: base.sourceRefs,
        epochVector,
        candidateState: "CHECKING",
        documentState: "DRAFT",
        caseId: caseRow.id,
        noticeDraft: meta as unknown as Record<string, unknown>,
        createdBy: ctx.actor.id,
      })
      .returning();
    const carriedOver = new Map<string, string>();
    for (const placement of placements) {
      const original = claimById.get(placement.claimId)!;
      const resolved = verifiedValue.get(placement.claimId);
      const [created] = await tx
        .insert(claim)
        .values({
          revisionId: candidate!.id,
          workspaceId: ctx.workspaceId,
          lineageId: original.lineageId,
          blockId: placement.blockId,
          startOffset: placement.start,
          endOffset: placement.end,
          category: original.category,
          text: blocks.find((b) => b.id === placement.blockId)!.text.slice(placement.start, placement.end),
          label: placement.kind === "previous" ? `${original.label} (as previously reported)` : original.label,
          material: placement.kind === "claim",
          semanticKey: original.semanticKey,
          bindingState: "BOUND",
          formula: original.formula,
          displayPrecision: original.displayPrecision,
          displayUnit: original.displayUnit,
          valueDecimal: placement.kind === "claim" ? resolved!.value : original.valueDecimal,
          reason: placement.kind === "previous" ? "Original figure quoted for comparison" : null,
          creationMethod: "verified_placeholder",
          proposedBy: ctx.actor.id,
        })
        .returning({ id: claim.id });
      if (placement.kind === "claim") {
        carriedOver.set(original.id, created!.id);
        for (const factId of resolved!.factIds) await tx.insert(claimBinding).values({ claimId: created!.id, workspaceId: ctx.workspaceId, kind: "fact", factId, justification: "Verified replacement", createdBy: "case-engine" });
      }
    }
    for (const c of baseClaims) {
      const block = blocks.find((b) => b.id === c.blockId);
      if (!block) {
        if (c.category === "QUALITATIVE" && rewrittenQualitative.includes(c.id)) {
          const newBlockId = `${c.blockId}-r${caseRow.evidenceEpoch}`;
          const text = blocks.find((b) => b.id === newBlockId)?.text ?? "";
          const [rewritten] = await tx.insert(claim).values({ revisionId: candidate!.id, workspaceId: ctx.workspaceId, lineageId: c.lineageId, blockId: newBlockId, startOffset: 0, endOffset: Math.max(1, text.length), category: "QUALITATIVE", text, label: `${c.label} (rewritten)`, material: true, bindingState: "PROPOSED", reason: "Rewritten by the publication editor; needs editorial approval", creationMethod: "editor_rewrite", proposedBy: ctx.actor.id }).returning({ id: claim.id });
          carriedOver.set(c.id, rewritten!.id);
        }
        continue;
      }
      const [copied] = await tx.insert(claim).values({ ...c, id: undefined, revisionId: candidate!.id, createdAt: undefined }).returning({ id: claim.id });
      carriedOver.set(c.id, copied!.id);
    }
    await carryDependencies(tx, ctx.workspaceId, carriedOver);
    const { blockers } = await evaluateCandidate(tx, candidate!.id);
    const state = blockers.length ? "BLOCKED" : "READY";
    await tx.update(researchRevision).set({ candidateState: state, noticeDraft: { ...meta, blockers } as unknown as Record<string, unknown> }).where(eq(researchRevision.id, candidate!.id));
    await record({
      workspaceId: ctx.workspaceId,
      type: "report.revision_prepared",
      actor: ctx.actor,
      caseId: caseRow.id,
      evidenceEpoch: caseRow.evidenceEpoch,
      payload: { candidateId: candidate!.id, reportId: report.id, baseRevisionId: base.id, state, blockers, changes: changes.length, agentRunId: ctx.agentRunId ?? null },
    });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { candidateId: candidate!.id, state, blockers };
  });
}

/** A second participant reads the rewritten conclusions against the verified figures. An inconsistent verdict blocks the draft and challenges the editor. */
export async function reviewConclusions(ctx: ActorContext, input: { candidateId: string; verdict: "consistent" | "inconsistent"; explanation: string }) {
  return commit(async (tx, record) => {
    const [candidate] = await tx.select().from(researchRevision).where(and(eq(researchRevision.id, input.candidateId), eq(researchRevision.workspaceId, ctx.workspaceId))).for("update");
    assert(candidate && candidate.kind === "candidate" && candidate.caseId, "NOT_FOUND", "draft not found");
    assert(candidate.candidateState === "READY" || candidate.candidateState === "BLOCKED" || candidate.candidateState === "CHECKING", "CONFLICT", `draft is ${candidate.candidateState}`);
    assert(candidate.createdBy !== ctx.actor.id, "SELF_VERIFICATION", "the author of a draft cannot review its conclusions");
    const caseRow = await lockCase(tx, ctx.workspaceId, candidate.caseId);
    guardEpoch(ctx, caseRow.evidenceEpoch);
    const meta = candidate.noticeDraft as unknown as CandidateMeta;
    const review: ConclusionReview = { verdict: input.verdict, explanation: input.explanation.slice(0, 1200), reviewer: ctx.actor.id, epoch: caseRow.evidenceEpoch, at: new Date().toISOString() };
    const nextMeta = { ...meta, conclusionReview: review };
    await tx.update(researchRevision).set({ noticeDraft: nextMeta as unknown as Record<string, unknown> }).where(eq(researchRevision.id, candidate.id));
    if (input.verdict === "consistent") {
      await tx.update(challenge).set({ status: "RESOLVED", resolution: `Conclusions in draft ${candidate.id} checked as consistent`, resolvedAt: new Date() }).where(and(eq(challenge.caseId, caseRow.id), eq(challenge.targetKind, "candidate_conclusion"), eq(challenge.status, "OPEN")));
    }
    const { blockers } = await evaluateCandidate(tx, candidate.id);
    await tx.update(researchRevision).set({ candidateState: blockers.length ? "BLOCKED" : "READY", noticeDraft: { ...nextMeta, blockers } as unknown as Record<string, unknown> }).where(eq(researchRevision.id, candidate.id));
    if (input.verdict === "inconsistent") {
      const [raised] = await tx
        .insert(challenge)
        .values({ workspaceId: ctx.workspaceId, caseId: caseRow.id, targetKind: "candidate_conclusion", targetId: candidate.id, epoch: caseRow.evidenceEpoch, raisedBy: ctx.actor.id, reasonCode: "CONCLUSION_INCONSISTENT", explanation: review.explanation, refs: [candidate.id], status: "OPEN" })
        .returning();
      await record({ workspaceId: ctx.workspaceId, type: "challenge.raised", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { challengeId: raised!.id, targetKind: "candidate_conclusion", targetId: candidate.id, reportId: candidate.reportId, reasonCode: "CONCLUSION_INCONSISTENT", explanation: review.explanation.slice(0, 500) } });
    }
    await record({ workspaceId: ctx.workspaceId, type: "report.conclusions_reviewed", actor: ctx.actor, caseId: caseRow.id, evidenceEpoch: caseRow.evidenceEpoch, payload: { candidateId: candidate.id, reportId: candidate.reportId, verdict: input.verdict, explanation: review.explanation.slice(0, 400), agentRunId: ctx.agentRunId ?? null } });
    await recomputeCaseStatus(tx, caseRow.id, record);
    return { verdict: input.verdict, blockers };
  });
}

export interface ReviewInput {
  candidateId: string;
  decision: "approve" | "request_changes";
  contentHash: string;
  epochVector: { caseId: string; epoch: number }[];
  notes?: string;
}

export async function reviewCandidate(ctx: ActorContext & { actorName: string; principalId: string }, input: ReviewInput) {
  return commit(async (tx, record) => {
    const [candidate] = await tx.select().from(researchRevision).where(and(eq(researchRevision.id, input.candidateId), eq(researchRevision.workspaceId, ctx.workspaceId))).for("update");
    assert(candidate && candidate.kind === "candidate", "NOT_FOUND", "draft not found");
    assert(candidate.contentHash === input.contentHash, "CONFLICT", "the draft changed after you opened it");
    assert(sameEpochVector(candidate.epochVector, input.epochVector), "APPROVAL_EXPIRED", "evidence changed after you opened this draft");
    const { blockers, epochVector } = await evaluateCandidate(tx, candidate.id);
    if (input.decision === "approve") {
      assert(blockers.length === 0, "BLOCKED", "the draft has unresolved blockers", { blockers });
      assert(candidate.candidateState === "READY", "CONFLICT", `draft is ${candidate.candidateState?.toLowerCase()}`);
    }
    const [review] = await tx
      .insert(editorialReview)
      .values({ workspaceId: ctx.workspaceId, candidateId: candidate.id, actorId: ctx.principalId, actorName: ctx.actorName, decision: input.decision, contentHash: candidate.contentHash, epochVector, baseRevisionId: candidate.baseRevisionId!, notes: input.notes?.slice(0, 2000) ?? null })
      .returning();
    await tx
      .update(researchRevision)
      .set({ candidateState: input.decision === "approve" ? "APPROVED" : "CHANGES_REQUESTED", approvalId: input.decision === "approve" ? review!.id : null })
      .where(eq(researchRevision.id, candidate.id));
    await record({
      workspaceId: ctx.workspaceId,
      type: input.decision === "approve" ? "report.approved" : "report.changes_requested",
      actor: ctx.actor,
      caseId: candidate.caseId,
      payload: { candidateId: candidate.id, reportId: candidate.reportId, reviewId: review!.id, notes: input.notes?.slice(0, 500) ?? null },
    });
    if (candidate.caseId) await recomputeCaseStatus(tx, candidate.caseId, record);
    return { reviewId: review!.id, decision: input.decision };
  });
}

export interface ReissueInput {
  candidateId: string;
  approvalId: string;
  candidateHash: string;
  expectedBaseRevisionId: string;
  evidenceEpochs: { caseId: string; epoch: number }[];
}

export async function reissue(ctx: ActorContext & { actorName: string }, input: ReissueInput) {
  return commit(async (tx, record) => {
    const [candidate] = await tx.select().from(researchRevision).where(and(eq(researchRevision.id, input.candidateId), eq(researchRevision.workspaceId, ctx.workspaceId))).for("update");
    assert(candidate && candidate.kind === "candidate", "NOT_FOUND", "draft not found");
    const [report] = await tx.select().from(researchReport).where(eq(researchReport.id, candidate.reportId)).for("update");
    assert(report, "NOT_FOUND", "report not found");
    const caseIds = [...input.evidenceEpochs.map((e) => e.caseId)].sort();
    for (const caseId of caseIds) await lockCase(tx, ctx.workspaceId, caseId);
    assert(report.currentRevisionId === input.expectedBaseRevisionId && candidate.baseRevisionId === input.expectedBaseRevisionId, "CONFLICT", "the published version changed; open the latest draft");
    assert(candidate.contentHash === input.candidateHash, "CONFLICT", "the draft changed after approval");
    assert(candidate.candidateState === "APPROVED", "APPROVAL_EXPIRED", "the draft is not approved");
    const approval = await tx.query.editorialReview.findFirst({ where: eq(editorialReview.id, input.approvalId) });
    assert(approval?.valid && approval.decision === "approve" && approval.candidateId === candidate.id && approval.contentHash === candidate.contentHash, "APPROVAL_EXPIRED", "the approval no longer matches this draft");
    const { blockers, epochVector } = await evaluateCandidate(tx, candidate.id);
    assert(sameEpochVector(epochVector, input.evidenceEpochs) && sameEpochVector(epochVector, approval.epochVector), "STALE_EVIDENCE", "evidence changed after approval", { epochVector });
    assert(blockers.length === 0, "UNVERIFIED_CLAIM", "the draft has unresolved blockers", { blockers });

    const base = (await tx.query.researchRevision.findFirst({ where: eq(researchRevision.id, candidate.baseRevisionId!) }))!;
    const version = (base.version ?? 0) + 1;
    const publishedAt = new Date();
    await tx.update(researchRevision).set({ documentState: "SUPERSEDED" }).where(eq(researchRevision.id, base.id));
    await tx.update(researchRevision).set({ version, documentState: "PUBLISHED", candidateState: "PUBLISHED", publishedAt, kind: "published", publicationLabel: "Reissued in this demo workspace" }).where(eq(researchRevision.id, candidate.id));
    const otherWarnings = await tx.$count(reportWarning, and(eq(reportWarning.revisionId, candidate.id), eq(reportWarning.state, "ACTIVE")));
    const heading = candidate.blocks.find((b) => b.kind === "heading");
    await tx.update(researchReport).set({ title: heading?.text.slice(0, 200) ?? report.title, currentRevisionId: candidate.id, reliability: otherWarnings ? "UNDER_REVIEW" : "CLEAR", documentState: "PUBLISHED", updatedAt: publishedAt, rowVersion: report.rowVersion + 1 }).where(eq(researchReport.id, report.id));
    await tx.insert(publicationStatusEvent).values({ workspaceId: ctx.workspaceId, reportId: report.id, revisionId: base.id, type: "SUPERSEDED", caseId: candidate.caseId, actor: ctx.actor.id, reason: `Superseded by version ${version}` });
    await tx.insert(publicationStatusEvent).values({ workspaceId: ctx.workspaceId, reportId: report.id, revisionId: candidate.id, type: "REISSUED", caseId: candidate.caseId, actor: ctx.actor.id, reason: `Version ${version} approved by ${ctx.actorName}` });
    const meta = candidate.noticeDraft as unknown as CandidateMeta;
    await tx
      .update(claimImpact)
      .set({ state: "VERIFIED_REPLACEMENT", updatedAt: publishedAt })
      .where(and(inArray(claimImpact.claimId, meta.rewrittenQualitative.length ? meta.rewrittenQualitative : ["00000000-0000-0000-0000-000000000000"]), eq(claimImpact.state, "INVALIDATED")));
    const cases = await tx.select().from(correctionCase).where(inArray(correctionCase.id, caseIds));
    const body = {
      reportTitle: report.title,
      issuerCiks: report.issuerCiks,
      previousVersion: base.version,
      replacementVersion: version,
      whatChanged: meta.notice.whatChanged,
      why: meta.notice.why,
      conclusions: meta.notice.conclusions,
      changes: meta.changes,
      cases: cases.map((c) => ({ id: c.id, title: c.title, periods: c.scope?.periods ?? [] })),
      approvedBy: ctx.actorName,
      approvedAt: publishedAt.toISOString(),
      disclaimer: "Not financial advice. Synthetic research note reissued in an Errata demo workspace from public SEC filings.",
    };
    const [notice] = await tx
      .insert(correctionNotice)
      .values({ workspaceId: ctx.workspaceId, reportId: report.id, previousRevisionId: base.id, replacementRevisionId: candidate.id, caseIds, type: "CORRECTION", body, contentHash: contentHash(body), approvalId: approval.id, publishedAt })
      .returning();
    const recipients = await tx.select().from(publicationRecipient).where(and(eq(publicationRecipient.reportId, report.id), eq(publicationRecipient.active, true)));
    for (const recipient of recipients) {
      const logicalKey = `notice:${notice!.id}:${recipient.recipientId}`;
      const [queued] = await tx
        .insert(delivery)
        .values({ workspaceId: ctx.workspaceId, noticeId: notice!.id, revisionId: candidate.id, recipientId: recipient.recipientId, kind: "correction_notice", subject: `Correction: ${report.title}`, logicalKey, status: "QUEUED" })
        .onConflictDoNothing()
        .returning();
      if (queued) await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: "deliver", dedupeKey: `deliver:${queued.id}:1`, payload: { deliveryId: queued.id } });
    }
    for (const format of ["markdown", "pdf", "docx"]) {
      await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: "export_artifact", dedupeKey: `export:${candidate.id}:${format}`, payload: { revisionId: candidate.id, format } });
      await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: "export_artifact", dedupeKey: `export:notice:${notice!.id}:${format}`, payload: { noticeId: notice!.id, format } });
    }
    await record({
      workspaceId: ctx.workspaceId,
      type: "report.reissued",
      actor: ctx.actor,
      caseId: candidate.caseId,
      payload: { reportId: report.id, publicId: report.publicId, previousRevisionId: base.id, revisionId: candidate.id, version, noticeId: notice!.id, queuedDeliveries: recipients.length },
    });
    for (const c of cases) await recomputeCaseStatus(tx, c.id, record);
    return { revisionId: candidate.id, version, publicId: report.publicId, noticeId: notice!.id, queuedDeliveries: recipients.length, epochVector };
  });
}

export async function withdrawReport(ctx: ActorContext & { actorName: string }, input: { reportId: string; expectedRevisionId: string; reason: string }) {
  return commit(async (tx, record) => {
    const [report] = await tx.select().from(researchReport).where(and(eq(researchReport.id, input.reportId), eq(researchReport.workspaceId, ctx.workspaceId))).for("update");
    assert(report, "NOT_FOUND", "report not found");
    assert(report.currentRevisionId === input.expectedRevisionId, "CONFLICT", "the published version changed");
    assert(report.documentState !== "WITHDRAWN", "CONFLICT", "the note is already withdrawn");
    assert(input.reason.trim().length >= 10, "INVALID_INPUT", "give a reason of at least ten characters");
    await tx.update(researchReport).set({ documentState: "WITHDRAWN", reliability: "WITHDRAWN", updatedAt: new Date(), rowVersion: report.rowVersion + 1 }).where(eq(researchReport.id, report.id));
    await tx.insert(publicationStatusEvent).values({ workspaceId: ctx.workspaceId, reportId: report.id, revisionId: report.currentRevisionId, type: "WITHDRAWN", actor: ctx.actor.id, reason: input.reason.slice(0, 1000) });
    const caseRows = report.currentRevisionId ? await activeCasesForRevision(tx, report.currentRevisionId) : [];
    const body = { reportTitle: report.title, issuerCiks: report.issuerCiks, previousVersion: null, replacementVersion: null, whatChanged: "This note has been withdrawn.", why: input.reason.slice(0, 1000), conclusions: "The conclusions in the withdrawn note should not be relied upon.", changes: [], cases: caseRows.map((c) => ({ id: c.id })), approvedBy: ctx.actorName, approvedAt: new Date().toISOString(), disclaimer: "Not financial advice. Synthetic research note in an Errata demo workspace." };
    const [notice] = await tx
      .insert(correctionNotice)
      .values({ workspaceId: ctx.workspaceId, reportId: report.id, previousRevisionId: report.currentRevisionId!, replacementRevisionId: null, caseIds: caseRows.map((c) => c.id), type: "WITHDRAWAL", body, contentHash: contentHash(body), publishedAt: new Date() })
      .returning();
    await record({ workspaceId: ctx.workspaceId, type: "report.withdrawn", actor: ctx.actor, payload: { reportId: report.id, revisionId: report.currentRevisionId, noticeId: notice!.id, reason: input.reason.slice(0, 300) } });
    for (const c of caseRows) await recomputeCaseStatus(tx, c.id, record);
    return { noticeId: notice!.id };
  });
}

export async function latestCandidate(tx: DbOrTx, reportId: string) {
  return tx.query.researchRevision.findFirst({
    where: and(eq(researchRevision.reportId, reportId), eq(researchRevision.kind, "candidate"), ne(researchRevision.candidateState, "EXPIRED")),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
