"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ExcerptView } from "@/components/evidence";
import { Empty, ErrorBox, SkeletonRows } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { fmtDate, fmtDateTime } from "@/lib/format";

interface SourceDetail {
  source: { id: string; cik: string; accession: string; form: string; filedDate: string; reportDate: string | null; acceptedAt: string | null; availabilityPrecision: string; url: string; sha256: string; bytes: number; retrievedAt: string; retrievalMode: string; parseVersion: string | null; conflict: boolean };
  facts: { id: string; label: string; concept: string; periodType: string; periodStart: string | null; periodEnd: string; column: string; printed: string; value: string | null; unit: string; scale: number; dimensions: Record<string, string>; extraction: string; locatorId: string; locatorKind: string }[];
  textSections: { locatorId: string; path: { item?: string; paragraphIndex?: number }; excerpt: string }[];
  claimsCiting: number;
}

const COLUMNS = [
  ["", "All columns"],
  ["as_reported", "As reported"],
  ["adjustment", "Adjustment"],
  ["as_restated", "As restated"],
  ["ordinary", "Ordinary"],
];

export default function SourceDetailPage() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const { slug } = useWorkspace();
  const [column, setColumn] = useState("");
  const [q, setQ] = useState("current");
  const [locator, setLocator] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useWs<SourceDetail>(`/sources/${sourceId}?column=${column}&q=${encodeURIComponent(q)}`);
  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data) return <SkeletonRows rows={8} />;
  const s = data.source;
  return (
    <>
      <header className="page-head">
        <div className="stack-sm">
          <Link href={`/w/${slug}/sources`} className="small">
            All evidence
          </Link>
          <h1>
            Form {s.form}, <span className="num">{s.accession}</span>
          </h1>
          <p className="muted">
            Filed {fmtDate(s.filedDate)}, accepted by SEC {fmtDateTime(s.acceptedAt)}. {data.claimsCiting} claims in this workspace cite it.
          </p>
        </div>
        <a className="btn" href={s.url} target="_blank" rel="noreferrer">
          Open SEC source <ExternalLink size={14} aria-hidden="true" />
        </a>
      </header>
      <section className="panel">
        <div className="panel-body">
          <dl className="kv">
            <dt>Issuer CIK</dt>
            <dd className="num">{s.cik}</dd>
            <dt>Period of report</dt>
            <dd>{s.reportDate ? fmtDate(s.reportDate) : "Not stated"}</dd>
            <dt>Public from</dt>
            <dd>
              {fmtDateTime(s.acceptedAt)} ({s.availabilityPrecision === "second" ? "SEC acceptance time" : "date only, end of day used"})
            </dd>
            <dt>Stored bytes</dt>
            <dd className="num">
              {s.bytes.toLocaleString()} bytes, sha256 {s.sha256}
            </dd>
            <dt>Retrieved</dt>
            <dd>
              {s.retrievalMode === "verified_snapshot" ? "Verified snapshot, hash matches the provenance manifest" : "Fetched live from sec.gov"}, {fmtDateTime(s.retrievedAt)}
            </dd>
            <dt>Parser</dt>
            <dd>{s.parseVersion}</dd>
            {s.conflict ? (
              <>
                <dt>Conflict</dt>
                <dd style={{ color: "var(--red)" }}>Another copy of this accession has different bytes. Both are kept.</dd>
              </>
            ) : null}
          </dl>
        </div>
      </section>

      {data.textSections.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Item sections</h2>
          </div>
          <ol className="plain-list panel-body">
            {data.textSections.map((t) => (
              <li key={t.locatorId} className="stack-sm" style={{ marginBottom: 8 }}>
                <span className="small muted">Item {t.path.item}</span>
                <p className="quote">{t.excerpt}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {data.facts.length || q || column ? (
        <div className="grid-main-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Extracted facts</h2>
              <div className="row">
                <select className="select" style={{ width: "auto", height: 30 }} value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Column">
                  {COLUMNS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <input className="input" style={{ width: 200, height: 30 }} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Label or concept" aria-label="Search facts" />
              </div>
            </div>
            {data.facts.length === 0 ? (
              <Empty title="No facts match">Try a different label, such as total assets or liabilities.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row and concept</th>
                      <th>Period</th>
                      <th>Column</th>
                      <th className="r">Printed</th>
                      <th>Read from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.facts.map((f) => (
                      <tr key={f.id} className="clickable" aria-selected={locator === f.locatorId} onClick={() => setLocator(f.locatorId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setLocator(f.locatorId)}>
                        <td>
                          <div>{f.label}</div>
                          <div className="small faint">{f.concept}</div>
                        </td>
                        <td className="num small">{f.periodStart ? `${f.periodStart} to ${f.periodEnd}` : f.periodEnd}</td>
                        <td className="small">{f.column.replace(/_/g, " ")}</td>
                        <td className="r num">
                          {f.printed}
                          {f.scale ? <div className="small faint">in thousands</div> : null}
                        </td>
                        <td className="small">{f.extraction.startsWith("inline") ? "Inline XBRL" : "HTML table"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <aside>{locator ? <section className="panel inspector"><div className="panel-head"><h3>Source location</h3></div><div className="panel-body"><ExcerptView locatorId={locator} /></div></section> : <p className="small muted">Select a fact to re-read it from the stored filing.</p>}</aside>
        </div>
      ) : null}
    </>
  );
}
