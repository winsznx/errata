import "@fastify/cookie";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ENV } from "../config/env.js";
import { db } from "../db/client.js";
import { demoPrincipal, idempotencyRecord, workspace } from "../db/schema.js";
import { DomainError } from "../domain/errors.js";

export const SESSION_COOKIE = "errata_session";
export type Role = "analyst" | "editor" | "operator" | "reader";

export interface Principal {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  role: Role;
  displayName: string;
}

const ROLE_NAMES: Record<Role, string> = {
  editor: "Sam Okafor (demo editor)",
  analyst: "Riley Chen (demo analyst)",
  operator: "Demo operator",
  reader: "Demo reader",
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueSession(reply: FastifyReply, workspaceId: string, role: Role): Promise<Principal> {
  const token = randomBytes(32).toString("base64url");
  const ws = await db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
  if (!ws) throw new DomainError("NOT_FOUND", "workspace not found");
  const expiresAt = ws.expiresAt ?? new Date(Date.now() + ENV.DEMO_TTL_HOURS * 3_600_000);
  const [row] = await db.insert(demoPrincipal).values({ workspaceId, role, displayName: ROLE_NAMES[role], sessionHash: hashToken(token), expiresAt }).returning();
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: ENV.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
  return { id: row!.id, workspaceId, workspaceSlug: ws.slug, role, displayName: row!.displayName };
}

export async function revokeSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await db.update(demoPrincipal).set({ expiresAt: new Date() }).where(eq(demoPrincipal.sessionHash, hashToken(token)));
}

export async function principalFrom(request: FastifyRequest): Promise<Principal | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await db
    .select({ principal: demoPrincipal, slug: workspace.slug })
    .from(demoPrincipal)
    .innerJoin(workspace, eq(workspace.id, demoPrincipal.workspaceId))
    .where(and(eq(demoPrincipal.sessionHash, hashToken(token)), gt(demoPrincipal.expiresAt, new Date())));
  if (!row) return null;
  return { id: row.principal.id, workspaceId: row.principal.workspaceId, workspaceSlug: row.slug, role: row.principal.role, displayName: row.principal.displayName };
}

/** Resolves the caller and checks the path workspace matches the session; a mismatch is reported as not found to avoid confirming that other workspaces exist. */
export async function requirePrincipal(request: FastifyRequest, workspaceId: string, roles?: Role[]): Promise<Principal> {
  const principal = await principalFrom(request);
  if (!principal) throw new DomainError("UNAUTHENTICATED", "start a demo workspace to continue");
  if (principal.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "workspace not found");
  if (roles && !roles.includes(principal.role)) throw new DomainError("FORBIDDEN", `this action needs the ${roles.join(" or ")} role`);
  return principal;
}

export function streamTicket(workspaceId: string, principalId: string, ttlSeconds = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${workspaceId}.${principalId}.${expires}`;
  const signature = createHmac("sha256", ENV.SESSION_SECRET).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${signature}`;
}

export function verifyStreamTicket(ticket: string, workspaceId: string): boolean {
  const [encoded, signature] = ticket.split(".");
  if (!encoded || !signature) return false;
  const body = Buffer.from(encoded, "base64url").toString();
  const expected = createHmac("sha256", ENV.SESSION_SECRET).update(body).digest("base64url");
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  const [ws, , expires] = body.split(".");
  return ws === workspaceId && Number(expires) > Date.now() / 1000;
}

export async function withIdempotency<T>(workspaceId: string, operation: string, key: string | undefined, payload: unknown, run: () => Promise<T>): Promise<T> {
  if (!key) throw new DomainError("INVALID_INPUT", "Idempotency-Key header is required for this action");
  if (key.length > 200) throw new DomainError("INVALID_INPUT", "Idempotency-Key is too long");
  const payloadHash = hashToken(JSON.stringify(payload));
  const existing = await db.query.idempotencyRecord.findFirst({ where: and(eq(idempotencyRecord.workspaceId, workspaceId), eq(idempotencyRecord.operation, operation), eq(idempotencyRecord.key, key)) });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new DomainError("IDEMPOTENCY_MISMATCH", "this Idempotency-Key was already used with a different request");
    return existing.result as T;
  }
  const result = await run();
  await db
    .insert(idempotencyRecord)
    .values({ workspaceId, operation, key, payloadHash, result: result as unknown, statusCode: 200, expiresAt: new Date(Date.now() + 86_400_000) })
    .onConflictDoNothing();
  return result;
}
