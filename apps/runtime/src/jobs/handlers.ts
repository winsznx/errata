import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { delivery, deliveryAttempt, researchReport } from "../db/schema.js";
import { commit } from "../domain/events.js";
import { generateExport, type ExportFormat } from "../exports/service.js";
import { pollWatchlists } from "../sources/live.js";
import { JobWorker, enqueueJob, type Job } from "./outbox.js";

/** Simulated delivery: writes the notice into the recipient's in-app inbox. No email, SMTP or push is involved. */
async function deliver(job: Job): Promise<void> {
  const deliveryId = String(job.payload.deliveryId);
  const row = await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) });
  if (!row || row.status === "SIMULATED_DELIVERED" || row.status === "CANCELLED") return;
  const attempt = row.attemptCount + 1;
  await db.update(delivery).set({ status: "PROCESSING", attemptCount: attempt, updatedAt: new Date() }).where(eq(delivery.id, row.id));
  const [attemptRow] = await db.insert(deliveryAttempt).values({ deliveryId: row.id, attempt, status: "PROCESSING" }).onConflictDoNothing().returning();
  const report = row.revisionId ? await db.query.researchReport.findFirst({ where: eq(researchReport.currentRevisionId, row.revisionId) }) : null;
  const obsolete = row.kind === "correction_notice" && !report;
  const status = obsolete ? "CANCELLED" : "SIMULATED_DELIVERED";
  await db.update(delivery).set({ status, deliveredAt: obsolete ? null : new Date(), lastError: obsolete ? "A newer version replaced this correction before delivery" : null, updatedAt: new Date() }).where(eq(delivery.id, row.id));
  if (attemptRow) await db.update(deliveryAttempt).set({ status, endedAt: new Date() }).where(eq(deliveryAttempt.id, attemptRow.id));
  await commit(async (_tx, record) => {
    await record({ workspaceId: row.workspaceId, type: obsolete ? "delivery.cancelled" : "delivery.simulated", actor: { kind: "system", id: "outbox" }, payload: { deliveryId: row.id, noticeId: row.noticeId, recipientId: row.recipientId, attempt } });
  });
}

async function exportArtifact(job: Job): Promise<void> {
  const format = String(job.payload.format) as ExportFormat;
  const revisionId = job.payload.revisionId ? String(job.payload.revisionId) : undefined;
  const noticeId = job.payload.noticeId ? String(job.payload.noticeId) : undefined;
  await generateExport({ revisionId, noticeId }, format);
}

export async function retryDelivery(workspaceId: string, deliveryId: string): Promise<void> {
  const row = await db.query.delivery.findFirst({ where: and(eq(delivery.id, deliveryId), eq(delivery.workspaceId, workspaceId)) });
  if (!row || row.status !== "FAILED") throw new Error("only failed deliveries can be retried");
  await db.update(delivery).set({ status: "QUEUED", updatedAt: new Date() }).where(eq(delivery.id, row.id));
  await enqueueJob(db, { workspaceId, kind: "deliver", dedupeKey: `deliver:${row.id}:${row.attemptCount + 1}`, payload: { deliveryId: row.id } });
}

export function startWorkers(options: { liveMonitor: boolean }): JobWorker[] {
  const workers = [
    new JobWorker(["deliver"], deliver, 4),
    new JobWorker(["export_artifact"], exportArtifact, 2),
  ];
  for (const w of workers) w.start(700);
  if (options.liveMonitor) {
    const timer = setInterval(() => {
      pollWatchlists().catch((error: unknown) => console.error("[live-monitor]", error));
    }, 60_000);
    timer.unref();
  }
  return workers;
}
