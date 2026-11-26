import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChangesTable } from "@/components/changes-table";
import { PublicShell } from "@/components/public-report";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { NotFound, runtimeGet } from "@/lib/server-api";
import type { NoticeChange } from "@/lib/types";

export const dynamic = "force-dynamic";

interface NoticeData {
  id: string;
  type: string;
  publishedAt: string;
  contentHash: string;
  previousVersion: number | null;
  replacementVersion: number | null;
  report: { publicId: string; title: string; publisherName: string } | null;
  body: { reportTitle: string; whatChanged: string; why: string; conclusions: string; changes: NoticeChange[]; approvedBy: string; approvedAt: string; disclaimer: string; cases: { title?: string; periods?: { label: string }[] }[] };
}

async function load(publicId: string, noticeId: string): Promise<NoticeData> {
  if (!/^[0-9a-f-]{36}$/.test(noticeId)) notFound();
  try {
    return await runtimeGet<NoticeData>(`/api/v1/public/reports/${encodeURIComponent(publicId)}/notices/${noticeId}`);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ publicId: string; noticeId: string }> }): Promise<Metadata> {
  const { publicId, noticeId } = await params;
  const data = await load(publicId, noticeId);
  return { title: `${data.type === "WITHDRAWAL" ? "Withdrawal" : "Correction"} notice: ${data.body.reportTitle}`, robots: { index: false } };
}

export default async function NoticePage({ params }: { params: Promise<{ publicId: string; noticeId: string }> }) {
  const { publicId, noticeId } = await params;
  const notice = await load(publicId, noticeId);
  const periods = notice.body.cases.flatMap((c) => c.periods ?? []).map((p) => p.label);
  return (
    <PublicShell>
      <div className="public-meta small muted">
        <span>{notice.report?.publisherName} (synthetic publisher)</span>
        <span>Issued {fmtDateTime(notice.publishedAt)} in an Errata demo workspace</span>
      </div>
      <article className="doc stack">
        <h1>
          {notice.type === "WITHDRAWAL" ? "Withdrawal" : "Correction"}: {notice.body.reportTitle}
        </h1>
        <p className="muted" style={{ fontSize: 16 }}>
          {notice.replacementVersion ? (
            <>
              Version {notice.previousVersion} is replaced by <Link href={`/p/${publicId}`}>version {notice.replacementVersion}</Link>. The <Link href={`/p/${publicId}/v/${notice.previousVersion}`}>original text</Link> stays available, unchanged, with a warning.
            </>
          ) : (
            "There is no replacement version."
          )}
        </p>
        <h2>What changed</h2>
        <p>{notice.body.whatChanged}</p>
        <h2>Why</h2>
        <p>{notice.body.why}</p>
        {periods.length ? <p>Periods the issuer said should no longer be relied upon: {periods.join("; ")}.</p> : null}
        <h2>Conclusions</h2>
        <p>{notice.body.conclusions}</p>
      </article>
      {notice.body.changes.length ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <h2>Figures</h2>
            <span className="small muted">Difference is the corrected figure minus the previous one.</span>
          </div>
          <ChangesTable changes={notice.body.changes} />
        </section>
      ) : null}
      <section className="public-foot">
        <div className="row no-print">
          <span className="small muted">Download this notice:</span>
          {(["pdf", "docx", "markdown"] as const).map((f) => (
            <a key={f} className="btn btn-sm" href={`/api/v1/public/reports/${publicId}/notices/${notice.id}/export/${f}`}>
              {f === "markdown" ? "Markdown" : f.toUpperCase()}
            </a>
          ))}
        </div>
        <p className="small muted">
          Approved by {notice.body.approvedBy} on {fmtDate(notice.body.approvedAt)}. {notice.body.disclaimer}
        </p>
        <p className="small faint">Notice {notice.id}, content hash {notice.contentHash.slice(0, 16)}.</p>
      </section>
    </PublicShell>
  );
}
