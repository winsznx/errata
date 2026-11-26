"use client";

import Link from "next/link";
import { ReplayControl } from "@/components/replay-control";
import { Empty, PageHeader, SkeletonRows, Status } from "@/components/ui";
import { useLiveEvents, useWorkspace } from "@/components/workspace-context";
import { describeEvent, eventTone } from "@/lib/event-text";
import { actorLabel, fmtTime, relative } from "@/lib/format";

export default function OverviewPage() {
  const { overview, slug, workspaceId } = useWorkspace();
  const live = useLiveEvents(workspaceId);
  if (!overview) return <SkeletonRows rows={6} />;
  const base = `/w/${slug}`;
  const seen = new Set(live.map((e) => e.id));
  const events = [...live].reverse().concat(overview.recentEvents.filter((e) => !seen.has(e.id))).slice(0, 14);
  const c = overview.counts;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={overview.scenario ? overview.scenario.description : "Live EDGAR monitor for the issuers on your watchlist."}
        actions={
          <Link className="btn" href={`${base}/runtime`}>
            Open agent runtime
          </Link>
        }
      />

      {overview.scenario ? (
        <section className="panel" aria-label="Replay">
          <div className="panel-body">
            <ReplayControl />
          </div>
        </section>
      ) : null}

      <section className="metrics" aria-label="Workspace counts">
        <div className="metric">
          <span className="metric-value">{c.activeCases}</span>
          <span className="metric-label">Open correction cases</span>
        </div>
        <div className="metric">
          <span className="metric-value">{c.reportsAtRisk}</span>
          <span className="metric-label">Notes under warning or review</span>
        </div>
        <div className="metric">
          <span className="metric-value">{c.pendingApprovals}</span>
          <span className="metric-label">Corrections ready for approval</span>
        </div>
        <div className="metric">
          <span className="metric-value">{c.runningAgents}</span>
          <span className="metric-label">Agent loops running</span>
        </div>
        <div className="metric">
          <span className="metric-value">{c.publishedReports}</span>
          <span className="metric-label">Published notes</span>
        </div>
      </section>

      <div className="grid-main-side">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Correction cases</h2>
              <Link href={`${base}/cases`} className="small">
                All cases
              </Link>
            </div>
            {overview.cases.length === 0 ? (
              <Empty title="No disclosures have affected your research yet">
                {overview.scenario ? "Play the next disclosure to release Nocera's non-reliance notice. The agents take it from there." : "New filings from your watchlist appear here once they affect a published note."}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Status</th>
                      <th className="r">Evidence revision</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.cases.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <Link href={`${base}/cases/${item.id}`}>{item.title}</Link>
                        </td>
                        <td>
                          <Status value={item.status} />
                        </td>
                        <td className="r num">{item.evidenceEpoch}</td>
                        <td className="muted">{relative(item.lastUpdatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Published research</h2>
              <Link href={`${base}/research`} className="small">
                All research
              </Link>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Note</th>
                    <th>Reader status</th>
                    <th>Public page</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.reports.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`${base}/research/${r.id}`} className="serif" style={{ fontSize: 15 }}>
                          {r.title}
                        </Link>
                        <div className="small muted">{r.publisherName} (synthetic)</div>
                      </td>
                      <td>
                        <Status value={r.reliability} />
                      </td>
                      <td>
                        {r.documentState === "DRAFT" ? (
                          <span className="muted small">Not published</span>
                        ) : (
                          <a href={`/p/${r.publicId}`} target="_blank" rel="noreferrer" className="small">
                            /p/{r.publicId}
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>What just happened</h2>
              <Link href={`${base}/runtime`} className="small">
                Full trace
              </Link>
            </div>
            <ol className="feed">
              {events.map((event) => (
                <li key={event.id} className={`feed-item feed-${eventTone(event.type)}`}>
                  <span className="feed-text">{describeEvent(event)}</span>
                  <span className="feed-meta small faint">
                    {actorLabel(event.actor)} at <span className="num">{fmtTime(event.committedAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Runtime</h2>
            </div>
            <div className="panel-body">
              {overview.runtime ? (
                <dl className="kv">
                  <dt>SDK</dt>
                  <dd>{overview.runtime.sdkVersion}</dd>
                  <dt>Model</dt>
                  <dd>{overview.runtime.model}</dd>
                  <dt>Heartbeat</dt>
                  <dd>{relative(overview.runtime.heartbeatAt)}</dd>
                </dl>
              ) : (
                <p className="muted">The runtime starts when this workspace opens.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
