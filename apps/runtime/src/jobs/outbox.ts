import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../db/client.js";
import { outboxJob } from "../db/schema.js";

export type JobKind = "ingest_event_source" | "agent_task" | "export_artifact" | "deliver" | "watch_poll";
export type Job = typeof outboxJob.$inferSelect;

export async function enqueueJob(
  tx: DbOrTx,
  job: { workspaceId: string | null; kind: JobKind; dedupeKey: string; payload: Record<string, unknown>; eventId?: string; dueAt?: Date; maxAttempts?: number },
): Promise<string | null> {
  const [row] = await tx
    .insert(outboxJob)
    .values({
      workspaceId: job.workspaceId,
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      payload: job.payload,
      eventId: job.eventId ?? null,
      dueAt: job.dueAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning({ id: outboxJob.id });
  return row?.id ?? null;
}

const LEASE_MS = 120_000;

/** Claims due jobs with row locks so concurrent workers never take the same job. */
export async function claimJobs(kinds: JobKind[], limit: number): Promise<Job[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: outboxJob.id })
      .from(outboxJob)
      .where(
        and(
          inArray(outboxJob.kind, kinds),
          lte(outboxJob.dueAt, new Date()),
          sql`(${outboxJob.status} = 'PENDING' or (${outboxJob.status} = 'RUNNING' and ${outboxJob.leaseUntil} < now()))`,
        ),
      )
      .orderBy(outboxJob.dueAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(outboxJob)
      .set({
        status: "RUNNING",
        attempts: sql`${outboxJob.attempts} + 1`,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        leaseToken: sql`gen_random_uuid()`,
        updatedAt: new Date(),
      })
      .where(inArray(outboxJob.id, due.map((d) => d.id)))
      .returning();
  });
}

export async function completeJob(job: Job): Promise<void> {
  await db
    .update(outboxJob)
    .set({ status: "DONE", leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(outboxJob.id, job.id), eq(outboxJob.leaseToken, job.leaseToken!)));
}

export async function failJob(job: Job, error: unknown, retryable: boolean): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = !retryable || job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(60_000, 2 ** job.attempts * 2000) + Math.floor(Math.random() * 1000);
  await db
    .update(outboxJob)
    .set({
      status: exhausted ? "DEAD" : "PENDING",
      lastError: message.slice(0, 2000),
      dueAt: new Date(Date.now() + backoffMs),
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(outboxJob.id, job.id), eq(outboxJob.leaseToken, job.leaseToken!)));
}

export type JobHandler = (job: Job) => Promise<void>;

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = 0;

  constructor(
    private readonly kinds: JobKind[],
    private readonly handler: JobHandler,
    private readonly concurrency: number,
    private readonly isRetryable: (error: unknown) => boolean = () => true,
  ) {}

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const free = this.concurrency - this.running;
    if (free <= 0) return;
    let jobs: Job[];
    try {
      jobs = await claimJobs(this.kinds, free);
    } catch (error) {
      console.error("[jobs] claim failed", error);
      return;
    }
    for (const job of jobs) {
      this.running += 1;
      this.handler(job)
        .then(() => completeJob(job))
        .catch((error: unknown) => failJob(job, error, this.isRetryable(error)))
        .catch((error: unknown) => console.error("[jobs] bookkeeping failed", error))
        .finally(() => {
          this.running -= 1;
        });
    }
  }
}
