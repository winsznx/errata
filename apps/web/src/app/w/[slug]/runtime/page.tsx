"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ErrorBox, PageHeader, SkeletonRows, Status } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { ws } from "@/lib/api";
import { describeEvent } from "@/lib/event-text";
import { actorLabel, duration, fmtTime, relative, ROLE_LABEL } from "@/lib/format";
import type { AgentRunView, DomainEventView } from "@/lib/types";

interface RuntimeData {
  sessions: { id: string; sdkVersion: string; model: string; status: string; startedAt: string; heartbeatAt: string; leaseFence: number }[];
  runs: AgentRunView[];
  metrics: { runs: number; completed: number; failed: number; stale: number; overlappingRunPairs: number; overlapSeconds: number; challenges: number; staleRejections: number; inputTokens: number; outputTokens: number };
  participants: { id: string; name: string; role: string; capabilities: string[] }[];
  sharedState: { logicalTime: string | null; lastEventSeq: string; cases: Record<string, { epoch: number; status: string; scopeConfirmed: boolean }>; activeRuns: { agentRunId: string; role: string; task: string; epoch: number | null }[] };
}

/** Draws each loop as a bar on a shared time axis, so overlap is visible rather than claimed. */
function Lanes({ runs }: { runs: AgentRunView[] }) {
  if (!runs.length) return <p className="muted panel-body">No agent loops have run yet. Release a disclosure to start them.</p>;
  const now = Date.now();
  const start = Math.min(...runs.map((r) => new Date(r.startedAt).getTime()));
  const end = Math.max(...runs.map((r) => (r.endedAt ? new Date(r.endedAt).getTime() : now)));
  const span = Math.max(1, end - start);
  const roles = ["filing-monitor", "impact-analyst", "financial-verifier", "publication-editor"];
  return (
    <div className="lanes" role="img" aria-label="Agent loop timeline. Bars on different rows that share horizontal space ran at the same time.">
      {roles.map((role) => (
        <div key={role} className="lane">
          <span className="lane-label small">{ROLE_LABEL[role]}</span>
          <div className="lane-track">
            {runs
              .filter((r) => r.role === role)
              .map((r) => {
                const left = ((new Date(r.startedAt).getTime() - start) / span) * 100;
                const width = Math.max(0.6, (((r.endedAt ? new Date(r.endedAt).getTime() : now) - new Date(r.startedAt).getTime()) / span) * 100);
                return <span key={r.id} className={`lane-bar lane-${r.status.toLowerCase()}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${r.trigger.kind ?? "task"}: ${r.status.toLowerCase()}, ${duration(r.startedAt, r.endedAt)}`} />;
              })}
          </div>
        </div>
      ))}
      <div className="lane-axis small faint">
        <span>{fmtTime(new Date(start).toISOString())}</span>
        <span>{fmtTime(new Date(end).toISOString())}</span>
      </div>
    </div>
  );
}

export default function RuntimePage() {
  const { workspaceId, slug } = useWorkspace();
  const { data, error, isLoading, mutate } = useWs<RuntimeData>("/runtime", { refreshInterval: 5000 });
  const trace = useWs<{ events: DomainEventView[] }>("/runtime/trace?limit=400");
  const [role, setRole] = useState("all");
  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data) return <SkeletonRows rows={8} />;
  const m = data.metrics;
  const session = data.sessions.find((s) => s.status === "ACTIVE") ?? data.sessions[0];
  const runs = data.runs.filter((r) => role === "all" || r.role === role);
  return (
    <>
      <PageHeader
        title="Agent runtime"
        subtitle="Every Mozaik loop in this workspace, with timings measured from the loops themselves. Native loop ids and Mozaik Cloud links come from the SDK; tool calls and events are recorded by Errata."
        actions={
          <a className="btn" href={ws(workspaceId, "/runtime/trace/export")}>
            <Download size={15} aria-hidden="true" /> Export trace (JSON)
          </a>
        }
      />
      <section className="metrics" aria-label="Runtime measurements">
        <div className="metric">
          <span className="metric-value">{m.runs}</span>
          <span className="metric-label">
            Loops started, {m.completed} completed
          </span>
        </div>
        <div className="metric">
          <span className="metric-value">{m.overlappingRunPairs}</span>
          <span className="metric-label">Pairs of loops that overlapped in time</span>
        </div>
        <div className="metric">
          <span className="metric-value">{m.overlapSeconds}s</span>
          <span className="metric-label">Total overlapping time</span>
        </div>
        <div className="metric">
          <span className="metric-value">{m.challenges}</span>
          <span className="metric-label">Challenges between agents</span>
        </div>
        <div className="metric">
          <span className="metric-value">{m.staleRejections}</span>
          <span className="metric-label">Stale results rejected</span>
        </div>
        <div className="metric">
          <span className="metric-value">{m.failed}</span>
          <span className="metric-label">Failed or timed out</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Loops over time</h2>
          <span className="small muted">Overlap here is loop lifetime. Model calls inside a loop are bounded by the per-workspace concurrency limit.</span>
        </div>
        <div className="panel-body">
          <Lanes runs={data.runs} />
        </div>
      </section>

      <div className="grid-main-side">
        <section className="panel">
          <div className="panel-head">
            <h2>Loops</h2>
            <select className="select" style={{ width: "auto", height: 30 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by agent">
              <option value="all">All agents</option>
              {Object.entries(ROLE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent and task</th>
                  <th>State</th>
                  <th className="r">Revision</th>
                  <th className="r">Duration</th>
                  <th className="r">Tokens</th>
                  <th>Native loop</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div>
                        {ROLE_LABEL[r.role] ?? r.role}: {r.trigger.kind?.replace(/_/g, " ")}
                        {r.attempt > 1 ? `, attempt ${r.attempt}` : ""}
                      </div>
                      {r.summary ? <div className="small muted">{r.summary}</div> : null}
                      {r.errorMessage ? <div className="small" style={{ color: "var(--red)" }}>{r.errorMessage}</div> : null}
                      {r.caseId ? (
                        <Link className="small" href={`/w/${slug}/cases/${r.caseId}`}>
                          Open case
                        </Link>
                      ) : null}
                    </td>
                    <td>
                      <Status value={r.status} />
                    </td>
                    <td className="r num">{r.epoch ?? ""}</td>
                    <td className="r num">{duration(r.startedAt, r.endedAt)}</td>
                    <td className="r num small">{r.inputTokens !== null ? `${r.inputTokens} in, ${r.outputTokens ?? 0} out` : "Not reported"}</td>
                    <td className="small">{r.cloudSessionUrl ? <a href={r.cloudSessionUrl} target="_blank" rel="noreferrer">Mozaik Cloud</a> : r.nativeLoopId ? <span className="num">{r.nativeLoopId.slice(0, 8)}</span> : "Not exposed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="stack">
          <section className="panel">
            <div className="panel-head">
              <h3>Session</h3>
              {session ? <Status value={session.status === "ACTIVE" ? "STARTED" : "EXPIRED"} label={session.status === "ACTIVE" ? "Active" : "Ended"} /> : null}
            </div>
            <div className="panel-body">
              {session ? (
                <dl className="kv">
                  <dt>SDK</dt>
                  <dd>{session.sdkVersion}</dd>
                  <dt>Model</dt>
                  <dd>{session.model}</dd>
                  <dt>Lease</dt>
                  <dd className="num">fence {session.leaseFence}</dd>
                  <dt>Heartbeat</dt>
                  <dd>{relative(session.heartbeatAt)}</dd>
                  <dt>Tokens</dt>
                  <dd className="num">
                    {m.inputTokens} in, {m.outputTokens} out
                  </dd>
                </dl>
              ) : (
                <p className="muted">No session yet.</p>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Participants</h3>
            </div>
            <ul className="plain-list panel-body">
              {data.participants.map((p) => (
                <li key={p.id}>
                  <strong className="small">{ROLE_LABEL[p.name] ?? p.name}</strong> <span className="small muted">{p.role}, {p.capabilities.join(", ")}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Shared state</h3>
              <span className="small muted">What every agent sees</span>
            </div>
            <div className="panel-body stack-sm small">
              <div>Replay clock: {data.sharedState.logicalTime ?? "n/a"}</div>
              <div>Last event: {data.sharedState.lastEventSeq}</div>
              {Object.entries(data.sharedState.cases).map(([id, c]) => (
                <div key={id}>
                  Case {id.slice(0, 8)}: revision {c.epoch}, {c.status.toLowerCase().replace(/_/g, " ")}
                </div>
              ))}
              <div>Active loops: {data.sharedState.activeRuns.length ? data.sharedState.activeRuns.map((r) => `${ROLE_LABEL[r.role] ?? r.role} (${r.task.replace(/_/g, " ")})`).join("; ") : "none"}</div>
            </div>
          </section>
        </aside>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Event trace</h2>
          <span className="small muted">Committed domain events in order</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="r">Seq</th>
                <th>Time</th>
                <th>Event</th>
                <th>By</th>
                <th className="r">Revision</th>
              </tr>
            </thead>
            <tbody>
              {[...(trace.data?.events ?? [])].reverse().map((e) => (
                <tr key={e.id}>
                  <td className="r num faint">{e.seq}</td>
                  <td className="num small">{fmtTime(e.committedAt)}</td>
                  <td>
                    <div>{describeEvent(e)}</div>
                    <div className="small faint">{e.type}</div>
                  </td>
                  <td className="small">{actorLabel(e.actor)}</td>
                  <td className="r num">{e.evidenceEpoch ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
