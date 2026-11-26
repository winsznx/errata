import { and, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/client.js";
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
  sourceLocator,
  syntheticRecipient,
  toolCall,
} from "../db/schema.js";
import { computeFormula, displayDecimal, formulaRefs, type FormulaInput, type FormulaNode, FORMULA_SCHEMA } from "../formula/engine.js";
import { parseDisplayedNumber } from "../parsing/numbers.js";
import type { ActorContext } from "./cases.js";
import { contentHash, parseMarkdown, scanNumericTokens } from "./document.js";
import { eligibleSource } from "./eligibility.js";
import { DomainError, assert } from "./errors.js";
import { commit } from "./events.js";
import { resolveLocator, sameDecimal } from "./locator.js";
import { randomId } from "./workspace.js";

export interface DraftInput {
  title: string;
  issuerCiks: string[];
  asOf: string;
  sourceIds: string[];
  markdown: string;
}

function validateText(markdown: string): void {
  assert(markdown.trim().length >= 20, "INVALID_INPUT", "the note is empty");
  assert(!/\u0000/.test(markdown), "INVALID_INPUT", "binary content is not supported; paste or upload UTF-8 text or Markdown");
}

async function checkSources(workspaceId: string, sourceIds: string[], asOf: Date): Promise<void> {
  assert(sourceIds.length <= 10, "INVALID_INPUT", "cite at most 10 source documents");
  for (const sourceId of sourceIds) {
    const source = await eligibleSource(db, workspaceId, sourceId);
    const accepted = source.acceptedAt ?? new Date(`${source.filedDate}T23:59:59Z`);
    assert(accepted <= asOf, "INELIGIBLE_SOURCE", `${source.form} ${source.accession} was not public on the note's as-of date`);
  }
}

export async function createDraft(ctx: ActorContext, input: DraftInput) {
  validateText(input.markdown);
  const asOf = new Date(input.asOf);
  assert(!Number.isNaN(asOf.getTime()), "INVALID_INPUT", "as-of date is invalid");
  await checkSources(ctx.workspaceId, input.sourceIds, asOf);
  const blocks = parseMarkdown(input.markdown);
  const tokens = scanNumericTokens(blocks);
  assert(tokens.length <= 100, "INVALID_INPUT", "a note can carry at most 100 figures");
  return commit(async (tx, record) => {
    const [report] = await tx.insert(researchReport).values({ workspaceId: ctx.workspaceId, publicId: randomId(8), title: input.title.trim().slice(0, 200), issuerCiks: input.issuerCiks, documentState: "DRAFT", reliability: "CLEAR", synthetic: true, publisherName: "Ledgerline Research" }).returning();
    const [revision] = await tx
      .insert(researchRevision)
      .values({ reportId: report!.id, workspaceId: ctx.workspaceId, kind: "draft", blocks, markdown: input.markdown, contentHash: contentHash({ blocks }), asOf, sourceRefs: input.sourceIds, documentState: "DRAFT", candidateState: "DRAFT", createdBy: ctx.actor.id })
      .returning();
    await tx.update(researchReport).set({ currentRevisionId: revision!.id }).where(eq(researchReport.id, report!.id));
    await record({ workspaceId: ctx.workspaceId, type: "report.draft_created", actor: ctx.actor, payload: { reportId: report!.id, revisionId: revision!.id, figures: tokens.length } });
    return { reportId: report!.id, revisionId: revision!.id, figures: tokens.length };
  });
}

export async function updateDraft(ctx: ActorContext, input: { reportId: string; baseRevisionId: string; markdown: string; expectedHash: string }) {
  validateText(input.markdown);
  return commit(async (tx, record) => {
    const [report] = await tx.select().from(researchReport).where(and(eq(researchReport.id, input.reportId), eq(researchReport.workspaceId, ctx.workspaceId))).for("update");
    assert(report && report.documentState === "DRAFT", "CONFLICT", "only unpublished drafts can be edited here; published notes change through correction drafts");
    assert(report.currentRevisionId === input.baseRevisionId, "CONFLICT", "the draft changed in another tab");
    const base = (await tx.query.researchRevision.findFirst({ where: eq(researchRevision.id, input.baseRevisionId) }))!;
    assert(base.contentHash === input.expectedHash, "CONFLICT", "the draft changed in another tab");
    const blocks = parseMarkdown(input.markdown);
    const [revision] = await tx
      .insert(researchRevision)
      .values({ reportId: report.id, workspaceId: ctx.workspaceId, baseRevisionId: base.id, kind: "draft", blocks, markdown: input.markdown, contentHash: contentHash({ blocks }), asOf: base.asOf, sourceRefs: base.sourceRefs, documentState: "DRAFT", candidateState: "DRAFT", createdBy: ctx.actor.id })
      .returning();
    await tx.update(researchRevision).set({ candidateState: "EXPIRED" }).where(eq(researchRevision.id, base.id));
    await tx.update(researchReport).set({ currentRevisionId: revision!.id, updatedAt: new Date() }).where(eq(researchReport.id, report.id));
    await record({ workspaceId: ctx.workspaceId, type: "report.draft_updated", actor: ctx.actor, payload: { reportId: report.id, revisionId: revision!.id, invalidatedClaims: true } });
    return { revisionId: revision!.id };
  });
}

function displayScaleOf(text: string): number {
  if (/\bthousand\b/i.test(text)) return 3;
  if (/\bmillion\b/i.test(text)) return 6;
  if (/\bbillion\b/i.test(text)) return 9;
  return 0;
}

function shownValue(text: string): string | null {
  const parsed = parseDisplayedNumber(text.replace(/\s*(thousand|million|billion)$/i, ""));
  if (parsed.kind !== "number") return null;
  return parsed.value.times(new Decimal(10).pow(displayScaleOf(text))).toFixed();
}

export interface ClaimProposal {
  revisionId: string;
  blockId: string;
  start: number;
  end: number;
  category: "DIRECT" | "DERIVED" | "QUALITATIVE" | "OTHER";
  label: string;
  material: boolean;
  factId?: string | null;
  formula?: unknown;
  dependsOn?: string[];
  reason?: string | null;
}

/** Records a proposed claim. Code checks the span, the figure against the cited fact, and point-in-time eligibility; it is never BOUND until verified. */
export async function proposeClaim(ctx: ActorContext, input: ClaimProposal) {
  return commit(async (tx, record) => {
    const [revision] = await tx.select().from(researchRevision).where(and(eq(researchRevision.id, input.revisionId), eq(researchRevision.workspaceId, ctx.workspaceId))).for("update");
    assert(revision && revision.kind === "draft" && revision.candidateState === "DRAFT", "CONFLICT", "claims can only be added to the current draft");
    const block = revision.blocks.find((b) => b.id === input.blockId);
    assert(block, "INVALID_INPUT", "unknown block");
    assert(input.start >= 0 && input.end > input.start && input.end <= block.text.length, "INVALID_INPUT", "span is outside the block");
    const text = block.text.slice(input.start, input.end);
    const existing = await tx.query.claim.findMany({ where: eq(claim.revisionId, revision.id) });
    assert(!existing.some((c) => c.blockId === input.blockId && c.startOffset < input.end && c.endOffset > input.start), "CONFLICT", "another claim already covers part of this span");

    let valueDecimal: string | null = null;
    let semanticKey: string | null = null;
    let displayUnit: string | null = null;
    let displayPrecision: number | null = null;
    let formula: FormulaNode | null = null;
    if (input.category === "DIRECT") {
      assert(input.factId, "INVALID_INPUT", "a direct claim must cite a fact");
      const [fact] = await tx.select().from(financialFact).where(eq(financialFact.id, input.factId));
      assert(fact?.value, "NOT_FOUND", "fact not found");
      assert(revision.sourceRefs.includes(fact.sourceId), "INVALID_INPUT", "cite a fact from one of the note's declared sources");
      const shown = shownValue(text);
      assert(shown !== null, "INVALID_INPUT", `"${text}" is not a figure`);
      assert(sameDecimal(shown, fact.value), "INVALID_INPUT", `the note shows ${shown} but the cited fact is ${new Decimal(fact.value).toFixed()}`);
      valueDecimal = new Decimal(fact.value).toFixed();
      semanticKey = fact.semanticKey;
      displayUnit = fact.unit;
      displayPrecision = 0;
    }
    if (input.category === "DERIVED") {
      const parsed = FORMULA_SCHEMA.safeParse(input.formula);
      assert(parsed.success, "INVALID_INPUT", "formula is not a valid expression tree");
      formula = parsed.data;
      const inputs: FormulaInput[] = [];
      for (const ref of formulaRefs(formula)) {
        const source = existing.find((c) => c.id === ref);
        assert(source?.valueDecimal, "INVALID_INPUT", `formula input ${ref} must be an existing claim in this draft`);
        const [binding] = await tx.select({ fact: financialFact }).from(claimBinding).innerJoin(financialFact, eq(financialFact.id, claimBinding.factId)).where(eq(claimBinding.claimId, ref));
        inputs.push({ ref, value: source.valueDecimal, unit: source.displayUnit ?? "USD", periodEnd: binding?.fact.periodEnd ?? "", issuerCik: binding?.fact.issuerCik ?? "" });
      }
      const result = computeFormula(formula, inputs);
      assert(result.ok, "INVALID_INPUT", result.ok ? "" : result.message);
      const decimals = (text.split(".")[1] ?? "").replace(/\D/g, "").length;
      const shown = result.unit === "pure" ? text.trim() : shownValue(text);
      const expected = result.unit === "pure" ? displayDecimal(result.value, decimals) : displayDecimal(new Decimal(result.value).toFixed(), 0);
      assert(shown === expected || sameDecimal(shown, displayDecimal(result.value, decimals)), "INVALID_INPUT", `the note shows ${text} but the formula gives ${displayDecimal(result.value, decimals)}`);
      valueDecimal = result.value;
      displayUnit = result.unit;
      displayPrecision = decimals;
    }
    if (input.category === "QUALITATIVE") assert((input.dependsOn ?? []).every((id) => existing.some((c) => c.id === id)), "INVALID_INPUT", "a conclusion can only depend on claims in this draft");
    if (input.category === "OTHER") assert((input.reason ?? "").length >= 5 && !input.material, "INVALID_INPUT", "non-financial text needs a reason and cannot be material");

    const [created] = await tx
      .insert(claim)
      .values({ revisionId: revision.id, workspaceId: ctx.workspaceId, lineageId: crypto.randomUUID(), blockId: input.blockId, startOffset: input.start, endOffset: input.end, category: input.category, text, label: input.label.slice(0, 160), material: input.material, semanticKey, bindingState: input.category === "OTHER" ? "UNMAPPED" : "PROPOSED", formula, displayPrecision, displayUnit, valueDecimal, reason: input.reason ?? null, creationMethod: ctx.actor.kind === "agent" ? "agent_extraction" : "manual_mapping", proposedBy: ctx.actor.id })
      .returning();
    if (input.factId) {
      await tx.insert(claimBinding).values({ claimId: created!.id, workspaceId: ctx.workspaceId, kind: "fact", factId: input.factId, justification: `Proposed by ${ctx.actor.id}`, createdBy: ctx.actor.id });
      const [fact] = await tx.select().from(financialFact).where(eq(financialFact.id, input.factId));
      await tx.insert(claimDependency).values({ workspaceId: ctx.workspaceId, fromNode: `fact:${fact!.semanticKey}`, toNode: `claim:${created!.id}`, type: "CITES" }).onConflictDoNothing();
    }
    for (const ref of formula ? formulaRefs(formula) : []) {
      await tx.insert(claimBinding).values({ claimId: created!.id, workspaceId: ctx.workspaceId, kind: "derived_input", refClaimId: ref, justification: "Formula input", createdBy: ctx.actor.id });
      await tx.insert(claimDependency).values({ workspaceId: ctx.workspaceId, fromNode: `claim:${ref}`, toNode: `claim:${created!.id}`, type: "DERIVES_FROM" }).onConflictDoNothing();
    }
    for (const ref of input.dependsOn ?? []) {
      await tx.insert(claimBinding).values({ claimId: created!.id, workspaceId: ctx.workspaceId, kind: "qualifies", refClaimId: ref, justification: "Conclusion relies on this figure", createdBy: ctx.actor.id });
      await tx.insert(claimDependency).values({ workspaceId: ctx.workspaceId, fromNode: `claim:${ref}`, toNode: `claim:${created!.id}`, type: "QUALIFIES" }).onConflictDoNothing();
    }
    await record({ workspaceId: ctx.workspaceId, type: "claim.proposed", actor: ctx.actor, payload: { claimId: created!.id, revisionId: revision.id, category: input.category, label: input.label, text } });
    return { claimId: created!.id };
  });
}

/** The verifier re-reads the cited location itself; code checks the bytes, the value and that the read happened in this run. */
export async function confirmBinding(ctx: ActorContext, input: { claimId: string; locatorId: string | null; value: string | null; verdict: "confirm" | "reject"; reason: string }) {
  return commit(async (tx, record) => {
    const [row] = await tx.select().from(claim).where(and(eq(claim.id, input.claimId), eq(claim.workspaceId, ctx.workspaceId))).for("update");
    assert(row && row.bindingState === "PROPOSED", "CONFLICT", "only proposed claims can be checked");
    assert(row.proposedBy !== ctx.actor.id, "SELF_VERIFICATION", "a participant cannot confirm its own mapping");
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    if (row.category === "DIRECT") {
      const [binding] = await tx.select({ fact: financialFact }).from(claimBinding).innerJoin(financialFact, eq(financialFact.id, claimBinding.factId)).where(eq(claimBinding.claimId, row.id));
      const locator = input.locatorId ? await tx.query.sourceLocator.findFirst({ where: eq(sourceLocator.id, input.locatorId) }) : null;
      const reads = ctx.agentRunId ? await tx.select({ refs: toolCall.sourceRefs }).from(toolCall).where(and(eq(toolCall.agentRunId, ctx.agentRunId), eq(toolCall.toolName, "read_source_excerpt"), eq(toolCall.ok, true))) : [];
      const readIt = ctx.actor.kind === "human" || reads.some((r) => r.refs.includes(input.locatorId ?? ""));
      checks.push({ name: "independent_read", ok: readIt, detail: readIt ? "excerpt read in this run" : "excerpt was not read in this run" });
      if (locator && binding) {
        const source = await eligibleSource(tx, ctx.workspaceId, locator.sourceId);
        const resolved = await resolveLocator(source, locator);
        const factsAtLocator = await tx.select().from(financialFact).where(eq(financialFact.locatorId, locator.id));
        checks.push({ name: "locator_resolves", ok: resolved.ok, detail: resolved.detail });
        checks.push({ name: "same_identity", ok: factsAtLocator.some((f) => f.semanticKey === binding.fact.semanticKey), detail: binding.fact.conceptId });
        checks.push({ name: "value_matches", ok: sameDecimal(resolved.value, binding.fact.value) && sameDecimal(input.value, binding.fact.value), detail: `source ${resolved.value}, verifier ${input.value}` });
      } else checks.push({ name: "locator_exists", ok: false, detail: "no locator cited" });
    } else if (row.category === "DERIVED") {
      const inputs = await tx.select({ ref: claim }).from(claimBinding).innerJoin(claim, eq(claim.id, claimBinding.refClaimId)).where(and(eq(claimBinding.claimId, row.id), eq(claimBinding.kind, "derived_input")));
      checks.push({ name: "inputs_bound", ok: inputs.every((i) => i.ref.bindingState === "BOUND"), detail: `${inputs.length} inputs` });
      checks.push({ name: "value_matches", ok: sameDecimal(input.value, row.valueDecimal), detail: `verifier ${input.value}` });
    } else {
      const deps = await tx.select({ ref: claim }).from(claimBinding).innerJoin(claim, eq(claim.id, claimBinding.refClaimId)).where(eq(claimBinding.claimId, row.id));
      checks.push({ name: "dependencies_bound", ok: deps.every((d) => d.ref.bindingState === "BOUND"), detail: `${deps.length} dependencies` });
    }
    const confirmed = input.verdict === "confirm" && checks.every((c) => c.ok);
    await tx.update(claim).set({ bindingState: confirmed ? "BOUND" : "AMBIGUOUS", reason: confirmed ? row.reason : `${input.reason.slice(0, 300)} (${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")})` }).where(eq(claim.id, row.id));
    await record({ workspaceId: ctx.workspaceId, type: confirmed ? "claim.binding_confirmed" : "claim.binding_rejected", actor: ctx.actor, payload: { claimId: row.id, revisionId: row.revisionId, checks, agentRunId: ctx.agentRunId ?? null } });
    return { confirmed, checks };
  });
}

export async function draftReadiness(revisionId: string) {
  const revision = await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, revisionId) });
  assert(revision, "NOT_FOUND", "draft not found");
  const claims = await db.select().from(claim).where(eq(claim.revisionId, revisionId));
  const blockers: string[] = [];
  for (const token of scanNumericTokens(revision.blocks)) {
    const covering = claims.find((c) => c.blockId === token.blockId && c.startOffset <= token.start && c.endOffset >= token.end);
    if (!covering) blockers.push(`Figure "${token.text}" is not mapped to evidence`);
    else if (covering.category !== "OTHER" && covering.bindingState !== "BOUND") blockers.push(`"${covering.label}" is ${covering.bindingState.toLowerCase()}`);
  }
  for (const c of claims) if (c.material && c.category === "QUALITATIVE" && c.bindingState !== "BOUND") blockers.push(`"${c.label}" is ${c.bindingState.toLowerCase()}`);
  return { blockers: [...new Set(blockers)], claims: claims.length };
}

export async function publishInitial(ctx: ActorContext & { actorName: string }, input: { revisionId: string; contentHash: string }) {
  return commit(async (tx, record) => {
    const [revision] = await tx.select().from(researchRevision).where(and(eq(researchRevision.id, input.revisionId), eq(researchRevision.workspaceId, ctx.workspaceId))).for("update");
    assert(revision && revision.kind === "draft" && revision.candidateState === "DRAFT", "CONFLICT", "this draft cannot be published");
    assert(revision.contentHash === input.contentHash, "CONFLICT", "the draft changed after you opened it");
    const [report] = await tx.select().from(researchReport).where(eq(researchReport.id, revision.reportId)).for("update");
    assert(report?.currentRevisionId === revision.id && report.documentState === "DRAFT", "CONFLICT", "this is not the current draft");
    const { blockers } = await draftReadiness(revision.id);
    if (blockers.length) throw new DomainError("UNVERIFIED_CLAIM", "every figure must be mapped and verified before publication", { blockers });
    const publishedAt = new Date();
    await tx.update(researchRevision).set({ version: 1, kind: "published", documentState: "PUBLISHED", candidateState: "PUBLISHED", publishedAt, publicationLabel: "Published in this demo workspace" }).where(eq(researchRevision.id, revision.id));
    await tx.update(researchReport).set({ documentState: "PUBLISHED", updatedAt: publishedAt }).where(eq(researchReport.id, report.id));
    await tx.insert(publicationStatusEvent).values({ workspaceId: ctx.workspaceId, reportId: report.id, revisionId: revision.id, type: "PUBLISHED", actor: ctx.actor.id, reason: `Version 1 approved by ${ctx.actorName}` });
    const recipients = await tx.select().from(syntheticRecipient).where(eq(syntheticRecipient.workspaceId, ctx.workspaceId));
    for (const r of recipients) {
      await tx.insert(publicationRecipient).values({ reportId: report.id, recipientId: r.id, originalVersion: 1 }).onConflictDoNothing();
      await tx.insert(delivery).values({ workspaceId: ctx.workspaceId, revisionId: revision.id, recipientId: r.id, kind: "publication", subject: report.title, logicalKey: `publication:${revision.id}:${r.id}`, status: "SIMULATED_DELIVERED", attemptCount: 1, deliveredAt: publishedAt }).onConflictDoNothing();
    }
    await record({ workspaceId: ctx.workspaceId, type: "report.published", actor: ctx.actor, payload: { reportId: report.id, revisionId: revision.id, version: 1, publicId: report.publicId, recipients: recipients.length } });
    return { publicId: report.publicId, version: 1 };
  });
}

export async function draftClaimsNeedingCheck(revisionId: string) {
  return db.select().from(claim).where(and(eq(claim.revisionId, revisionId), inArray(claim.bindingState, ["PROPOSED"])));
}
