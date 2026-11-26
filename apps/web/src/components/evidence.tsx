"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ClaimView, Excerpt } from "@/lib/types";
import { ErrorBox, SkeletonRows } from "./ui";
import { useWs } from "./workspace-context";

export function ExcerptView({ locatorId }: { locatorId: string }) {
  const { data, error, isLoading, mutate } = useWs<Excerpt>(`/locators/${locatorId}`);
  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data) return <SkeletonRows rows={3} />;
  return (
    <div className="stack-sm">
      <p className="small muted">
        Re-read from the stored filing bytes: Form {data.source.form}, accession <span className="num">{data.source.accession}</span>, {data.where}.
      </p>
      {data.cells ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Row</th>
                {data.cells.map((c, i) => (
                  <th key={i} className="r">
                    {c.column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{data.rowLabel}</td>
                {data.cells.map((c, i) => (
                  <td key={i} className="r num">
                    {c.printed}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="small faint" style={{ marginTop: 6 }}>
            {data.scaleNote}
          </p>
        </div>
      ) : (
        <blockquote className="quote">{data.text}</blockquote>
      )}
      <a className="small" href={data.source.url} target="_blank" rel="noreferrer">
        Open the filing on sec.gov <ExternalLink size={12} aria-hidden="true" />
      </a>
      <p className="small faint">Links go to the public SEC copy, which anyone can open. Agents only see filings released by the replay clock.</p>
    </div>
  );
}

export function ClaimInspector({ claim, state, onClose }: { claim: ClaimView; state?: string; onClose?: () => void }) {
  const [openLocator, setOpenLocator] = useState<string | null>(claim.sources[0]?.locatorId ?? null);
  return (
    <section className="panel inspector" aria-label="Claim evidence">
      <div className="panel-head">
        <h3>{claim.label}</h3>
        {onClose ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      <div className="panel-body stack">
        <dl className="kv">
          <dt>Text</dt>
          <dd className="serif" style={{ fontSize: 16 }}>
            {claim.text}
          </dd>
          <dt>Kind</dt>
          <dd>{claim.category === "DIRECT" ? "Reported figure" : claim.category === "DERIVED" ? "Calculated figure" : claim.category === "QUALITATIVE" ? "Conclusion" : "Other text"}</dd>
          {claim.value ? (
            <>
              <dt>Exact value</dt>
              <dd className="num">{claim.value}</dd>
            </>
          ) : null}
          {state ? (
            <>
              <dt>Reliability</dt>
              <dd>{state.toLowerCase().replace(/_/g, " ")}</dd>
            </>
          ) : null}
        </dl>
        {claim.sources.length ? (
          <div className="stack-sm">
            <span className="label">Cited evidence</span>
            {claim.sources.map((s) => (
              <button key={s.locatorId} type="button" className="source-chip" aria-pressed={openLocator === s.locatorId} onClick={() => setOpenLocator(s.locatorId)}>
                <span>
                  {s.form} <span className="num">{s.accession}</span>
                </span>
                <span className="small muted">
                  {s.concept} at {s.periodEnd}, {s.column.replace(/_/g, " ")} column, printed {s.printed}
                </span>
              </button>
            ))}
            {openLocator ? <ExcerptView locatorId={openLocator} /> : null}
          </div>
        ) : claim.derivedFrom.length ? (
          <p className="small muted">Calculated in code from {claim.derivedFrom.length} cited figures. The formula and inputs are stored with the claim.</p>
        ) : (
          <p className="small muted">This text cites no figure directly.</p>
        )}
      </div>
    </section>
  );
}
