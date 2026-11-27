import { EventEmitter } from "node:events";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { domainEvent, workspace } from "../db/schema.js";

export type Actor = { kind: "agent" | "human" | "system"; id: string };

export type CommittedEvent = typeof domainEvent.$inferSelect;

export interface EventInput {
  workspaceId: string;
  type: string;
  actor: Actor;
  caseId?: string | null;
  evidenceEpoch?: number | null;
  correlationId?: string;
  causationId?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

class CommittedEventBus extends EventEmitter {
  emitCommitted(events: CommittedEvent[]): void {
    for (const event of events) this.emit("event", event);
  }
  onCommitted(listener: (event: CommittedEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const eventBus = new CommittedEventBus();
eventBus.setMaxListeners(500);

export async function appendEvent(tx: Tx, input: EventInput): Promise<CommittedEvent> {
  const [counter] = await tx
    .update(workspace)
    .set({ eventSeq: sql`${workspace.eventSeq} + 1` })
    .where(eq(workspace.id, input.workspaceId))
    .returning({ seq: workspace.eventSeq });
  if (!counter) throw new Error(`workspace ${input.workspaceId} not found`);
  const [row] = await tx
    .insert(domainEvent)
    .values({
      workspaceId: input.workspaceId,
      seq: counter.seq,
      type: input.type,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      caseId: input.caseId ?? null,
      evidenceEpoch: input.evidenceEpoch ?? null,
      correlationId: input.correlationId ?? crypto.randomUUID(),
      causationId: input.causationId ?? null,
      payload: input.payload,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error("event insert failed");
  return row;
}

/** Postgres aborts one side of a deadlock or a serialization conflict; that side can safely run again from the start. */
function isRetryableConflict(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (code === "40P01" || code === "40001") return true;
  }
  return false;
}

/**
 * Runs a transaction that records domain events, then publishes them only after the commit succeeds. A transaction
 * that Postgres aborted for a deadlock or serialization conflict is run again, up to three times in all.
 */
export async function commit<T>(work: (tx: Tx, record: (input: EventInput) => Promise<CommittedEvent>) => Promise<T>): Promise<{ result: T; events: CommittedEvent[] }> {
  for (let attempt = 1; ; attempt += 1) {
    const events: CommittedEvent[] = [];
    try {
      const result = await db.transaction(async (tx) =>
        work(tx, async (input) => {
          const event = await appendEvent(tx, input);
          events.push(event);
          return event;
        }),
      );
      eventBus.emitCommitted(events);
      return { result, events };
    } catch (error) {
      if (attempt >= 3 || !isRetryableConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.random() * 30));
    }
  }
}

export function serializeEvent(event: CommittedEvent): Record<string, unknown> {
  return {
    id: event.id,
    seq: event.seq.toString(),
    type: event.type,
    actor: { kind: event.actorKind, id: event.actorId },
    caseId: event.caseId,
    evidenceEpoch: event.evidenceEpoch,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
    committedAt: event.committedAt.toISOString(),
  };
}
