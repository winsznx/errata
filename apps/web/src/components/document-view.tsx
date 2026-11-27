"use client";

import type { Block, ClaimView } from "@/lib/types";

type ClaimTone = "bound" | "affected" | "review" | "verified";

const TONE_BY_STATE: Record<string, ClaimTone> = {
  INVALIDATED: "affected",
  REJECTED: "affected",
  UNRESOLVED: "affected",
  UNDER_REVIEW: "review",
  REPLACEMENT_PROPOSED: "review",
  PROPOSED: "review",
  AMBIGUOUS: "affected",
  VERIFIED_REPLACEMENT: "verified",
  UNCHANGED_VERIFIED: "verified",
};

interface Props {
  blocks: Block[];
  claims: ClaimView[];
  claimStates?: Record<string, string>;
  selectedClaimId?: string | null;
  onSelectClaim?: (claimId: string) => void;
  hideTitle?: boolean;
}

interface Segment {
  at: number;
  text: string;
  claim: ClaimView | null;
}

function segments(text: string, offset: number, claims: ClaimView[]): Segment[] {
  const inRange = claims.filter((c) => c.start >= offset && c.end <= offset + text.length).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const claim of inRange) {
    const start = claim.start - offset;
    const end = claim.end - offset;
    if (start < cursor) continue;
    if (start > cursor) out.push({ at: offset + cursor, text: text.slice(cursor, start), claim: null });
    out.push({ at: claim.start, text: text.slice(start, end), claim });
    cursor = end;
  }
  if (cursor < text.length) out.push({ at: offset + cursor, text: text.slice(cursor), claim: null });
  return out;
}

export function DocumentView({ blocks, claims, claimStates = {}, selectedClaimId, onSelectClaim, hideTitle }: Props) {
  const render = (text: string, offset: number, blockClaims: ClaimView[]) =>
    segments(text, offset, blockClaims).map((segment) => {
      if (!segment.claim || segment.claim.category === "OTHER") return <span key={segment.at}>{segment.text}</span>;
      const state = claimStates[segment.claim.id] ?? segment.claim.bindingState ?? "";
      const tone = TONE_BY_STATE[state] ?? "bound";
      const label = `${segment.claim.label}${state ? `, ${state.toLowerCase().replace(/_/g, " ")}` : ""}`;
      if (!onSelectClaim) {
        return (
          <span key={segment.at} className={`claim claim-${tone}`} title={label}>
            {segment.text}
          </span>
        );
      }
      return (
        <button key={segment.at} type="button" className={`claim claim-${tone}`} aria-pressed={selectedClaimId === segment.claim.id} aria-label={`${segment.text}: ${label}`} onClick={() => onSelectClaim(segment.claim!.id)}>
          {segment.text}
        </button>
      );
    });

  return (
    <article className="doc">
      {blocks.map((block, index) => {
        const blockClaims = claims.filter((c) => c.blockId === block.id);
        if (block.kind === "heading") {
          if (hideTitle && index === 0) return null;
          return index === 0 ? <h1 key={block.id}>{render(block.text, 0, blockClaims)}</h1> : <h2 key={block.id}>{render(block.text, 0, blockClaims)}</h2>;
        }
        if (block.kind === "table") {
          const rows = block.text.split("\n").map((r) => r.split(" | "));
          let offset = 0;
          const positioned = rows.map((row) =>
            row.map((cell, ci) => {
              const start = offset;
              offset += cell.length + (ci < row.length - 1 ? 3 : 1);
              return { cell, start };
            }),
          );
          const [header, ...body] = positioned;
          return (
            <div key={block.id} className="table-wrap">
              <table className="doc-table">
                <thead>
                  <tr>{header?.map(({ cell, start }) => <th key={start}>{render(cell, start, blockClaims)}</th>)}</tr>
                </thead>
                <tbody>
                  {body.map((row) => (
                    <tr key={row[0]?.start}>{row.map(({ cell, start }) => <td key={start} className="num">{render(cell, start, blockClaims)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "list") {
          let offset = 0;
          return (
            <ul key={block.id}>
              {block.text.split("\n").map((item) => {
                const start = offset;
                offset += item.length + 1;
                return <li key={start}>{render(item, start, blockClaims)}</li>;
              })}
            </ul>
          );
        }
        return <p key={block.id}>{render(block.text, 0, blockClaims)}</p>;
      })}
    </article>
  );
}

export function WarningBanners({ warnings, superseded }: { warnings: { id: string; type: string; headline: string; detail: string }[]; superseded?: React.ReactNode }) {
  return (
    <div className="stack-sm">
      {superseded}
      {warnings.map((w) => (
        <div key={w.id} className={`banner ${w.type === "NON_RELIANCE" ? "banner-danger" : "banner-warn"}`} role="note">
          <strong>{w.headline}</strong>
          <span>{w.detail}</span>
        </div>
      ))}
    </div>
  );
}
