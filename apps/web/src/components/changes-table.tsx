import type { NoticeChange } from "@/lib/types";

export function ChangesTable({ changes }: { changes: NoticeChange[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Figure</th>
            <th>Correction</th>
            <th className="r">Difference</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.claimId}>
              <td>{c.label}</td>
              <td className="num">
                <span className="proof">
                  <span className="proof-old">{c.previous}</span>
                  <span className="proof-caret" aria-hidden="true">
                    ‸
                  </span>
                  <span className="proof-new">{c.replacement}</span>
                </span>
              </td>
              <td className="r num">{c.delta}</td>
              <td className="small">
                {c.kind === "formula"
                  ? "Recomputed in code from verified inputs"
                  : c.sources.map((s) => (
                      <a key={s.accession} href={s.url} target="_blank" rel="noreferrer">
                        {s.form} {s.accession}, {s.column.replace(/_/g, " ")}
                      </a>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

