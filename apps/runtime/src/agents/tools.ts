import type { Tool } from "@mozaik-ai/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ENV } from "../config/env.js";
import { db } from "../db/client.js";
import { agentRun, correctionCase, toolCall, workspace } from "../db/schema.js";
import { checkDisclosureScope, linkAmendment, proposeDisclosureScope, type ActorContext } from "../domain/cases.js";
import { findFactCandidates, proposeReplacement, raiseChallenge, submitVerification, verifiedInputs } from "../domain/claims-work.js";
import { DomainError } from "../domain/errors.js";
import { commit } from "../domain/events.js";
import { proposeRevisionPatch, reviewConclusions } from "../domain/publication.js";
import { caseSummary, listEligibleFilings, openCasesForIssuer, proposalForVerifier, readExcerpt, reportForEditing, sourceSections } from "../domain/reads.js";
import type { ScenarioFault } from "../domain/scenarios.js";
import { proposeWarningText } from "../domain/warnings.js";
import { confirmBinding, draftReadiness, proposeClaim } from "../domain/intake.js";
import { scanNumericTokens } from "../domain/document.js";
import { researchRevision, financialFact, sourceDocument } from "../db/schema.js";
import { and, ilike, inArray, or } from "drizzle-orm";
import { computeFormula } from "../formula/engine.js";
import type { AgentRole } from "./prompts.js";

export interface ToolContext {
  workspaceId: string;
  role: AgentRole;
  taskKind?: string;
  agentRunId: string;
  caseId: string | null;
  epoch: number | null;
  faults: ScenarioFault[];
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

const PERIOD = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["instant", "duration"]),
  label: z.string().min(2).max(80),
});

const PERIOD_JSON_SCHEMA = {
  type: "object",
  properties: {
    start: { type: ["string", "null"], description: "YYYY-MM-DD, null for an instant" },
    end: { type: "string", description: "YYYY-MM-DD" },
    type: { type: "string", enum: ["instant", "duration"] },
    label: { type: "string", description: "How the filing names the period, e.g. Quarter ended March 31, 2025" },
  },
  required: ["start", "end", "type", "label"],
  additionalProperties: false,
};

function actor(ctx: ToolContext): ActorContext {
  return { workspaceId: ctx.workspaceId, actor: { kind: "agent", id: ctx.role }, agentRunId: ctx.agentRunId, epoch: ctx.epoch };
}

function summarize(args: unknown): string {
  return JSON.stringify(args).slice(0, 400);
}

function sourceRefsOf(args: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const key of ["locatorId", "sourceId", "proposalId", "claimId", "caseId", "reportId"]) if (typeof args[key] === "string") refs.push(args[key] as string);
  for (const key of ["locatorIds", "factIds"]) if (Array.isArray(args[key])) refs.push(...(args[key] as string[]));
  return refs;
}

async function recordStaleRejection(ctx: ToolContext, tool: string, error: DomainError): Promise<void> {
  await commit(async (_tx, record) => {
    await record({
      workspaceId: ctx.workspaceId,
      type: "agent.stale_result_rejected",
      actor: { kind: "agent", id: ctx.role },
      caseId: ctx.caseId,
      evidenceEpoch: ctx.epoch,
      payload: { agentRunId: ctx.agentRunId, tool, ...error.details, message: error.message },
    });
  });
}

/** Scheduling control for the labelled J3 scenario: holds one write until the case epoch moves past the loop's epoch. */
async function maybeHoldForStaleScenario(ctx: ToolContext, tool: string): Promise<void> {
  const fault = ctx.faults.find((f) => f.type === "hold_stale_commit" && f.role === ctx.role && f.epoch === ctx.epoch);
  if (!fault || !ctx.caseId) return;
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, ctx.workspaceId) });
  const consumed = (ws?.settings.consumedFaults as string[] | undefined) ?? [];
  if (consumed.includes("hold_stale_commit")) return;
  await db.update(workspace).set({ settings: { ...ws!.settings, consumedFaults: [...consumed, "hold_stale_commit"] } }).where(eq(workspace.id, ctx.workspaceId));
  await commit(async (_tx, record) => {
    await record({ workspaceId: ctx.workspaceId, type: "fault.holding", actor: { kind: "system", id: "fault-injection" }, caseId: ctx.caseId, evidenceEpoch: ctx.epoch, payload: { agentRunId: ctx.agentRunId, tool, label: fault.label } });
  });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const row = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, ctx.caseId) });
    if (row && row.evidenceEpoch > (ctx.epoch ?? 0)) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  await commit(async (_tx, record) => {
    await record({ workspaceId: ctx.workspaceId, type: "fault.released", actor: { kind: "system", id: "fault-injection" }, caseId: ctx.caseId, evidenceEpoch: ctx.epoch, payload: { agentRunId: ctx.agentRunId, tool, label: fault.label } });
  });
}

function defineTool<S extends z.ZodTypeAny>(ctx: ToolContext, spec: { name: string; description: string; schema: S; jsonSchema: Record<string, unknown>; write?: boolean; run: (args: z.infer<S>) => Promise<unknown> }): Tool {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    parameters: spec.jsonSchema,
    strict: true,
    invoke: async (rawArgs: unknown) => {
      const startedAt = new Date();
      let result: ToolResult;
      let refs: string[] = [];
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        result = { ok: false, error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
      } else {
        refs = sourceRefsOf(parsed.data as Record<string, unknown>);
        try {
          if (spec.write) await maybeHoldForStaleScenario(ctx, spec.name);
          result = { ok: true, data: await spec.run(parsed.data) };
        } catch (error) {
          if (error instanceof DomainError) {
            result = { ok: false, error: { code: error.code, message: error.message, details: error.details } };
            if (error.code === "STALE_EVIDENCE") await recordStaleRejection(ctx, spec.name, error);
          } else {
            console.error(`[tool ${spec.name}]`, error);
            result = { ok: false, error: { code: "INTERNAL", message: "the tool failed unexpectedly; nothing was changed" } };
          }
        }
      }
      await db.insert(toolCall).values({
        agentRunId: ctx.agentRunId,
        toolName: spec.name,
        inputSummary: summarize(rawArgs),
        ok: result.ok,
        errorCode: result.ok ? null : result.error.code,
        sourceRefs: refs,
        startedAt,
        endedAt: new Date(),
      });
      await db.update(agentRun).set({ heartbeatAt: new Date() }).where(eq(agentRun.id, ctx.agentRunId));
      const serialized = JSON.stringify({ ...result, epoch: ctx.epoch });
      if (serialized.length > ENV.MAX_TOOL_RESULT_CHARS) {
        return JSON.stringify({ ok: false, error: { code: "RESULT_TOO_LARGE", message: `The result was ${serialized.length} characters, above the ${ENV.MAX_TOOL_RESULT_CHARS} character limit. Call the tool again with narrower arguments, such as specific period ends or a row label.` }, epoch: ctx.epoch });
      }
      return serialized;
    },
  };
}

const ID = z.string().uuid();
const idSchema = (name: string, description: string) => ({ type: "object", properties: { [name]: { type: "string", description } }, required: [name], additionalProperties: false });

/** Each task sees only the tools it needs. Tool schemas are sent with every model call, so this keeps calls small. */
const TASK_TOOLS: Record<string, string[]> = {
  classify_filing: ["list_source_sections", "read_source_excerpt", "propose_disclosure_scope"],
  respond_scope_challenge: ["list_source_sections", "read_source_excerpt", "propose_disclosure_scope"],
  link_amendment: ["list_source_sections", "read_source_excerpt", "propose_amendment_link"],
  check_scope: ["list_source_sections", "read_source_excerpt", "check_disclosure_scope"],
  verify_replacement: ["get_proposal", "read_source_excerpt", "list_source_sections", "compute_formula", "submit_verification"],
  review_conclusions: ["get_draft_for_review", "review_draft_conclusions"],
  verify_bindings: ["get_draft", "list_source_sections", "read_source_excerpt", "confirm_binding"],
  propose_replacements: ["get_case", "find_fact_candidates", "propose_replacement", "raise_challenge"],
  extract_claims: ["get_draft", "search_facts", "propose_claim"],
  write_warning: ["get_case", "propose_warning_text"],
  draft_revision: ["get_report_for_editing", "propose_revision_patch"],
  revise_draft: ["get_report_for_editing", "get_draft_for_review", "propose_revision_patch"],
};

export function buildTools(ctx: ToolContext): Tool[] {
  const tools: Record<string, Tool> = {
    get_case: defineTool(ctx, {
      name: "get_case",
      description: "Read a correction case: scope, evidence epoch, affected claims with states, current proposals and open challenges.",
      schema: z.object({ caseId: ID }),
      jsonSchema: idSchema("caseId", "Case id"),
      run: ({ caseId }) => caseSummary(ctx.workspaceId, caseId),
    }),
    list_open_cases: defineTool(ctx, {
      name: "list_open_cases",
      description: "List open correction cases in this workspace, optionally for one issuer CIK.",
      schema: z.object({ cik: z.string().regex(/^\d{10}$/).nullable() }),
      jsonSchema: { type: "object", properties: { cik: { type: ["string", "null"], description: "Ten digit CIK or null" } }, required: ["cik"], additionalProperties: false },
      run: ({ cik }) => openCasesForIssuer(ctx.workspaceId, cik ?? undefined),
    }),
    list_eligible_filings: defineTool(ctx, {
      name: "list_eligible_filings",
      description: "List public filings available in this workspace at the current replay time.",
      schema: z.object({ cik: z.string().regex(/^\d{10}$/).nullable() }),
      jsonSchema: { type: "object", properties: { cik: { type: ["string", "null"] } }, required: ["cik"], additionalProperties: false },
      run: ({ cik }) => listEligibleFilings(ctx.workspaceId, cik ?? undefined),
    }),
    list_source_sections: defineTool(ctx, {
      name: "list_source_sections",
      description: "List a filing's navigable sections without values: Item paragraphs for 8-Ks; for periodic reports, statement table rows with one locator per cell labelled by column (as_reported, adjustment, as_restated, ordinary) and period. Filter by period ends and a row label to keep the result short.",
      schema: z.object({ sourceId: ID, periodEnds: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(6), rowLabel: z.string().max(80).nullable() }),
      jsonSchema: {
        type: "object",
        properties: { sourceId: { type: "string" }, periodEnds: { type: "array", items: { type: "string" }, description: "YYYY-MM-DD period ends to include; empty for all" }, rowLabel: { type: ["string", "null"], description: "Case-insensitive text the row label must contain, e.g. total current assets" } },
        required: ["sourceId", "periodEnds", "rowLabel"],
        additionalProperties: false,
      },
      run: ({ sourceId, periodEnds, rowLabel }) => sourceSections(ctx.workspaceId, sourceId, { periodEnds, rowQuery: rowLabel ?? undefined }),
    }),
    read_source_excerpt: defineTool(ctx, {
      name: "read_source_excerpt",
      description: "Read one locator from the stored filing bytes. Table rows include each printed cell with its column header.",
      schema: z.object({ locatorId: ID }),
      jsonSchema: idSchema("locatorId", "Locator id from list_source_sections or find_fact_candidates"),
      run: ({ locatorId }) => readExcerpt(ctx.workspaceId, locatorId),
    }),
    propose_disclosure_scope: defineTool(ctx, {
      name: "propose_disclosure_scope",
      description: "Classify a filing. For NON_RELIANCE, list every period the issuer says should no longer be relied upon and cite the excerpt locators that state it.",
      schema: z.object({ sourceId: ID, classification: z.enum(["NON_RELIANCE", "AMENDMENT", "UNRELATED"]), periods: z.array(PERIOD).max(12), locatorIds: z.array(ID).min(1).max(20), summary: z.string().min(10).max(800) }),
      jsonSchema: {
        type: "object",
        properties: { sourceId: { type: "string" }, classification: { type: "string", enum: ["NON_RELIANCE", "AMENDMENT", "UNRELATED"] }, periods: { type: "array", items: PERIOD_JSON_SCHEMA }, locatorIds: { type: "array", items: { type: "string" } }, summary: { type: "string" } },
        required: ["sourceId", "classification", "periods", "locatorIds", "summary"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await proposeDisclosureScope(actor(ctx), args)).result,
    }),
    propose_amendment_link: defineTool(ctx, {
      name: "propose_amendment_link",
      description: "Link an amended filing that contains restated statements to an open case. Cite restatement table locators.",
      schema: z.object({ caseId: ID, sourceId: ID, locatorIds: z.array(ID).min(1).max(20), summary: z.string().min(10).max(800) }),
      jsonSchema: { type: "object", properties: { caseId: { type: "string" }, sourceId: { type: "string" }, locatorIds: { type: "array", items: { type: "string" } }, summary: { type: "string" } }, required: ["caseId", "sourceId", "locatorIds", "summary"], additionalProperties: false },
      write: true,
      run: async (args) => (await linkAmendment({ ...actor(ctx), epoch: null }, args)).result,
    }),
    check_disclosure_scope: defineTool(ctx, {
      name: "check_disclosure_scope",
      description: "Independently check a proposed non-reliance scope. Submit the periods you found in the excerpts you read yourself.",
      schema: z.object({ caseId: ID, verdict: z.enum(["confirm", "dispute"]), periods: z.array(PERIOD).max(12), locatorIds: z.array(ID).min(1).max(20), explanation: z.string().min(10).max(1200) }),
      jsonSchema: {
        type: "object",
        properties: { caseId: { type: "string" }, verdict: { type: "string", enum: ["confirm", "dispute"] }, periods: { type: "array", items: PERIOD_JSON_SCHEMA }, locatorIds: { type: "array", items: { type: "string" } }, explanation: { type: "string" } },
        required: ["caseId", "verdict", "periods", "locatorIds", "explanation"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await checkDisclosureScope(actor(ctx), args)).result,
    }),
    find_fact_candidates: defineTool(ctx, {
      name: "find_fact_candidates",
      description: "For each claim, find facts in eligible filings with the same issuer, concept, period and unit, across as-reported, adjustment and as-restated columns.",
      schema: z.object({ caseId: ID, claimIds: z.array(ID).min(1).max(10) }),
      jsonSchema: { type: "object", properties: { caseId: { type: "string" }, claimIds: { type: "array", items: { type: "string" }, description: "One or more claim ids" } }, required: ["caseId", "claimIds"], additionalProperties: false },
      run: async ({ caseId, claimIds }) => Object.fromEntries(await Promise.all(claimIds.map(async (claimId) => [claimId, (await findFactCandidates(actor(ctx), { caseId, claimId })).map((f) => ({ factId: f.factId, accession: `${f.form} ${f.accession}`, column: f.column, periodEnd: f.periodEnd, printed: f.rawText, value: f.value, locatorId: f.locatorId }))]))),
    }),
    propose_replacement: defineTool(ctx, {
      name: "propose_replacement",
      description: 'Propose how an affected claim should be corrected. kind "fact" cites one as-restated fact; "unchanged" cites the amended value when it equals the original; "formula" recomputes a derived claim from verified inputs; "unaffected" clears a candidate claim that relies on no figures.',
      schema: z.object({ caseId: ID, claimId: ID, kind: z.enum(["fact", "unchanged", "formula", "unaffected"]), factIds: z.array(ID).max(1), rationale: z.string().min(10).max(1200) }),
      jsonSchema: {
        type: "object",
        properties: { caseId: { type: "string" }, claimId: { type: "string" }, kind: { type: "string", enum: ["fact", "unchanged", "formula", "unaffected"] }, factIds: { type: "array", items: { type: "string" }, description: "One fact id for fact or unchanged, empty otherwise" }, rationale: { type: "string" } },
        required: ["caseId", "claimId", "kind", "factIds", "rationale"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await proposeReplacement(actor(ctx), args)).result,
    }),
    get_proposal: defineTool(ctx, {
      name: "get_proposal",
      description: "Read a replacement proposal to verify: the claim, its identity and the linked amendment. The proposed value is withheld.",
      schema: z.object({ proposalId: ID }),
      jsonSchema: idSchema("proposalId", "Proposal id"),
      run: ({ proposalId }) => proposalForVerifier(ctx.workspaceId, proposalId),
    }),
    compute_formula: defineTool(ctx, {
      name: "compute_formula",
      description: "Recompute a derived claim's formula in code from the verified replacements of its inputs on the current evidence revision.",
      schema: z.object({ caseId: ID, claimId: ID }),
      jsonSchema: { type: "object", properties: { caseId: { type: "string" }, claimId: { type: "string" } }, required: ["caseId", "claimId"], additionalProperties: false },
      run: async ({ caseId, claimId }) => {
        const target = await db.query.claim.findFirst({ where: (t, { eq: e }) => e(t.id, claimId) });
        if (!target?.formula) throw new DomainError("INVALID_INPUT", "claim has no formula");
        const caseRow = await db.query.correctionCase.findFirst({ where: eq(correctionCase.id, caseId) });
        if (!caseRow) throw new DomainError("NOT_FOUND", "case not found");
        const inputs = await verifiedInputs(db, caseId, caseRow.evidenceEpoch, target.formula, claimId);
        return computeFormula(target.formula, inputs);
      },
    }),
    submit_verification: defineTool(ctx, {
      name: "submit_verification",
      description: "Submit your independent check of a proposal: the locators you read, the value you found (or the formula result you computed) and your verdict.",
      schema: z.object({ proposalId: ID, verdict: z.enum(["verified", "rejected"]), locatorIds: z.array(ID).max(10), independentValue: z.string().regex(/^-?\d+(\.\d+)?$/).nullable(), rationale: z.string().min(10).max(1500) }),
      jsonSchema: {
        type: "object",
        properties: {
          proposalId: { type: "string" },
          verdict: { type: "string", enum: ["verified", "rejected"] },
          locatorIds: { type: "array", items: { type: "string" } },
          independentValue: { type: ["string", "null"], description: "Plain decimal in base units, e.g. 670496 or -123653 or 0.8442; null when the claim has no figure" },
          rationale: { type: "string" },
        },
        required: ["proposalId", "verdict", "locatorIds", "independentValue", "rationale"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await submitVerification(actor(ctx), args)).result,
    }),
    raise_challenge: defineTool(ctx, {
      name: "raise_challenge",
      description: "Raise a challenge against another participant's proposal or scope with a reason code and references.",
      schema: z.object({ caseId: ID, targetKind: z.enum(["replacement_proposal", "disclosure_scope", "amendment_link"]), targetId: z.string().min(1).max(80), reasonCode: z.string().min(3).max(60), explanation: z.string().min(10).max(1200), refs: z.array(z.string()).max(20) }),
      jsonSchema: {
        type: "object",
        properties: { caseId: { type: "string" }, targetKind: { type: "string", enum: ["replacement_proposal", "disclosure_scope", "amendment_link"] }, targetId: { type: "string" }, reasonCode: { type: "string" }, explanation: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
        required: ["caseId", "targetKind", "targetId", "reasonCode", "explanation", "refs"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await raiseChallenge(actor(ctx), args)).result,
    }),
    get_report_for_editing: defineTool(ctx, {
      name: "get_report_for_editing",
      description: "Read the current published version of a note as blocks, with each claim's id, impact state and whether a verified replacement exists.",
      schema: z.object({ reportId: ID }),
      jsonSchema: idSchema("reportId", "Report id"),
      run: ({ reportId }) => reportForEditing(ctx.workspaceId, reportId),
    }),
    propose_warning_text: defineTool(ctx, {
      name: "propose_warning_text",
      description: "Write the reader-facing explanation shown under the warning on a note. Plain language, no figures, 40 to 700 characters.",
      schema: z.object({ caseId: ID, reportId: ID, text: z.string().min(40).max(700) }),
      jsonSchema: { type: "object", properties: { caseId: { type: "string" }, reportId: { type: "string" }, text: { type: "string" } }, required: ["caseId", "reportId", "text"], additionalProperties: false },
      write: true,
      run: async (args) => (await proposeWarningText(actor(ctx), args)).result,
    }),
    propose_revision_patch: defineTool(ctx, {
      name: "propose_revision_patch",
      description: "Draft a corrected version of a note. Replace only blocks with affected claims. Use {{claim:<claimId>}} for corrected figures and {{previous:<claimId>}} for original figures; never type numbers. Include the correction notice text.",
      schema: z.object({
        caseId: ID,
        reportId: ID,
        baseRevisionId: ID,
        patches: z.array(z.object({ blockId: z.string().min(1).max(80), text: z.string().min(1).max(4000) })).min(1).max(40),
        notice: z.object({ whatChanged: z.string().min(10).max(1500), why: z.string().min(10).max(1500), conclusions: z.string().min(10).max(1500) }),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          caseId: { type: "string" },
          reportId: { type: "string" },
          baseRevisionId: { type: "string" },
          patches: { type: "array", items: { type: "object", properties: { blockId: { type: "string" }, text: { type: "string", description: "For tables, one row per line with cells separated by ' | ', header row first" } }, required: ["blockId", "text"], additionalProperties: false } },
          notice: { type: "object", properties: { whatChanged: { type: "string" }, why: { type: "string" }, conclusions: { type: "string" } }, required: ["whatChanged", "why", "conclusions"], additionalProperties: false },
        },
        required: ["caseId", "reportId", "baseRevisionId", "patches", "notice"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await proposeRevisionPatch(actor(ctx), args)).result,
    }),
  };
  Object.assign(tools, {
    get_draft: defineTool(ctx, {
      name: "get_draft",
      description: "Read a draft note as blocks with every numeric token, the claims already proposed and what still blocks publication.",
      schema: z.object({ revisionId: ID }),
      jsonSchema: idSchema("revisionId", "Draft revision id"),
      run: async ({ revisionId }) => {
        const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, revisionId), eq(researchRevision.workspaceId, ctx.workspaceId)) });
        if (!revision) throw new DomainError("NOT_FOUND", "draft not found");
        const claims = await db.query.claim.findMany({ where: (t, { eq: e }) => e(t.revisionId, revisionId) });
        return {
          revisionId,
          asOf: revision.asOf.toISOString(),
          sourceIds: revision.sourceRefs,
          blocks: revision.blocks.map((b) => ({ blockId: b.id, kind: b.kind, text: b.text })),
          numericTokens: scanNumericTokens(revision.blocks),
          claims: claims.map((c) => ({ claimId: c.id, blockId: c.blockId, start: c.startOffset, end: c.endOffset, text: c.text, category: c.category, label: c.label, bindingState: c.bindingState, proposedBy: c.proposedBy })),
          readiness: await draftReadiness(revisionId),
        };
      },
    }),
    search_facts: defineTool(ctx, {
      name: "search_facts",
      description: "Search reported facts in the draft's declared sources by label or concept text, optionally filtered by period end.",
      schema: z.object({ revisionId: ID, query: z.string().min(2).max(80), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
      jsonSchema: { type: "object", properties: { revisionId: { type: "string" }, query: { type: "string" }, periodEnd: { type: ["string", "null"] } }, required: ["revisionId", "query", "periodEnd"], additionalProperties: false },
      run: async ({ revisionId, query, periodEnd }) => {
        const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, revisionId), eq(researchRevision.workspaceId, ctx.workspaceId)) });
        if (!revision?.sourceRefs.length) return [];
        const term = `%${query.replace(/[%_]/g, "")}%`;
        const rows = await db
          .select({ fact: financialFact, accession: sourceDocument.accession, form: sourceDocument.form })
          .from(financialFact)
          .innerJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId))
          .where(and(inArray(financialFact.sourceId, revision.sourceRefs), or(ilike(financialFact.label, term), ilike(financialFact.conceptId, term)), periodEnd ? eq(financialFact.periodEnd, periodEnd) : undefined))
          .limit(25);
        return rows.map(({ fact, accession, form }) => ({ factId: fact.id, label: fact.label, concept: fact.conceptId, periodEnd: fact.periodEnd, column: fact.sourceColumn, printed: fact.rawText, value: fact.value, unit: fact.unit, scale: fact.scale, dimensions: fact.dimensions, extraction: fact.extractionMethod, accession, form, locatorId: fact.locatorId }));
      },
    }),
    propose_claim: defineTool(ctx, {
      name: "propose_claim",
      description: "Propose one claim in a draft: the exact span (block id and character offsets), its category, and its evidence (a fact id for DIRECT, a formula over earlier claim ids for DERIVED, the claim ids a conclusion relies on for QUALITATIVE, a reason for OTHER).",
      schema: z.object({
        revisionId: ID,
        blockId: z.string().min(1).max(80),
        start: z.number().int().min(0),
        end: z.number().int().min(1),
        category: z.enum(["DIRECT", "DERIVED", "QUALITATIVE", "OTHER"]),
        label: z.string().min(2).max(160),
        material: z.boolean(),
        factId: ID.nullable(),
        formula: z.unknown().nullable(),
        dependsOn: z.array(ID).max(10),
        reason: z.string().max(400).nullable(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          revisionId: { type: "string" },
          blockId: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          category: { type: "string", enum: ["DIRECT", "DERIVED", "QUALITATIVE", "OTHER"] },
          label: { type: "string" },
          material: { type: "boolean" },
          factId: { type: ["string", "null"] },
          formula: { type: ["object", "null"], description: 'Expression tree, e.g. {"op":"sub","args":[{"op":"ref","ref":"<claimId>"},{"op":"ref","ref":"<claimId>"}]}. ops: ref, const (only "100"), add, sub, mul, div, round, pct_change' },
          dependsOn: { type: "array", items: { type: "string" } },
          reason: { type: ["string", "null"] },
        },
        required: ["revisionId", "blockId", "start", "end", "category", "label", "material", "factId", "formula", "dependsOn", "reason"],
        additionalProperties: false,
      },
      write: true,
      run: async (args) => (await proposeClaim(actor(ctx), { ...args, factId: args.factId ?? null, formula: args.formula ?? undefined })).result,
    }),
    confirm_binding: defineTool(ctx, {
      name: "confirm_binding",
      description: "Independently confirm or reject a proposed claim mapping in a draft. For DIRECT claims cite the locator you read and the value you found; for DERIVED claims give the value you computed.",
      schema: z.object({ claimId: ID, locatorId: ID.nullable(), value: z.string().regex(/^-?\d+(\.\d+)?$/).nullable(), verdict: z.enum(["confirm", "reject"]), reason: z.string().min(5).max(400) }),
      jsonSchema: { type: "object", properties: { claimId: { type: "string" }, locatorId: { type: ["string", "null"] }, value: { type: ["string", "null"] }, verdict: { type: "string", enum: ["confirm", "reject"] }, reason: { type: "string" } }, required: ["claimId", "locatorId", "value", "verdict", "reason"], additionalProperties: false },
      write: true,
      run: async (args) => (await confirmBinding(actor(ctx), args)).result,
    }),
  });

  Object.assign(tools, {
    get_draft_for_review: defineTool(ctx, {
      name: "get_draft_for_review",
      description: "Read a correction draft for review: each rewritten block, and every affected figure with its previous and verified values.",
      schema: z.object({ candidateId: ID }),
      jsonSchema: idSchema("candidateId", "Draft (candidate revision) id"),
      run: async ({ candidateId }) => {
        const candidate = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, candidateId), eq(researchRevision.workspaceId, ctx.workspaceId)) });
        if (candidate?.kind !== "candidate") throw new DomainError("NOT_FOUND", "draft not found");
        const meta = (candidate.noticeDraft ?? {}) as { changes?: { label: string; previous: string; replacement: string; delta: string }[]; patchedBlockIds?: string[]; notice?: Record<string, string> };
        const rewritten = candidate.blocks.filter((b) => (meta.patchedBlockIds ?? []).some((id) => b.id.startsWith(id)));
        return { candidateId, state: candidate.candidateState, figures: meta.changes ?? [], rewrittenBlocks: rewritten.map((b) => ({ blockId: b.id, kind: b.kind, text: b.text })), notice: meta.notice ?? null };
      },
    }),
    review_draft_conclusions: defineTool(ctx, {
      name: "review_draft_conclusions",
      description: "Record whether every conclusion and the notice text in a correction draft is true on the verified figures. Use inconsistent if any sentence contradicts them, and say which sentence and why.",
      schema: z.object({ candidateId: ID, verdict: z.enum(["consistent", "inconsistent"]), explanation: z.string().min(10).max(1200) }),
      jsonSchema: { type: "object", properties: { candidateId: { type: "string" }, verdict: { type: "string", enum: ["consistent", "inconsistent"] }, explanation: { type: "string" } }, required: ["candidateId", "verdict", "explanation"], additionalProperties: false },
      write: true,
      run: async (args) => (await reviewConclusions(actor(ctx), args)).result,
    }),
  });

  const byRole: Record<AgentRole, string[]> = {
    "filing-monitor": ["list_eligible_filings", "list_source_sections", "read_source_excerpt", "list_open_cases", "get_case", "propose_disclosure_scope", "propose_amendment_link"],
    "impact-analyst": ["get_case", "find_fact_candidates", "read_source_excerpt", "propose_replacement", "raise_challenge", "get_draft", "search_facts", "propose_claim"],
    "financial-verifier": ["get_case", "get_proposal", "list_source_sections", "read_source_excerpt", "check_disclosure_scope", "compute_formula", "submit_verification", "raise_challenge", "get_draft", "confirm_binding", "get_draft_for_review", "review_draft_conclusions"],
    "publication-editor": ["get_case", "get_report_for_editing", "get_draft_for_review", "propose_warning_text", "propose_revision_patch"],
  };
  const names = (ctx.taskKind && TASK_TOOLS[ctx.taskKind]) || byRole[ctx.role];
  return names.filter((name) => byRole[ctx.role].includes(name)).map((name) => tools[name]!);
}
