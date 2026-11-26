"use client";

import Link from "next/link";
import { useState } from "react";
import { Empty, ErrorBox, PageHeader, SkeletonRows } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { fmtDate, fmtDateTime, shortHash } from "@/lib/format";

interface SourceRow {
  id: string;
  cik: string;
  issuer: string;
  accession: string;
  form: string;
  filedDate: string;
  acceptedAt: string | null;
  availableAt: string;
  url: string;
  sha256: string;
  bytes: number;
  retrievalMode: string;
  facts: number;
}

export default function SourcesPage() {
  const { slug, overview } = useWorkspace();
  const [form, setForm] = useState("");
  const { data, error, isLoading, mutate } = useWs<{ items: SourceRow[]; notYetPublic: number }>(`/sources?form=${encodeURIComponent(form)}&limit=100`);
  return (
    <>
      <PageHeader title="Evidence" subtitle="Public SEC filings available in this workspace at the current replay time. Each is stored as the exact bytes SEC served, with its hash." />
      {data?.notYetPublic ? (
        <p className="small muted">
          {data.notYetPublic} scheduled {data.notYetPublic === 1 ? "filing is" : "filings are"} not public yet at the replay clock ({fmtDateTime(overview?.workspace.logicalTime)}). They are hidden from you and from the agents until released.
        </p>
      ) : null}
      <div className="row" role="group" aria-label="Filter by form">
        {["", "10-Q", "10-Q/A", "10-K/A", "8-K"].map((f) => (
          <button key={f || "all"} type="button" className="btn btn-sm" aria-pressed={form === f} onClick={() => setForm(f)}>
            {f || "All forms"}
          </button>
        ))}
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
          <Empty title="No filings match">Try another form, or release the next disclosure from the overview.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Filing</th>
                  <th>Issuer</th>
                  <th>Filed</th>
                  <th>Public from</th>
                  <th className="r">Facts</th>
                  <th>Integrity</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/w/${slug}/sources/${s.id}`}>
                        {s.form} <span className="num">{s.accession}</span>
                      </Link>
                    </td>
                    <td>{s.issuer}</td>
                    <td>{fmtDate(s.filedDate)}</td>
                    <td className="small">{fmtDateTime(s.availableAt)}</td>
                    <td className="r num">{s.facts}</td>
                    <td className="small">
                      <span className="num">sha256 {shortHash(s.sha256)}</span>
                      <div className="faint">{s.retrievalMode === "verified_snapshot" ? "Verified snapshot" : "Fetched live"}</div>
                    </td>
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
