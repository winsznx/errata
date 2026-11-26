"use client";

import { ExternalLink, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ExcerptView } from "@/components/evidence";
import { ReplayControl } from "@/components/replay-control";
import { Empty, ErrorBox, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, newKey, ws } from "@/lib/api";
import { describeEvent, eventTone } from "@/lib/event-text";
import { actorLabel, duration, fmtDate, fmtDateTime, fmtTime, money, ROLE_LABEL } from "@/lib/format";
import type { AgentRunView, CaseDetail, ImpactRow } from "@/lib/types";

const HEADLINE: Record<string, string> = {
  DISCOVERED: "A new disclosure from the issuer is being classified",
  INVESTIGATING: "Checking which periods the disclosure covers",
  AWAITING_EVIDENCE: "Prior research is unreliable. Corrected figures are not yet available.",
  VERIFYING: "Checking the amended figures against the filing",
  NEEDS_REVIEW: "A check failed or was challenged and needs attention",
  READY_FOR_APPROVAL: "A verified correction is ready for an editor",
  PARTIALLY_REISSUED: "Some affected notes are reissued; others are still open",
  RESOLVED: "Every affected note has a verified current version",
  NOT_APPLICABLE: "No managed research depends on the affected periods",
  FAILED: "Progress stopped on an operational error; warnings stay in place",
};

const TABS = ["Overview", "Impact", "Evidence", "Review", "Trace"] as const;
type Tab = (typeof TABS)[number];

function AgentStrip({ runs, epoch }: { runs: AgentRunView[]; epoch: number }) {
  const roles = ["filing-monitor", "impact-analyst", "financial-verifier", "publication-editor"];
  return (
    <section className="agent-strip" aria-label="Agents on this case">
      {roles.map((role) => {
        const roleRuns = runs.filter((r) => r.role === role);
        const active = roleRuns.filter((r) => r.status === "STARTED");
        const last = active[0] ?? roleRuns[0];
        return (
          <div key={role} className={`agent ${active.length ? "agent-active" : ""}`}>
            <div className="spread">
              <strong>{ROLE_LABEL[role]}</strong>
              {last ? <Status value={last.status} label={active.length > 1 ? `${active.length} loops running` : undefined} /> : <span className="status">Idle</span>}
            </div>
            <p className="small">{last ? (last.summary ?? `${last.trigger.kind?.replace(/_/g, " ") ?? "Working"}`) : "Waiting for a relevant event"}</p>
            {last ? (
              <p className="small faint">
                {duration(last.startedAt, last.endedAt)} · evidence revision {last.epoch ?? "n/a"}
                {last.epoch !== null && last.epoch < epoch ? " (older)" : ""}
                {last.cloudSessionUrl ? (
                  <>
                    {" · "}
                    <a href={last.cloudSessionUrl} target="_blank" rel="noreferrer">
                      Mozaik Cloud
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function ImpactTable({ impacts, onSelect, selected }: { impacts: ImpactRow[]; onSelect: (id: string) => void; selected: string | null }) {
  const [filter, setFilter] = useState("all");
  const filtered = impacts.filter((i) => filter === "all" || (filter === "candidate" ? i.classification === "candidate" : i.category.toLowerCase() === filter));
  return (
    <div className="stack-sm">
      <div className="row" role="group" aria-label="Filter claims">
        {[
          ["all", "All"],
          ["direct", "Reported"],
          ["derived", "Calculated"],
          ["qualitative", "Conclusions"],
          ["candidate", "Under review"],
        ].map(([value, label]) => (
          <button key={value} type="button" className="btn btn-sm" aria-pressed={filter === value} style={filter === value ? { borderColor: "var(--ledger)", color: "var(--ledger-ink)" } : undefined} onClick={() => setFilter(value!)}>
            {label}
          </button>
        ))}
      </div>
      <div className="table-wrap panel">
        <table className="table">
          <thead>
            <tr>
              <th>Note and claim</th>
              <th className="r">Original</th>
              <th className="r">Corrected</th>
              <th>Evidence</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.impactId} className="clickable" aria-selected={selected === row.impactId} onClick={() => onSelect(row.impactId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(row.impactId)}>
                <td>
                  <div>{row.label}</div>
                  <div className="small muted">{row.reportTitle}</div>
                </td>
                <td className="r num">{row.category === "QUALITATIVE" || !row.original.value ? <span className="muted">Text</span> : <span className={row.state === "VERIFIED_REPLACEMENT" ? "proof-old" : undefined}>{money(row.original.value, row.original.unit, row.original.precision ?? 0)}</span>}</td>
                <td className="r num">
                  {row.category === "QUALITATIVE" ? (
                    <span className="muted">Editor rewrite</span>
                  ) : row.replacement?.status === "VERIFIED" ? (
                    <strong className="proof-new" style={{ marginLeft: 0 }}>
                      {money(row.replacement.value, row.original.unit, row.original.precision ?? 0)}
                    </strong>
                  ) : row.classification === "candidate" ? (
                    <span className="muted">No figure</span>
                  ) : (
                    <span className="muted">Awaiting evidence</span>
                  )}
                </td>
                <td className="small">{row.replacement?.source ? `${row.replacement.source.form}, ${row.replacement.source.column.replace(/_/g, " ")}` : row.replacement?.kind === "formula" ? "Recomputed in code" : <span className="muted">None yet</span>}</td>
                <td>
                  <Status value={row.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImpactDetail({ row, detail }: { row: ImpactRow; detail: CaseDetail }) {
  const proposals = detail.proposals.filter((p) => p.claimId === row.claimId);
  return (
    <section className="panel inspector" aria-label="Claim detail">
      <div className="panel-head">
        <h3>{row.label}</h3>
        <Status value={row.state} />
      </div>
      <div className="panel-body stack">
        <p className="small">{row.reason}</p>
        <dl className="kv">
          <dt>Note</dt>
          <dd>{row.reportTitle}</dd>
          <dt>Printed</dt>
          <dd className="serif">{row.original.text}</dd>
          <dt>Path</dt>
          <dd className="small">{row.path.map((p) => (p.startsWith("fact:") ? p.split("|")[1] : p.startsWith("claim:") ? "claim" : p)).join(" then ")}</dd>
        </dl>
        {proposals.length ? (
          <div className="stack-sm">
            <span className="label">Proposals and checks</span>
            {proposals.map((p) => {
              const attestation = detail.attestations.find((a) => a.proposalId === p.id);
              return (
                <div key={p.id} className="check-block">
                  <div className="spread">
                    <span className="small">
                      {ROLE_LABEL[p.proposer] ?? p.proposer} proposed {p.kind}, revision {p.epoch}
                    </span>
                    <Status value={p.status === "SUPERSEDED" ? "SUPERSEDED_PROPOSAL" : p.status} />
                  </div>
                  {attestation ? (
                    <ul className="checks">
                      {attestation.checks.map((c) => (
                        <li key={c.name} className={c.ok ? "check-ok" : "check-bad"}>
                          <span>{c.ok ? "Pass" : "Fail"}</span> {c.name.replace(/_/g, " ")}: <span className="muted">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {p.statusReason ? <p className="small muted">{p.statusReason}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {row.replacement?.source ? <ExcerptView locatorId={row.replacement.source.locatorId} /> : null}
      </div>
    </section>
  );
}

export default function CaseDeskPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const { slug, workspaceId, canAct, principal } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useWs<CaseDetail>(`/cases/${caseId}`, { refreshInterval: 10_000 });
  const [tab, setTab] = useState<Tab>("Overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const counts = useMemo(() => {
    if (!data) return null;
    const material = data.impacts.filter((i) => i.material && i.classification !== "candidate");
    return { claims: material.length, reports: new Set(material.map((i) => i.reportId)).size, verified: material.filter((i) => ["VERIFIED_REPLACEMENT", "UNCHANGED_VERIFIED"].includes(i.state)).length, review: data.impacts.filter((i) => i.state === "UNDER_REVIEW").length };
  }, [data]);

  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data || !counts) return <SkeletonRows rows={8} />;
  const base = `/w/${slug}`;
  const ready = data.candidates.find((c) => c.state === "READY" || c.state === "APPROVED");
  const failed = data.agentRuns.filter((r) => (r.status === "FAILED" || r.status === "TIMED_OUT") && !data.agentRuns.some((o) => o.taskKey === r.taskKey && o.attempt > r.attempt));
  const running = data.agentRuns.filter((r) => r.status === "STARTED").length;
  const selectedRow = data.impacts.find((i) => i.impactId === selected) ?? null;
  const amendment = data.linkedSources.find((l) => l.relation === "amendment");

  return (
    <>
      <section className="case-head" aria-label="Case status">
        <div className="case-context small muted">
          <span>{data.case.title}</span>
          {data.origin ? (
            <span>
              {data.origin.source.form} <span className="num">{data.origin.source.accession}</span>
            </span>
          ) : null}
          <span>Evidence revision {data.case.evidenceEpoch}</span>
          <span>{running} agent loops running</span>
        </div>
        <div className="spread">
          <div className="stack-sm">
            <h1 className="case-headline">{HEADLINE[data.case.status] ?? data.case.status}</h1>
            <div className="row">
              <Status value={data.case.status} />
              <span className="small muted">
                {counts.claims} affected claims in {counts.reports} {counts.reports === 1 ? "note" : "notes"}, {counts.verified} verified{counts.review ? `, ${counts.review} under review` : ""}
              </span>
            </div>
          </div>
          <div className="row">
            {failed.length ? (
              <button
                type="button"
                className="btn"
                disabled={!canAct || retrying !== null}
                onClick={async () => {
                  const run = failed[0]!;
                  setRetrying(run.id);
                  try {
                    await apiSend("POST", ws(workspaceId, `/cases/${caseId}/retry`), { agentRunId: run.id }, { idempotencyKey: newKey() });
                    toast(`Retrying ${ROLE_LABEL[run.role] ?? run.role}`);
                    await mutate();
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "Retry failed", "error");
                  } finally {
                    setRetrying(null);
                  }
                }}
              >
                <RotateCcw size={15} aria-hidden="true" /> Retry failed check
              </button>
            ) : null}
            {ready ? (
              <Link className="btn btn-primary" href={`${base}/cases/${caseId}/review/${ready.id}`}>
                Review correction
              </Link>
            ) : (
              <ReplayControl compact />
            )}
          </div>
        </div>
        {principal.role === "analyst" && ready ? <p className="small muted">Only the editor role can approve and reissue.</p> : null}
      </section>

      <AgentStrip runs={data.agentRuns} epoch={data.case.evidenceEpoch} />

      <div className="tabs" role="tablist" aria-label="Case views">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
            {t === "Review" && data.candidates.length ? ` (${data.candidates.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <div className="grid-main-side">
          <section className="panel" aria-label="Timeline">
            <div className="panel-head">
              <h2>Timeline</h2>
              <span className="small muted">Filing dates are historical. Times below are when this demo ran.</span>
            </div>
            <ol className="timeline">
              {data.origin ? (
                <li className="tl tl-neutral">
                  <span className="tl-when small">
                    Filed {fmtDate(data.origin.source.filedDate)}, accepted {fmtDateTime(data.origin.source.acceptedAt)}
                  </span>
                  <span>Historical disclosure: {data.origin.source.form} {data.origin.source.accession}</span>
                </li>
              ) : null}
              {amendment ? (
                <li className="tl tl-neutral">
                  <span className="tl-when small">
                    Filed {fmtDate(amendment.source.filedDate)}, accepted {fmtDateTime(amendment.source.acceptedAt)}
                  </span>
                  <span>
                    Historical amendment: {amendment.source.form} {amendment.source.accession}
                  </span>
                </li>
              ) : null}
              {data.timeline
                .filter((e) => !["case.status_changed"].includes(e.type))
                .map((event) => (
                  <li key={event.id} className={`tl tl-${eventTone(event.type)}`}>
                    <span className="tl-when small num">{fmtTime(event.committedAt)}</span>
                    <span>{describeEvent(event)}</span>
                    <span className="small faint">{actorLabel(event.actor)}</span>
                  </li>
                ))}
            </ol>
          </section>
          <aside className="stack">
            <section className="panel">
              <div className="panel-head">
                <h3>Scope</h3>
                {data.case.scopeConfirmed ? <Status value="VERIFIED" label="Independently confirmed" /> : <Status value="PROPOSED" label="Proposed, not yet confirmed" />}
              </div>
              <div className="panel-body">
                {data.case.periods.length ? (
                  <ul className="plain-list">
                    {data.case.periods.map((p) => (
                      <li key={p.end}>
                        {p.label} <span className="small muted num">ending {p.end}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No scope proposed yet.</p>
                )}
                {data.origin ? (
                  <p className="small muted" style={{ marginTop: 8 }}>
                    Proposed by {ROLE_LABEL[data.origin.proposedBy ?? ""] ?? "not yet"}; confirmed by {ROLE_LABEL[data.origin.confirmedBy ?? ""] ?? "nobody yet"}.
                  </p>
                ) : null}
              </div>
            </section>
            {data.challenges.length ? (
              <section className="panel">
                <div className="panel-head">
                  <h3>Challenges</h3>
                </div>
                <ul className="plain-list panel-body">
                  {data.challenges.map((c) => (
                    <li key={c.id} className="stack-sm" style={{ marginBottom: 10 }}>
                      <div className="spread">
                        <span className="small">
                          {ROLE_LABEL[c.raisedBy] ?? c.raisedBy}: {c.reasonCode.toLowerCase().replace(/_/g, " ")}
                        </span>
                        <Status value={c.status === "OPEN" ? "OPEN" : "VERIFIED"} label={c.status === "OPEN" ? "Open" : "Resolved"} />
                      </div>
                      <p className="small muted">{c.explanation}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}

      {tab === "Impact" ? (
        data.impacts.length ? (
          <div className="grid-main-side">
            <ImpactTable impacts={data.impacts} selected={selected} onSelect={setSelected} />
            {selectedRow ? <ImpactDetail row={selectedRow} detail={data} /> : <p className="muted small">Select a claim to see why it is affected and how it was checked.</p>}
          </div>
        ) : (
          <Empty title="No claims are affected yet">Impact appears once the disclosure scope is proposed.</Empty>
        )
      ) : null}

      {tab === "Evidence" ? (
        <div className="grid-2">
          {data.origin ? (
            <section className="panel">
              <div className="panel-head">
                <h3>Non-reliance disclosure</h3>
                <a href={data.origin.source.url} target="_blank" rel="noreferrer" className="small">
                  Open SEC source <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
              <div className="panel-body stack">
                {data.origin.locatorIds.length ? data.origin.locatorIds.slice(0, 2).map((id) => <ExcerptView key={id} locatorId={id} />) : <p className="muted">No excerpt cited yet.</p>}
              </div>
            </section>
          ) : null}
          <section className="panel">
            <div className="panel-head">
              <h3>Independent checks</h3>
            </div>
            <div className="panel-body stack-sm">
              {data.attestations.length === 0 ? (
                <p className="muted">No checks yet. The Financial Verifier reads each proposal's evidence itself before anything can be published.</p>
              ) : (
                data.attestations.map((a) => {
                  const claim = data.impacts.find((i) => data.proposals.find((p) => p.id === a.proposalId)?.claimId === i.claimId);
                  return (
                    <div key={a.id} className="check-block">
                      <div className="spread">
                        <span>{claim?.label ?? "Claim"}</span>
                        <Status value={a.verdict} />
                      </div>
                      <p className="small muted">
                        Revision {a.epoch}
                        {a.valid ? "" : ", expired by newer evidence"}. {a.rationale}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </section>
          {data.linkedSources.map((l) => (
            <section key={l.source.id} className="panel">
              <div className="panel-head">
                <h3>
                  Linked {l.relation}: {l.source.form}
                </h3>
                <a href={l.source.url} target="_blank" rel="noreferrer" className="small">
                  Open SEC source <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
              <div className="panel-body">
                <dl className="kv">
                  <dt>Accession</dt>
                  <dd className="num">{l.source.accession}</dd>
                  <dt>Accepted</dt>
                  <dd>{fmtDateTime(l.source.acceptedAt)}</dd>
                  <dt>Linked by</dt>
                  <dd>{ROLE_LABEL[l.linkedBy] ?? l.linkedBy}</dd>
                  <dt>Opened revision</dt>
                  <dd>{l.epoch}</dd>
                </dl>
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {tab === "Review" ? (
        data.candidates.length ? (
          <section className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Draft</th>
                  <th>State</th>
                  <th>Blockers</th>
                  <th>Prepared</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`${base}/cases/${caseId}/review/${c.id}`}>{data.impacts.find((i) => i.reportId === c.reportId)?.reportTitle ?? "Corrected draft"}</Link>
                    </td>
                    <td>
                      <Status value={c.state} />
                    </td>
                    <td className="small">{c.blockers.length ? c.blockers.join("; ") : "None"}</td>
                    <td className="muted">{fmtDateTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <Empty title="No correction drafted yet">The Publication Editor drafts a correction once every affected figure has a verified replacement.</Empty>
        )
      ) : null}

      {tab === "Trace" ? (
        <section className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Task</th>
                <th>State</th>
                <th className="r">Revision</th>
                <th className="r">Duration</th>
                <th>Native loop</th>
              </tr>
            </thead>
            <tbody>
              {data.agentRuns.map((r) => (
                <tr key={r.id}>
                  <td>{ROLE_LABEL[r.role] ?? r.role}</td>
                  <td>
                    <div>{r.trigger.kind?.replace(/_/g, " ")}</div>
                    {r.summary ? <div className="small muted">{r.summary}</div> : null}
                    {r.errorMessage ? <div className="small" style={{ color: "var(--red)" }}>{r.errorMessage}</div> : null}
                  </td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td className="r num">{r.epoch ?? ""}</td>
                  <td className="r num">{duration(r.startedAt, r.endedAt)}</td>
                  <td className="small">{r.cloudSessionUrl ? <a href={r.cloudSessionUrl} target="_blank" rel="noreferrer">Mozaik Cloud</a> : r.nativeLoopId ? <span className="num">{r.nativeLoopId.slice(0, 8)}</span> : "Not exposed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
