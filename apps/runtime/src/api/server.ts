import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { and, asc, count, desc, eq, gt, gte } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { runtimeFor } from "../agents/host.js";
import { ENV } from "../config/env.js";
import { db, sqlClient } from "../db/client.js";
import { agentRun, correctionNotice, delivery, domainEvent, issuer, researchReport, researchRevision, syntheticRecipient, watchSubscription, workspace } from "../db/schema.js";
import { advanceReplay } from "../domain/cases.js";
import { DomainError, assert } from "../domain/errors.js";
import { eventBus, serializeEvent } from "../domain/events.js";
import { latestCandidate, reissue, reviewCandidate, withdrawReport } from "../domain/publication.js";
import { loadScenario, loadScenarios } from "../domain/scenarios.js";
import { createScenarioWorkspace, hashToken } from "../domain/workspace.js";
import { EXPORT_MIME, exportBytes, generateExport, type ExportFormat } from "../exports/service.js";
import { retryDelivery } from "../jobs/handlers.js";
import { padCik } from "../sources/sec-client.js";
import { issuerName, pollWatchlists } from "../sources/live.js";
import { issueSession, principalFrom, requirePrincipal, revokeSession, streamTicket, verifyStreamTicket, withIdempotency, type Role } from "./auth.js";
import { registerIntakeRoutes } from "./intake-routes.js";
import {
  candidateView,
  caseDetail,
  distributionView,
  listCases,
  listReports,
  listSources,
  noticeView,
  publicationsView,
  reportDetail,
  revisionView,
  runtimeView,
  sourceDetail,
  traceExport,
  traceView,
  watchlistView,
  workspaceOverview,
  excerptView,
} from "./views.js";

type Params = { workspaceId: string };
const UUID = z.string().uuid();
const EPOCH_VECTOR = z.array(z.object({ caseId: UUID, epoch: z.number().int().positive() }));

function ok(reply: FastifyReply, data: unknown, status = 200) {
  return reply.status(status).send({ data, meta: { requestId: reply.request.id, serverTime: new Date().toISOString() } });
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: ENV.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization"] }, trustProxy: true, bodyLimit: 512 * 1024, genReqId: () => crypto.randomUUID() });
  await app.register(cookie);
  await app.register(cors, { origin: [ENV.APP_BASE_URL], credentials: true });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("x-errata-build", ENV.BUILD_COMMIT);
    return payload;
  });

  app.addHook("preHandler", async (request) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (unsafe && request.url.startsWith("/api/v1/") && request.headers["x-errata-client"] !== "web" && request.headers["x-internal-token"] !== ENV.INTERNAL_API_TOKEN) {
      throw new DomainError("FORBIDDEN", "missing client header");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details, retryable: error.retryable }, meta: { requestId: request.id } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: "INVALID_INPUT", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), retryable: false }, meta: { requestId: request.id } });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    return reply.status(status).send({ error: { code: status === 413 ? "PAYLOAD_TOO_LARGE" : status >= 500 ? "INTERNAL" : "BAD_REQUEST", message: status >= 500 ? "Something went wrong on our side. Nothing was changed." : (error as Error).message, retryable: status >= 500 }, meta: { requestId: request.id } });
  });

  app.get("/api/v1/health", async (_request, reply) => ok(reply, { status: "ok", build: ENV.BUILD_COMMIT }));
  app.get("/api/v1/ready", async (_request, reply) => {
    await sqlClient`select 1`;
    const migrations = await sqlClient`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return ok(reply, { database: "ok", migrations: migrations[0]?.n ?? 0, model: { provider: ENV.MODEL_PROVIDER, id: ENV.MODEL_ID, configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) }, mozaikCloud: Boolean(process.env.MOZAIK_API_KEY || process.env.MOZAIK_PROJECT_KEY), liveMonitor: ENV.ENABLE_LIVE_MONITOR, build: ENV.BUILD_COMMIT });
  });

  app.get("/api/v1/scenarios", async (_request, reply) => {
    const scenarios = await loadScenarios();
    return ok(reply, scenarios.map((s) => ({ id: s.id, label: s.label, description: s.description, mode: s.mode, events: s.events.map((e) => ({ id: e.id, label: e.label })), faults: s.faults.map((f) => ({ type: f.type, label: f.label })) })));
  });

  app.get("/api/v1/session", async (request, reply) => ok(reply, await principalFrom(request)));
  app.post("/api/v1/session/end", async (request, reply) => {
    await revokeSession(request);
    reply.clearCookie("errata_session", { path: "/" });
    return ok(reply, { ended: true });
  });

  app.post("/api/v1/demo/sessions", async (request, reply) => {
    const body = z.object({ scenarioId: z.string().min(1).max(80) }).parse(request.body);
    await loadScenario(body.scenarioId);
    const [recent] = await db.select({ n: count() }).from(workspace).where(gte(workspace.createdAt, new Date(Date.now() - 3_600_000)));
    if ((recent?.n ?? 0) >= ENV.DEMO_SESSION_LIMIT_PER_HOUR) throw new DomainError("QUOTA_EXCEEDED", "the hourly limit for new demo workspaces is reached; try again shortly or use an existing workspace");
    const created = await createScenarioWorkspace(body.scenarioId);
    const principal = await issueSession(reply, created.workspaceId, "editor");
    void runtimeFor(created.workspaceId).catch((error: unknown) => request.log.error(error, "runtime start failed"));
    return ok(reply, { workspaceId: created.workspaceId, slug: created.slug, principal, route: `/w/${created.slug}` }, 201);
  });

  app.get<{ Params: { slug: string } }>("/api/v1/workspaces/by-slug/:slug", async (request, reply) => {
    const principal = await principalFrom(request);
    if (!principal || principal.workspaceSlug !== request.params.slug) throw new DomainError("NOT_FOUND", "workspace not found");
    return ok(reply, { workspaceId: principal.workspaceId, principal });
  });

  const W = "/api/v1/workspaces/:workspaceId";

  app.get<{ Params: Params }>(W, async (request, reply) => {
    const principal = await requirePrincipal(request, request.params.workspaceId);
    void runtimeFor(principal.workspaceId).catch((error: unknown) => request.log.error(error, "runtime start failed"));
    return ok(reply, { ...(await workspaceOverview(principal.workspaceId)), principal });
  });

  app.get<{ Params: Params }>(`${W}/stream-ticket`, async (request, reply) => {
    const principal = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, { ticket: streamTicket(principal.workspaceId, principal.id) });
  });

  app.post<{ Params: Params }>(`${W}/demo/role`, async (request, reply) => {
    const principal = await requirePrincipal(request, request.params.workspaceId);
    const body = z.object({ role: z.enum(["analyst", "editor", "operator"]) }).parse(request.body);
    await revokeSession(request);
    const next = await issueSession(reply, principal.workspaceId, body.role as Role);
    return ok(reply, next);
  });

  app.post<{ Params: Params }>(`${W}/demo/reset`, async (request, reply) => {
    const principal = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator"]);
    z.object({ confirm: z.literal(true) }).parse(request.body);
    const ws = (await db.query.workspace.findFirst({ where: eq(workspace.id, principal.workspaceId) }))!;
    assert(!ws.isReference, "FORBIDDEN", "the reference workspace cannot be reset");
    assert(ws.scenarioId, "CONFLICT", "only scenario workspaces can be reset");
    const created = await createScenarioWorkspace(ws.scenarioId);
    await db.update(workspace).set({ expiresAt: new Date() }).where(eq(workspace.id, ws.id));
    await revokeSession(request);
    const next = await issueSession(reply, created.workspaceId, principal.role);
    void runtimeFor(created.workspaceId).catch((error: unknown) => request.log.error(error, "runtime start failed"));
    return ok(reply, { workspaceId: created.workspaceId, slug: created.slug, principal: next, route: `/w/${created.slug}` });
  });

  app.get<{ Params: Params }>(`${W}/watchlist`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await watchlistView(p.workspaceId));
  });
  app.post<{ Params: Params }>(`${W}/watchlist`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator", "analyst"]);
    const body = z.object({ cik: z.string().regex(/^\d{1,10}$/) }).parse(request.body);
    const cik = padCik(body.cik);
    let known = await db.query.issuer.findFirst({ where: eq(issuer.cik, cik) });
    if (!known) {
      const name = await issuerName(cik);
      await db.insert(issuer).values({ cik, legalName: name, aliases: [{ name }], verifiedAt: new Date() }).onConflictDoNothing();
      known = await db.query.issuer.findFirst({ where: eq(issuer.cik, cik) });
    }
    await db.insert(watchSubscription).values({ workspaceId: p.workspaceId, cik, forms: ["8-K", "10-K", "10-K/A", "10-Q", "10-Q/A"], intervalSeconds: ENV.SEC_POLL_INTERVAL_SECONDS }).onConflictDoUpdate({ target: [watchSubscription.workspaceId, watchSubscription.cik], set: { active: true, updatedAt: new Date() } });
    return ok(reply, { cik, name: known?.legalName }, 201);
  });
  app.delete<{ Params: Params & { cik: string } }>(`${W}/watchlist/:cik`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator", "analyst"]);
    await db.update(watchSubscription).set({ active: false, updatedAt: new Date() }).where(and(eq(watchSubscription.workspaceId, p.workspaceId), eq(watchSubscription.cik, padCik(request.params.cik))));
    return ok(reply, { deactivated: true });
  });
  const lastRefresh = new Map<string, number>();
  app.post<{ Params: Params }>(`${W}/watchlist/refresh`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator"]);
    const ws = (await db.query.workspace.findFirst({ where: eq(workspace.id, p.workspaceId) }))!;
    assert(ws.mode === "live", "CONFLICT", "this is a historical replay workspace; it uses verified filing snapshots and the replay clock instead of live polling");
    const last = lastRefresh.get(p.workspaceId) ?? 0;
    assert(Date.now() - last > 60_000, "QUOTA_EXCEEDED", "one manual refresh per minute");
    lastRefresh.set(p.workspaceId, Date.now());
    return ok(reply, await pollWatchlists({ workspaceId: p.workspaceId, force: true }));
  });

  app.get<{ Params: Params; Querystring: { cik?: string; form?: string; cursor?: string; limit?: string } }>(`${W}/sources`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await listSources(p.workspaceId, request.query));
  });
  app.get<{ Params: Params & { sourceId: string }; Querystring: { column?: string; q?: string } }>(`${W}/sources/:sourceId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await sourceDetail(p.workspaceId, UUID.parse(request.params.sourceId), request.query));
  });
  app.get<{ Params: Params & { sourceId: string }; Querystring: { locatorId: string } }>(`${W}/sources/:sourceId/excerpt`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await excerptView(p.workspaceId, UUID.parse(request.query.locatorId)));
  });

  app.get<{ Params: Params & { locatorId: string } }>(`${W}/locators/:locatorId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await excerptView(p.workspaceId, UUID.parse(request.params.locatorId)));
  });

  app.get<{ Params: Params; Querystring: { q?: string; status?: string; cursor?: string; limit?: string } }>(`${W}/reports`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await listReports(p.workspaceId, request.query));
  });
  app.get<{ Params: Params & { reportId: string } }>(`${W}/reports/:reportId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const detail = await reportDetail(p.workspaceId, UUID.parse(request.params.reportId));
    const candidate = await latestCandidate(db, detail.report.id);
    return ok(reply, { ...detail, candidate: candidate && candidate.candidateState !== "PUBLISHED" ? { id: candidate.id, state: candidate.candidateState } : null });
  });
  app.get<{ Params: Params & { reportId: string; revisionId: string } }>(`${W}/reports/:reportId/revisions/:revisionId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const view = await revisionView(p.workspaceId, UUID.parse(request.params.revisionId), { includeInternal: true });
    assert(view.reportId === request.params.reportId, "NOT_FOUND", "revision not found");
    return ok(reply, view);
  });

  app.get<{ Params: Params; Querystring: { status?: string; cursor?: string; limit?: string; q?: string } }>(`${W}/cases`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await listCases(p.workspaceId, request.query));
  });
  app.get<{ Params: Params & { caseId: string } }>(`${W}/cases/:caseId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await caseDetail(p.workspaceId, UUID.parse(request.params.caseId)));
  });
  app.get<{ Params: Params & { caseId: string } }>(`${W}/cases/:caseId/impact`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const detail = await caseDetail(p.workspaceId, UUID.parse(request.params.caseId));
    return ok(reply, detail.impacts);
  });
  app.get<{ Params: Params & { caseId: string } }>(`${W}/cases/:caseId/evidence`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const detail = await caseDetail(p.workspaceId, UUID.parse(request.params.caseId));
    return ok(reply, { origin: detail.origin, linkedSources: detail.linkedSources, attestations: detail.attestations, proposals: detail.proposals, challenges: detail.challenges });
  });
  app.post<{ Params: Params & { caseId: string } }>(`${W}/cases/:caseId/retry`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator"]);
    const body = z.object({ agentRunId: UUID }).parse(request.body);
    const run = await db.query.agentRun.findFirst({ where: and(eq(agentRun.id, body.agentRunId), eq(agentRun.workspaceId, p.workspaceId), eq(agentRun.caseId, request.params.caseId)) });
    assert(run, "NOT_FOUND", "agent run not found");
    assert(run.status === "FAILED" || run.status === "TIMED_OUT", "CONFLICT", "only failed or timed out checks can be retried");
    const result = await withIdempotency(p.workspaceId, "retry", idempotencyKey(request), body, async () => {
      const runtime = await runtimeFor(p.workspaceId);
      const launched = await runtime.retry(run.id);
      assert(launched, "CONFLICT", "this check is already being retried");
      return launched;
    });
    return ok(reply, result, 202);
  });
  app.post<{ Params: Params & { caseId: string } }>(`${W}/cases/:caseId/request-revision`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "analyst"]);
    const body = z.object({ reportId: UUID }).parse(request.body);
    const runtime = await runtimeFor(p.workspaceId);
    const caseRow = await db.query.correctionCase.findFirst({ where: (t, { eq: e, and: a }) => a(e(t.id, request.params.caseId), e(t.workspaceId, p.workspaceId)) });
    assert(caseRow, "NOT_FOUND", "case not found");
    const report = await db.query.researchReport.findFirst({ where: and(eq(researchReport.id, body.reportId), eq(researchReport.workspaceId, p.workspaceId)) });
    assert(report, "NOT_FOUND", "report not found");
    const launched = await withIdempotency(p.workspaceId, "request-revision", idempotencyKey(request), body, async () =>
      runtime.launch("publication-editor", { kind: "draft_revision", key: `draft-request:${report.id}:${caseRow.id}:${caseRow.evidenceEpoch}:${Date.now()}`, caseId: caseRow.id, epoch: caseRow.evidenceEpoch, trigger: "human.request_revision", message: `A human editor asked for a corrected draft of report ${report.id} ("${report.title}") for case ${caseRow.id}. Read it with get_report_for_editing. If every affected figure has a verified replacement, draft it with propose_revision_patch; if not, record the outcome as waiting and say which figures are still unverified.` }, 1),
    );
    return ok(reply, launched, 202);
  });

  app.get<{ Params: Params & { candidateId: string } }>(`${W}/candidates/:candidateId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await candidateView(p.workspaceId, UUID.parse(request.params.candidateId)));
  });
  app.post<{ Params: Params & { candidateId: string } }>(`${W}/candidates/:candidateId/review`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor"]);
    const body = z.object({ decision: z.enum(["approve", "request_changes"]), contentHash: z.string().length(64), epochVector: EPOCH_VECTOR, notes: z.string().max(2000).optional() }).parse(request.body);
    if (body.decision === "request_changes") assert((body.notes ?? "").trim().length >= 5, "INVALID_INPUT", "say what should change");
    const result = await withIdempotency(p.workspaceId, "review", idempotencyKey(request), { ...body, candidateId: request.params.candidateId }, async () => {
      const { result: r } = await reviewCandidate({ workspaceId: p.workspaceId, actor: { kind: "human", id: `editor:${p.id}` }, actorName: p.displayName, principalId: p.id }, { candidateId: request.params.candidateId, ...body });
      return r;
    });
    void runtimeFor(p.workspaceId).then((rt) => rt.recordHumanAction(body.decision === "approve" ? "human.approved" : "human.requested_changes", { candidateId: request.params.candidateId })).catch(() => undefined);
    return ok(reply, result);
  });
  app.post<{ Params: Params & { candidateId: string } }>(`${W}/candidates/:candidateId/reissue`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor"]);
    const body = z.object({ approvalId: UUID, candidateHash: z.string().length(64), expectedBaseRevisionId: UUID, evidenceEpochs: EPOCH_VECTOR, confirm: z.literal(true) }).parse(request.body);
    const result = await withIdempotency(p.workspaceId, "reissue", idempotencyKey(request), { ...body, candidateId: request.params.candidateId }, async () => {
      const { result: r } = await reissue({ workspaceId: p.workspaceId, actor: { kind: "human", id: `editor:${p.id}` }, actorName: p.displayName }, { candidateId: request.params.candidateId, ...body });
      return { ...r, publicUrl: `/p/${r.publicId}`, noticeUrl: `/p/${r.publicId}/notices/${r.noticeId}` };
    });
    void runtimeFor(p.workspaceId).then((rt) => rt.recordHumanAction("human.reissued", { candidateId: request.params.candidateId })).catch(() => undefined);
    return ok(reply, result);
  });
  app.post<{ Params: Params & { reportId: string } }>(`${W}/reports/:reportId/withdraw`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor"]);
    const body = z.object({ reason: z.string().min(10).max(1000), expectedRevisionId: UUID, confirm: z.literal(true) }).parse(request.body);
    const result = await withIdempotency(p.workspaceId, "withdraw", idempotencyKey(request), { ...body, reportId: request.params.reportId }, async () => (await withdrawReport({ workspaceId: p.workspaceId, actor: { kind: "human", id: `editor:${p.id}` }, actorName: p.displayName }, { reportId: request.params.reportId, expectedRevisionId: body.expectedRevisionId, reason: body.reason })).result);
    return ok(reply, result);
  });

  app.get<{ Params: Params }>(`${W}/publications`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await publicationsView(p.workspaceId));
  });
  app.get<{ Params: Params & { noticeId: string } }>(`${W}/notices/:noticeId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await noticeView(p.workspaceId, UUID.parse(request.params.noticeId)));
  });
  app.post<{ Params: Params }>(`${W}/exports`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const body = z.object({ revisionId: UUID.optional(), noticeId: UUID.optional(), format: z.enum(["markdown", "pdf", "docx"]) }).refine((b) => Boolean(b.revisionId) !== Boolean(b.noticeId), "choose a revision or a notice").parse(request.body);
    if (body.revisionId) {
      const rev = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.id, body.revisionId), eq(researchRevision.workspaceId, p.workspaceId)) });
      assert(rev, "NOT_FOUND", "revision not found");
    } else {
      const notice = await db.query.correctionNotice.findFirst({ where: and(eq(correctionNotice.id, body.noticeId!), eq(correctionNotice.workspaceId, p.workspaceId)) });
      assert(notice, "NOT_FOUND", "notice not found");
    }
    const row = await generateExport({ revisionId: body.revisionId, noticeId: body.noticeId }, body.format);
    return ok(reply, { id: row.id, filename: row.filename, sha256: row.sha256, bytes: row.bytes, status: row.status, downloadUrl: `/api/v1/workspaces/${p.workspaceId}/exports/${row.id}/download` }, 201);
  });
  app.get<{ Params: Params & { exportId: string } }>(`${W}/exports/:exportId/download`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const file = await exportBytes(UUID.parse(request.params.exportId));
    assert(file.workspaceId === p.workspaceId, "NOT_FOUND", "export not found");
    return reply.header("content-type", file.mime).header("content-disposition", `attachment; filename="${file.filename}"`).send(file.bytes);
  });

  app.get<{ Params: Params }>(`${W}/distribution`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await distributionView(p.workspaceId));
  });
  app.post<{ Params: Params & { deliveryId: string } }>(`${W}/deliveries/:deliveryId/retry`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator"]);
    await retryDelivery(p.workspaceId, UUID.parse(request.params.deliveryId)).catch((error: unknown) => {
      throw new DomainError("CONFLICT", error instanceof Error ? error.message : String(error));
    });
    return ok(reply, { queued: true }, 202);
  });
  app.get<{ Params: Params & { recipientId: string } }>(`${W}/inbox/:recipientId`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await inboxFor(p.workspaceId, UUID.parse(request.params.recipientId)));
  });

  app.get<{ Params: Params }>(`${W}/replay`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const overview = await workspaceOverview(p.workspaceId);
    return ok(reply, { logicalTime: overview.workspace.logicalTime, scenario: overview.scenario });
  });
  app.post<{ Params: Params }>(`${W}/replay/advance`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId, ["editor", "operator"]);
    const body = z.object({ expectedPosition: z.number().int().min(0) }).parse(request.body);
    await runtimeFor(p.workspaceId);
    const result = await withIdempotency(p.workspaceId, "replay.advance", idempotencyKey(request), body, () => advanceReplay(p.workspaceId, body.expectedPosition, { kind: "human", id: `${p.role}:${p.id}` }));
    return ok(reply, result);
  });

  app.get<{ Params: Params }>(`${W}/runtime`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    const runtime = await runtimeFor(p.workspaceId);
    return ok(reply, { ...(await runtimeView(p.workspaceId)), participants: runtime.participants(), sharedState: runtime.state.projection() });
  });
  app.get<{ Params: Params; Querystring: { after?: string; limit?: string; type?: string } }>(`${W}/runtime/trace`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return ok(reply, await traceView(p.workspaceId, request.query));
  });
  app.get<{ Params: Params }>(`${W}/runtime/trace/export`, async (request, reply) => {
    const p = await requirePrincipal(request, request.params.workspaceId);
    return reply.header("content-type", "application/json").header("content-disposition", `attachment; filename="errata-trace-${p.workspaceSlug}.json"`).send(JSON.stringify(await traceExport(p.workspaceId), null, 2));
  });

  app.get<{ Params: Params; Querystring: { ticket?: string; lastEventId?: string } }>(`${W}/events`, async (request, reply) => {
    const workspaceId = UUID.parse(request.params.workspaceId);
    const ticketOk = request.query.ticket ? verifyStreamTicket(request.query.ticket, workspaceId) : false;
    if (!ticketOk) await requirePrincipal(request, workspaceId);
    const lastId = request.headers["last-event-id"] ?? (request.query as { lastEventId?: string }).lastEventId;
    const after = typeof lastId === "string" && /^\d+$/.test(lastId) ? BigInt(lastId) : null;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": ENV.APP_BASE_URL, "access-control-allow-credentials": "true" });
    const send = (event: Parameters<typeof serializeEvent>[0]) => res.write(`id: ${event.seq.toString()}\nevent: domain\ndata: ${JSON.stringify(serializeEvent(event))}\n\n`);
    if (after !== null) {
      const missed = await db.select().from(domainEvent).where(and(eq(domainEvent.workspaceId, workspaceId), gt(domainEvent.seq, after))).orderBy(asc(domainEvent.seq)).limit(500);
      if (missed.length === 500) res.write(`event: resync\ndata: {}\n\n`);
      for (const event of missed) send(event);
    } else res.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = eventBus.onCommitted((event) => {
      if (event.workspaceId === workspaceId) send(event);
    });
    const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{ Params: { publicId: string } }>("/api/v1/public/reports/:publicId", async (request, reply) => {
    const report = await publicReport(request.params.publicId);
    const current = await revisionView(null, report.currentRevisionId!, { includeInternal: false });
    return ok(reply, { ...(await publicReportMeta(report)), revision: current });
  });
  app.get<{ Params: { publicId: string; version: string } }>("/api/v1/public/reports/:publicId/versions/:version", async (request, reply) => {
    const report = await publicReport(request.params.publicId);
    const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.reportId, report.id), eq(researchRevision.version, Number(request.params.version))) });
    assert(revision && revision.documentState !== "DRAFT", "NOT_FOUND", "version not found");
    return ok(reply, { ...(await publicReportMeta(report)), revision: await revisionView(null, revision.id, { includeInternal: false }) });
  });
  app.get<{ Params: { publicId: string; noticeId: string } }>("/api/v1/public/reports/:publicId/notices/:noticeId", async (request, reply) => {
    const report = await publicReport(request.params.publicId);
    const notice = await noticeView(null, UUID.parse(request.params.noticeId));
    assert(notice.report?.publicId === report.publicId, "NOT_FOUND", "notice not found");
    return ok(reply, notice);
  });
  app.get<{ Params: { publicId: string; version: string; format: string } }>("/api/v1/public/reports/:publicId/versions/:version/export/:format", async (request, reply) => {
    const report = await publicReport(request.params.publicId);
    const format = z.enum(["markdown", "pdf", "docx"]).parse(request.params.format) as ExportFormat;
    const revision = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.reportId, report.id), eq(researchRevision.version, Number(request.params.version))) });
    assert(revision?.version, "NOT_FOUND", "version not found");
    const row = await generateExport({ revisionId: revision.id }, format);
    const file = await exportBytes(row.id);
    return reply.header("content-type", EXPORT_MIME[format]).header("content-disposition", `attachment; filename="${file.filename}"`).send(file.bytes);
  });
  app.get<{ Params: { publicId: string; noticeId: string; format: string } }>("/api/v1/public/reports/:publicId/notices/:noticeId/export/:format", async (request, reply) => {
    const report = await publicReport(request.params.publicId);
    const format = z.enum(["markdown", "pdf", "docx"]).parse(request.params.format) as ExportFormat;
    const notice = await db.query.correctionNotice.findFirst({ where: and(eq(correctionNotice.id, UUID.parse(request.params.noticeId)), eq(correctionNotice.reportId, report.id)) });
    assert(notice, "NOT_FOUND", "notice not found");
    const row = await generateExport({ noticeId: notice.id }, format);
    const file = await exportBytes(row.id);
    return reply.header("content-type", EXPORT_MIME[format]).header("content-disposition", `attachment; filename="${file.filename}"`).send(file.bytes);
  });
  app.get<{ Params: { token: string } }>("/api/v1/demo/inbox/:token", async (request, reply) => {
    const recipient = await db.query.syntheticRecipient.findFirst({ where: eq(syntheticRecipient.tokenHash, hashToken(request.params.token)) });
    assert(recipient, "NOT_FOUND", "inbox not found");
    return ok(reply, await inboxFor(recipient.workspaceId, recipient.id));
  });

  await registerIntakeRoutes(app);
  return app;
}

async function publicReport(publicId: string) {
  const report = await db.query.researchReport.findFirst({ where: eq(researchReport.publicId, z.string().regex(/^[a-z0-9x]{6,16}$/).parse(publicId)) });
  assert(report && report.publicVisible && report.currentRevisionId && report.documentState !== "DRAFT", "NOT_FOUND", "report not found");
  return report;
}

async function publicReportMeta(report: typeof researchReport.$inferSelect) {
  const versions = await db.select({ version: researchRevision.version, documentState: researchRevision.documentState, publishedAt: researchRevision.publishedAt }).from(researchRevision).where(and(eq(researchRevision.reportId, report.id), gt(researchRevision.version, 0))).orderBy(desc(researchRevision.version));
  const notices = await db.select({ id: correctionNotice.id, type: correctionNotice.type, publishedAt: correctionNotice.publishedAt }).from(correctionNotice).where(eq(correctionNotice.reportId, report.id)).orderBy(desc(correctionNotice.publishedAt));
  return {
    report: { publicId: report.publicId, title: report.title, publisherName: report.publisherName, synthetic: report.synthetic, reliability: report.reliability, documentState: report.documentState },
    versions: versions.map((v) => ({ version: v.version, state: v.documentState, publishedAt: v.publishedAt?.toISOString() ?? null })),
    notices: notices.map((n) => ({ id: n.id, type: n.type, publishedAt: n.publishedAt.toISOString() })),
    disclaimer: "Not financial advice. This is a synthetic research note in an Errata demo, built on public SEC filings. Errata cannot revoke copies outside its managed links.",
  };
}

async function inboxFor(workspaceId: string, recipientId: string) {
  const recipient = await db.query.syntheticRecipient.findFirst({ where: and(eq(syntheticRecipient.id, recipientId), eq(syntheticRecipient.workspaceId, workspaceId)) });
  assert(recipient, "NOT_FOUND", "recipient not found");
  const rows = await db.select({ delivery, report: researchReport }).from(delivery).innerJoin(researchRevision, eq(researchRevision.id, delivery.revisionId)).innerJoin(researchReport, eq(researchReport.id, researchRevision.reportId)).where(and(eq(delivery.recipientId, recipient.id), eq(delivery.status, "SIMULATED_DELIVERED"))).orderBy(desc(delivery.deliveredAt));
  return {
    recipient: { displayName: recipient.displayName, organisation: recipient.organisation, address: recipient.address },
    notice: "Simulated inbox. Nothing here was sent by email or any other channel.",
    messages: rows.map(({ delivery: d, report }) => ({ id: d.id, kind: d.kind, subject: d.subject, deliveredAt: d.deliveredAt?.toISOString() ?? null, publicId: report.publicId, noticeId: d.noticeId, attempt: d.attemptCount })),
  };
}

