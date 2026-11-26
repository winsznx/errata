import Link from "next/link";
import { DocumentView, WarningBanners } from "./document-view";
import { Wordmark } from "./app-shell";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { RevisionView } from "@/lib/types";

export interface PublicReportData {
  report: { publicId: string; title: string; publisherName: string; synthetic: boolean; reliability: string; documentState: string };
  versions: { version: number; state: string; publishedAt: string | null }[];
  notices: { id: string; type: string; publishedAt: string }[];
  disclaimer: string;
  revision: RevisionView;
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public">
      <header className="public-head no-print">
        <Wordmark />
        <span className="small muted">Managed research page</span>
      </header>
      <main id="main" className="public-main">
        {children}
      </main>
    </div>
  );
}

export function PublicReport({ data, historical }: { data: PublicReportData; historical: boolean }) {
  const { report, revision, versions } = data;
  const current = versions.find((v) => v.state === "PUBLISHED");
  const isLatest = !historical || current?.version === revision.version;
  const latestNotice = data.notices[0];
  const citations = revision.claims.flatMap((c) => c.sources.map((s) => ({ ...s, label: c.label }))).filter((s, i, all) => all.findIndex((o) => o.accession === s.accession && o.concept === s.concept && o.periodEnd === s.periodEnd && o.column === s.column) === i);

  return (
    <PublicShell>
      <div className="public-meta small muted">
        <span>
          {report.publisherName}
          {report.synthetic ? " (synthetic publisher)" : ""}
        </span>
        <span>
          Version {revision.version}
          {isLatest ? ", current" : ""}
        </span>
        <span>{revision.publicationLabel ?? "Published"} {fmtDate(revision.publishedAt)}</span>
        <span>Research as of {fmtDate(revision.asOf)}</span>
      </div>

      <WarningBanners
        warnings={revision.warnings}
        superseded={
          <>
            {report.documentState === "WITHDRAWN" ? (
              <div className="banner banner-danger" role="note">
                <strong>This note has been withdrawn</strong>
                <span>It should not be relied upon. {latestNotice ? <Link href={`/p/${report.publicId}/notices/${latestNotice.id}`}>Read the withdrawal notice</Link> : null}</span>
              </div>
            ) : null}
            {!isLatest && current ? (
              <div className="banner banner-info" role="note">
                <strong>Superseded by version {current.version}</strong>
                <span>
                  This is the text as it was published, kept unchanged for the record. <Link href={`/p/${report.publicId}`}>Read the current version</Link>
                  {latestNotice ? (
                    <>
                      {" "}
                      or <Link href={`/p/${report.publicId}/notices/${latestNotice.id}`}>the correction notice</Link>
                    </>
                  ) : null}
                  .
                </span>
              </div>
            ) : null}
            {isLatest && latestNotice && latestNotice.type === "CORRECTION" ? (
              <div className="banner banner-info" role="note">
                <strong>Corrected on {fmtDate(latestNotice.publishedAt)}</strong>
                <span>
                  Figures in this version replace figures the issuer later restated. <Link href={`/p/${report.publicId}/notices/${latestNotice.id}`}>See what changed</Link>
                </span>
              </div>
            ) : null}
          </>
        }
      />

      <DocumentView blocks={revision.blocks} claims={revision.claims} />

      {citations.length ? (
        <section className="public-sources">
          <h2>Sources</h2>
          <ol>
            {citations.map((c) => (
              <li key={`${c.accession}-${c.concept}-${c.periodEnd}-${c.column}`}>
                {c.label}: Form {c.form}, accession <span className="num">{c.accession}</span>, {c.column.replace(/_/g, " ")} column, printed {c.printed}.{" "}
                <a href={c.url} target="_blank" rel="noreferrer">
                  SEC filing
                </a>
              </li>
            ))}
          </ol>
          <p className="small muted">Calculated figures such as working capital and ratios are computed in code from the cited figures.</p>
        </section>
      ) : null}

      <section className="public-foot">
        <div className="row no-print">
          <span className="small muted">Download this version:</span>
          <a className="btn btn-sm" href={`/api/v1/public/reports/${report.publicId}/versions/${revision.version}/export/pdf`}>
            PDF
          </a>
          <a className="btn btn-sm" href={`/api/v1/public/reports/${report.publicId}/versions/${revision.version}/export/docx`}>
            DOCX
          </a>
          <a className="btn btn-sm" href={`/api/v1/public/reports/${report.publicId}/versions/${revision.version}/export/markdown`}>
            Markdown
          </a>
        </div>
        {versions.length > 1 ? (
          <nav aria-label="Version history" className="small">
            <span className="muted">Versions: </span>
            {versions.map((v, i) => (
              <span key={v.version}>
                {i > 0 ? ", " : ""}
                {v.version === revision.version ? <strong>version {v.version}</strong> : <Link href={`/p/${report.publicId}/v/${v.version}`}>version {v.version}</Link>} ({fmtDate(v.publishedAt)})
              </span>
            ))}
          </nav>
        ) : null}
        <p className="small muted">{data.disclaimer}</p>
        <p className="small faint">Page generated {fmtDateTime(new Date().toISOString())}.</p>
      </section>
    </PublicShell>
  );
}
