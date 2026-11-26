"use client";

import Link from "next/link";
import { useState } from "react";
import { Empty, ErrorBox, PageHeader, SkeletonRows, Status } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { relative } from "@/lib/format";
import type { ReportRow } from "@/lib/types";

const FILTERS = [
  ["", "All"],
  ["published", "Published"],
  ["affected", "Affected"],
  ["review", "In review"],
  ["superseded", "Has superseded versions"],
  ["draft", "Drafts"],
] as const;

export default function ResearchListPage() {
  const { slug, principal } = useWorkspace();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const { data, error, isLoading, mutate } = useWs<{ items: ReportRow[] }>(`/reports?status=${status}&q=${encodeURIComponent(q)}`);
  const canCreate = principal.role === "analyst" || principal.role === "editor";
  return (
    <>
      <PageHeader
        title="Research"
        subtitle="Notes managed by Errata. Each figure is tied to the filing it came from, so a later disclosure can find it."
        actions={
          canCreate ? (
            <Link className="btn btn-primary" href={`/w/${slug}/research/new`}>
              Add a note
            </Link>
          ) : null
        }
      />
      <div className="spread">
        <div className="row" role="group" aria-label="Filter research">
          {FILTERS.map(([value, label]) => (
            <button key={label} type="button" className="btn btn-sm" aria-pressed={status === value} style={status === value ? { borderColor: "var(--ledger)", color: "var(--ledger-ink)" } : undefined} onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="visually-hidden">Search research</span>
          <input className="input" type="search" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} />
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
          <Empty title="No notes match" action={canCreate ? <Link className="btn" href={`/w/${slug}/research/new`}>Add a note</Link> : null}>
            Clear the filter, or add a note in Markdown or plain text and map its figures to filings.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>Document</th>
                  <th>Reader status</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/w/${slug}/research/${r.id}`} className="serif" style={{ fontSize: 15.5 }}>
                        {r.title}
                      </Link>
                      <div className="small muted">{r.publisherName} (synthetic)</div>
                    </td>
                    <td>
                      <Status value={r.documentState} />
                    </td>
                    <td>
                      <Status value={r.reliability} />
                    </td>
                    <td className="muted">{relative(r.updatedAt)}</td>
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
