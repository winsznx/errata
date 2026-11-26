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

/** Runs a transaction that records domain events, then publishes them only after the commit succeeds. */
export async function commit<T>(work: (tx: Tx, record: (input: EventInput) => Promise<CommittedEvent>) => Promise<T>): Promise<{ result: T; events: CommittedEvent[] }> {
  const events: CommittedEvent[] = [];
  const result = await db.transaction(async (tx) => {
    events.length = 0;
    return work(tx, async (input) => {
      const event = await appendEvent(tx, input);
      events.push(event);
      return event;
    });
  });
  eventBus.emitCommitted(events);
  return { result, events };
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
