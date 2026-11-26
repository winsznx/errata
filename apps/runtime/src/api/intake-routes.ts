import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { runtimeFor } from "../agents/host.js";
import { db } from "../db/client.js";
import { claim, claimBinding, claimDependency, researchRevision } from "../db/schema.js";
import { scanNumericTokens } from "../domain/document.js";
import { assert } from "../domain/errors.js";
import { commit } from "../domain/events.js";
import { confirmBinding, createDraft, draftReadiness, proposeClaim, publishInitial, updateDraft } from "../domain/intake.js";
import { requirePrincipal, withIdempotency } from "./auth.js";
import { revisionView } from "./views.js";

type Params = { workspaceId: string };
const W = "/api/v1/workspaces/:workspaceId";
const UUID = z.string().uuid();
const CIK = z.string().regex(/^\d{10}$/);
const DRAFT = z.object({ title: z.string().min(5).max(200), issuerCiks: z.array(CIK).min(1).max(5), asOf: z.string().datetime(), sourceIds: z.array(UUID).max(10), markdown: z.string().max(256 * 1024) });
const CLAIM = z.object({
  blockId: z.string().min(1).max(80),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  category: z.enum(["DIRECT", "DERIVED", "QUALITATIVE", "OTHER"]),
  label: z.string().min(2).max(160),
  material: z.boolean(),
  factId: UUID.nullable().optional(),
  formula: z.unknown().optional(),
  dependsOn: z.array(UUID).max(10).optional(),
  reason: z.string().max(400).nullable().optional(),
});

function ok(reply: FastifyReply, data: unknown, status = 200) {
  return reply.status(status).send({ data, meta: { requestId: reply.request.id, serverTime: new Date().toISOString() } });
}

async function draftOf(workspaceId: string, revisionId: string) {
  const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, revisionId), eq(researchRevision.workspaceId, workspaceId)) });
  assert(revision && revision.kind === "draft", "NOT_FOUND", "draft not found");
  return revision;
}

export async function registerIntakeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: Params }>(`${W}/reports`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const body = DRAFT.parse(request.body);
    const { result } = await createDraft({ workspaceId: p.workspaceId, actor: { kind: "human", id: `${p.role}:${p.id}` } }, body);
    return ok(reply, result, 201);
  });

  app.post<{ Params: Params }>(`${W}/reports/import`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const body = DRAFT.omit({ markdown: true }).extend({ filename: z.string().regex(/\.(md|markdown|txt)$/i, "only .md and .txt files are supported"), content: z.string().max(256 * 1024, "file is larger than 256 KiB") }).parse(request.body);
    const { result } = await createDraft({ workspaceId: p.workspaceId, actor: { kind: "human", id: `${p.role}:${p.id}` } }, { ...body, markdown: body.content });
    return ok(reply, result, 201);
  });

  app.post<{ Params: Params & { reportId: string } }>(`${W}/reports/:reportId/revisions`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const body = z.object({ baseRevisionId: UUID, markdown: z.string().max(256 * 1024), expectedHash: z.string().length(64) }).parse(request.body);
    const { result } = await updateDraft({ workspaceId: p.workspaceId, actor: { kind: "human", id: `${p.role}:${p.id}` } }, { reportId: UUID.parse(request.params.reportId), ...body });
    return ok(reply, result, 201);
  });

  app.get<{ Params: Params & { revisionId: string } }>(`${W}/revisions/:revisionId/claims`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, UUID.parse(request.params.revisionId)), eq(researchRevision.workspaceId, p.workspaceId)) });
    assert(revision, "NOT_FOUND", "revision not found");
    const view = await revisionView(p.workspaceId, revision.id, { includeInternal: true });
    const tokens = scanNumericTokens(revision.blocks);
    const readiness = revision.kind === "draft" ? await draftReadiness(revision.id) : { blockers: [], claims: view.claims.length };
    return ok(reply, { revision: view, tokens, unmapped: tokens.filter((t) => !view.claims.some((c) => c.blockId === t.blockId && c.start <= t.start && c.end >= t.end)), readiness });
  });

  app.post<{ Params: Params & { revisionId: string } }>(`${W}/revisions/:revisionId/claims`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const body = CLAIM.parse(request.body);
    const { result } = await proposeClaim({ workspaceId: p.workspaceId, actor: { kind: "human", id: `${p.role}:${p.id}` } }, { revisionId: UUID.parse(request.params.revisionId), ...body });
    return ok(reply, result, 201);
  });

  app.put<{ Params: Params & { claimId: string } }>(`${W}/claims/:claimId/binding`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const body = CLAIM.omit({ blockId: true, start: true, end: true }).parse(request.body);
    const existing = await db.query.claim.findFirst({ where: and(eq(claim.id, UUID.parse(request.params.claimId)), eq(claim.workspaceId, p.workspaceId)) });
    assert(existing, "NOT_FOUND", "claim not found");
    await draftOf(p.workspaceId, existing.revisionId);
    const dependents = await db.select({ id: claimBinding.id }).from(claimBinding).where(eq(claimBinding.refClaimId, existing.id));
    assert(dependents.length === 0, "CONFLICT", "other claims are derived from this one; remap those first");
    await commit(async (tx, record) => {
      await tx.delete(claimDependency).where(and(eq(claimDependency.workspaceId, p.workspaceId), eq(claimDependency.toNode, `claim:${existing.id}`)));
      await tx.delete(claim).where(eq(claim.id, existing.id));
      await record({ workspaceId: p.workspaceId, type: "claim.mapping_replaced", actor: { kind: "human", id: `${p.role}:${p.id}` }, payload: { claimId: existing.id, revisionId: existing.revisionId } });
    });
    const { result } = await proposeClaim({ workspaceId: p.workspaceId, actor: { kind: "human", id: `${p.role}:${p.id}` } }, { revisionId: existing.revisionId, blockId: existing.blockId, start: existing.startOffset, end: existing.endOffset, ...body });
    return ok(reply, result);
  });

  app.post<{ Params: Params & { revisionId: string } }>(`${W}/revisions/:revisionId/extract-claims`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const revision = await draftOf(p.workspaceId, UUID.parse(request.params.revisionId));
    await runtimeFor(p.workspaceId);
    const result = await withIdempotency(p.workspaceId, "extract", (request.headers["idempotency-key"] as string | undefined) ?? undefined, { revisionId: revision.id }, async () => {
      const { events } = await commit(async (_tx, record) => {
        await record({ workspaceId: p.workspaceId, type: "report.extraction_requested", actor: { kind: "human", id: `${p.role}:${p.id}` }, payload: { revisionId: revision.id, reportId: revision.reportId } });
      });
      return { eventId: events[0]!.id };
    });
    return ok(reply, result, 202);
  });

  app.post<{ Params: Params & { revisionId: string } }>(`${W}/revisions/:revisionId/check`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["analyst", "editor"]);
    const revision = await draftOf(p.workspaceId, UUID.parse(request.params.revisionId));
    await runtimeFor(p.workspaceId);
    const result = await withIdempotency(p.workspaceId, "check", (request.headers["idempotency-key"] as string | undefined) ?? undefined, { revisionId: revision.id }, async () => {
      const { events } = await commit(async (_tx, record) => {
        await record({ workspaceId: p.workspaceId, type: "report.binding_check_requested", actor: { kind: "human", id: `${p.role}:${p.id}` }, payload: { revisionId: revision.id, reportId: revision.reportId } });
      });
      return { eventId: events[0]!.id };
    });
    return ok(reply, result, 202);
  });

  app.post<{ Params: Params & { claimId: string } }>(`${W}/claims/:claimId/confirm`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor"]);
    const body = z.object({ locatorId: UUID.nullable(), value: z.string().regex(/^-?\d+(\.\d+)?$/).nullable(), verdict: z.enum(["confirm", "reject"]), reason: z.string().min(5).max(400) }).parse(request.body);
    const { result } = await confirmBinding({ workspaceId: p.workspaceId, actor: { kind: "human", id: `editor:${p.id}` } }, { claimId: UUID.parse(request.params.claimId), ...body });
    return ok(reply, result);
  });

  app.post<{ Params: Params & { revisionId: string } }>(`${W}/revisions/:revisionId/publish-initial`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor"]);
    const body = z.object({ contentHash: z.string().length(64), confirm: z.literal(true) }).parse(request.body);
    const result = await withIdempotency(p.workspaceId, "publish-initial", (request.headers["idempotency-key"] as string | undefined) ?? undefined, { ...body, revisionId: request.params.revisionId }, async () => (await publishInitial({ workspaceId: p.workspaceId, actor: { kind: "human", id: `editor:${p.id}` }, actorName: p.displayName }, { revisionId: UUID.parse(request.params.revisionId), contentHash: body.contentHash })).result);
    return ok(reply, result);
  });
}
