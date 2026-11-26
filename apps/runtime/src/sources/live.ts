import { and, eq, lte, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ENV } from "../config/env.js";
import { db } from "../db/client.js";
import { disclosureEvent, sourceDocument, watchSubscription, workspace, workspaceSource } from "../db/schema.js";
import { commit } from "../domain/events.js";
import { putBlob, sha256 } from "./blob-store.js";
import { PARSE_VERSION, extractStoredSource } from "./ingest.js";
import { archiveUrl, padCik, secFetch } from "./sec-client.js";

const SUBMISSIONS = z.object({
  cik: z.union([z.string(), z.number()]),
  name: z.string(),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      form: z.array(z.string()),
      filingDate: z.array(z.string()),
      reportDate: z.array(z.string()),
      acceptanceDateTime: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      items: z.array(z.string()).optional(),
    }),
  }),
});

export interface RecentFiling {
  accession: string;
  form: string;
  filedDate: string;
  reportDate: string | null;
  acceptedAt: string | null;
  primaryDocument: string;
  items: string;
}

export async function issuerName(cik: string): Promise<string> {
  const { bytes } = await secFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
  return SUBMISSIONS.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))).name;
}

export async function recentFilings(cik: string): Promise<RecentFiling[]> {
  const { bytes } = await secFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
  const parsed = SUBMISSIONS.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const r = parsed.filings.recent;
  return r.accessionNumber.map((accession, i) => ({
    accession,
    form: r.form[i]!,
    filedDate: r.filingDate[i]!,
    reportDate: r.reportDate[i] || null,
    acceptedAt: r.acceptanceDateTime[i] || null,
    primaryDocument: r.primaryDocument[i]!,
    items: r.items?.[i] ?? "",
  }));
}

/** Polls due watch subscriptions on live workspaces. New filings are stored, linked and announced exactly once per accession. */
export async function pollWatchlists(options: { workspaceId?: string; force?: boolean } = {}): Promise<{ checked: number; discovered: number; errors: string[] }> {
  const due = await db
    .select({ sub: watchSubscription, ws: workspace })
    .from(watchSubscription)
    .innerJoin(workspace, eq(workspace.id, watchSubscription.workspaceId))
    .where(
      and(
        eq(watchSubscription.active, true),
        eq(workspace.mode, "live"),
        options.workspaceId ? eq(watchSubscription.workspaceId, options.workspaceId) : sql`true`,
        options.force ? sql`true` : or(isNull(watchSubscription.lastCheckedAt), lte(watchSubscription.lastCheckedAt, sql`now() - (${watchSubscription.intervalSeconds} || ' seconds')::interval`)),
      ),
    );
  let discovered = 0;
  const errors: string[] = [];
  for (const { sub } of due) {
    await db.update(watchSubscription).set({ lastCheckedAt: new Date() }).where(eq(watchSubscription.id, sub.id));
    try {
      const filings = (await recentFilings(sub.cik)).filter((f) => sub.forms.includes(f.form)).slice(0, 20);
      for (const filing of filings) {
        const known = await db
          .select({ id: workspaceSource.sourceId })
          .from(workspaceSource)
          .innerJoin(sourceDocument, eq(sourceDocument.id, workspaceSource.sourceId))
          .where(and(eq(workspaceSource.workspaceId, sub.workspaceId), eq(sourceDocument.accession, filing.accession)));
        if (known.length) continue;
        const sourceId = await storeLiveFiling(sub.cik, filing);
        await commit(async (tx, record) => {
          const acceptedAt = filing.acceptedAt ? new Date(filing.acceptedAt) : new Date(`${filing.filedDate}T23:59:59Z`);
          await tx.insert(workspaceSource).values({ workspaceId: sub.workspaceId, sourceId, availableAt: acceptedAt, eligible: true }).onConflictDoNothing();
          const [disclosure] = await tx.insert(disclosureEvent).values({ workspaceId: sub.workspaceId, sourceId, type: filing.form, status: "DISCOVERED", eventKey: filing.accession }).onConflictDoNothing().returning();
          if (!disclosure) return;
          await record({ workspaceId: sub.workspaceId, type: "filing.discovered", actor: { kind: "system", id: "live-monitor" }, payload: { disclosureEventId: disclosure.id, sourceId, cik: sub.cik, accession: filing.accession, form: filing.form, filedDate: filing.filedDate, eligibleAt: acceptedAt.toISOString(), label: `Live EDGAR: ${filing.form} ${filing.items ? `items ${filing.items}` : ""}`.trim() } });
        });
        discovered += 1;
      }
      await db.update(watchSubscription).set({ lastSuccessAt: new Date(), lastError: null }).where(eq(watchSubscription.id, sub.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${sub.cik}: ${message}`);
      await db.update(watchSubscription).set({ lastError: message.slice(0, 500) }).where(eq(watchSubscription.id, sub.id));
    }
  }
  return { checked: due.length, discovered, errors };
}

async function storeLiveFiling(cik: string, filing: RecentFiling): Promise<string> {
  const url = archiveUrl(cik, filing.accession, filing.primaryDocument);
  const { bytes, contentType } = await secFetch(url);
  const hash = sha256(bytes);
  const existing = await db.query.sourceDocument.findFirst({ where: and(eq(sourceDocument.accession, filing.accession), eq(sourceDocument.sha256, hash)) });
  if (existing) return existing.id;
  const { storageRef } = await putBlob(bytes);
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(sourceDocument)
      .values({ cik, accession: filing.accession, form: filing.form, reportDate: filing.reportDate, filedDate: filing.filedDate, acceptedAt: filing.acceptedAt ? new Date(filing.acceptedAt) : null, availabilityPrecision: filing.acceptedAt ? "second" : "date", url, retrievedAt: new Date(), retrievalMode: "live_fetch", contentType, sha256: hash, bytes: bytes.byteLength, storageRef })
      .returning();
    await extractStoredSource(tx, doc!.id, cik, filing.form, bytes);
    await tx.update(sourceDocument).set({ parseVersion: PARSE_VERSION }).where(eq(sourceDocument.id, doc!.id));
    return doc!.id;
  });
}

export function liveMonitorEnabled(): boolean {
  return ENV.ENABLE_LIVE_MONITOR;
}
