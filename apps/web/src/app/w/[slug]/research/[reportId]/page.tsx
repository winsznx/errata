"use client";

import { Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { DocumentView, WarningBanners } from "@/components/document-view";
import { ClaimInspector } from "@/components/evidence";
import { ErrorBox, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, ws } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { ReportRow, RevisionView } from "@/lib/types";

interface ReportDetail {
  report: ReportRow;
  current: RevisionView | null;
  claimStates: Record<string, string>;
  versions: { id: string; version: number | null; kind: string; documentState: string; candidateState: string | null; createdAt: string; publishedAt: string | null; createdBy: string }[];
  history: { type: string; reason: string; actor: string; revisionId: string | null; at: string }[];
  notices: { id: string; type: string; publishedAt: string; replacementRevisionId: string | null }[];
  cases: { id: string; title: string; status: string }[];
  candidate: { id: string; state: string } | null;
}

function ExportButtons({ revisionId }: { revisionId: string }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="row" role="group" aria-label="Download this version">
      {(["pdf", "docx", "markdown"] as const).map((format) => (
        <button
          key={format}
          type="button"
          className="btn btn-sm"
          disabled={busy !== null}
          aria-busy={busy === format}
          onClick={async () => {
            setBusy(format);
            try {
              const result = await apiSend<{ downloadUrl: string; filename: string }>("POST", ws(workspaceId, "/exports"), { revisionId, format });
              const link = document.createElement("a");
              link.href = result.downloadUrl;
              link.download = result.filename;
              link.click();
            } catch (e) {
              toast(e instanceof Error ? e.message : "Export failed", "error");
            } finally {
              setBusy(null);
            }
          }}
        >
          <Download size={14} aria-hidden="true" />
          {busy === format ? "Preparing" : format === "markdown" ? "Markdown" : format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function ResearchDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { slug } = useWorkspace();
  const { data, error, isLoading, mutate } = useWs<ReportDetail>(`/reports/${reportId}`);
  const [selected, setSelected] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data) return <SkeletonRows rows={10} />;
  const { report, current } = data;
  const base = `/w/${slug}`;
  const claim = current?.claims.find((c) => c.id === selected) ?? null;
  const published = data.versions.filter((v) => v.version !== null);

  return (
    <>
      <header className="page-head">
        <div className="stack-sm">
          <Link href={`${base}/research`} className="small">
            All research
          </Link>
          <div className="row">
            <Status value={report.reliability} />
            <span className="small muted">
              {report.publisherName} (synthetic publisher), version {current?.version ?? "draft"}, research as of {fmtDate(current?.asOf)}
            </span>
          </div>
        </div>
        <div className="row">
          {report.documentState === "DRAFT" && current ? (
            <Link className="btn btn-primary" href={`${base}/research/${report.id}/claims`}>
              Map figures to evidence
            </Link>
          ) : (
            <a className="btn" href={`/p/${report.publicId}`} target="_blank" rel="noreferrer">
              Public page <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {current?.version ? <ExportButtons revisionId={current.id} /> : null}
        </div>
      </header>

      {current ? (
        <WarningBanners
          warnings={current.warnings}
          superseded={
            data.candidate && data.cases[0] ? (
              <div className="banner banner-info">
                <strong>A corrected draft is {data.candidate.state === "READY" ? "ready for review" : data.candidate.state.toLowerCase().replace(/_/g, " ")}</strong>
                <Link href={`${base}/cases/${data.cases[0].id}/review/${data.candidate.id}`}>Open the review</Link>
              </div>
            ) : null
          }
        />
      ) : null}

      <div className="grid-main-side">
        <section className="panel">
          <div className="panel-body">
            {current ? (
              <>
                <DocumentView blocks={current.blocks} claims={current.claims} claimStates={data.claimStates ?? {}} selectedClaimId={selected} onSelectClaim={setSelected} />
                <p className="small muted" style={{ marginTop: 24 }}>
                  Underlined figures are tied to filing evidence. Select one to see its source. {current.publicationLabel ? `${current.publicationLabel}: ${fmtDateTime(current.publishedAt)}.` : ""}
                </p>
              </>
            ) : (
              <p className="muted">This note has no version yet.</p>
            )}
          </div>
        </section>
        <aside className="stack">
          {claim ? <ClaimInspector claim={claim} state={data.claimStates?.[claim.id]} onClose={() => setSelected(null)} /> : null}
          <section className="panel">
            <div className="panel-head">
              <h3>Versions</h3>
            </div>
            <ul className="plain-list panel-body">
              {published.length === 0 ? <li className="muted">Not published yet</li> : null}
              {published.map((v) => (
                <li key={v.id} className="spread">
                  <a href={`/p/${report.publicId}/v/${v.version}`} target="_blank" rel="noreferrer">
                    Version {v.version}
                  </a>
                  <span className="row">
                    <Status value={v.documentState} />
                    <span className="small muted">{fmtDate(v.publishedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {data.notices.length ? (
            <section className="panel">
              <div className="panel-head">
                <h3>Notices</h3>
              </div>
              <ul className="plain-list panel-body">
                {data.notices.map((n) => (
                  <li key={n.id}>
                    <a href={`/p/${report.publicId}/notices/${n.id}`} target="_blank" rel="noreferrer">
                      {n.type === "WITHDRAWAL" ? "Withdrawal" : "Correction"} notice
                    </a>{" "}
                    <span className="small muted">{fmtDateTime(n.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.cases.length ? (
            <section className="panel">
              <div className="panel-head">
                <h3>Cases</h3>
              </div>
              <ul className="plain-list panel-body">
                {data.cases.map((c) => (
                  <li key={c.id} className="stack-sm">
                    <Link href={`${base}/cases/${c.id}`}>{c.title}</Link>
                    <Status value={c.status} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="panel">
            <div className="panel-head">
              <h3>Publication history</h3>
            </div>
            <ol className="plain-list panel-body small">
              {data.history.map((h, i) => (
                <li key={i}>
                  <strong>{h.type.charAt(0) + h.type.slice(1).toLowerCase()}</strong> <span className="muted">{fmtDateTime(h.at)}</span>
                  <div className="muted">{h.reason}</div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}
