"use client";

import Link from "next/link";
import { useState } from "react";
import { ReplayControl } from "@/components/replay-control";
import { Empty, ErrorBox, PageHeader, SkeletonRows, Status } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { relative } from "@/lib/format";
import type { CaseRow } from "@/lib/types";

const FILTERS = [
  ["all", "All"],
  ["AWAITING_EVIDENCE", "Awaiting evidence"],
  ["VERIFYING", "Verifying"],
  ["NEEDS_REVIEW", "Needs review"],
  ["READY_FOR_APPROVAL", "Ready for approval"],
  ["RESOLVED", "Resolved"],
] as const;

export default function CasesPage() {
  const { slug } = useWorkspace();
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useWs<{ items: CaseRow[]; nextCursor: string | null }>(`/cases?status=${status}&q=${encodeURIComponent(q)}`);
  return (
    <>
      <PageHeader title="Correction cases" subtitle="One case per disclosure that may affect published research. Newest activity first." actions={<ReplayControl compact />} />
      <div className="spread">
        <div className="row" role="group" aria-label="Filter by status">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" className="btn btn-sm" aria-pressed={status === value} style={status === value ? { borderColor: "var(--ledger)", color: "var(--ledger-ink)" } : undefined} onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="visually-hidden">Search cases</span>
          <input className="input" type="search" placeholder="Search by issuer or filing" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <section className="panel">
        {error ? (
          <div className="panel-body">
            <ErrorBox error={error} retry={() => void mutate()} />
          </div>
        ) : isLoading || !data ? (
          <div className="panel-body">
            <SkeletonRows />
          </div>
        ) : data.items.length === 0 ? (
          <Empty title={status === "all" && !q ? "No cases yet" : "No cases match"}>{status === "all" && !q ? "A case opens when a disclosure says previously issued statements should no longer be relied upon." : "Try another status or clear the search."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Status</th>
                  <th className="r">Affected claims</th>
                  <th className="r">Notes</th>
                  <th className="r">Open challenges</th>
                  <th className="r">Revision</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/w/${slug}/cases/${c.id}`}>{c.title}</Link>
                      <div className="small muted">{c.periods.map((p) => p.label).join("; ") || "Scope not proposed yet"}</div>
                    </td>
                    <td>
                      <Status value={c.status} />
                    </td>
                    <td className="r num">{c.affectedClaims}</td>
                    <td className="r num">{c.affectedReports}</td>
                    <td className="r num">{c.openChallenges}</td>
                    <td className="r num">{c.evidenceEpoch}</td>
                    <td className="muted">{relative(c.lastUpdatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
