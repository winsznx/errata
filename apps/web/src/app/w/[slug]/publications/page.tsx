"use client";

import Link from "next/link";
import { ErrorBox, PageHeader, SkeletonRows, Status } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { fmtDate } from "@/lib/format";
import type { ReportRow } from "@/lib/types";

type Publication = ReportRow & { currentVersion: number | null; publishedAt: string | null; versions: number; deliveries: { status: string; n: number }[] };

export default function PublicationsPage() {
  const { slug } = useWorkspace();
  const { data, error, isLoading, mutate } = useWs<Publication[]>("/publications");
  return (
    <>
      <PageHeader title="Publications" subtitle="What readers see at each stable link. Published versions are never edited or deleted; corrections add a new version." />
      <section className="panel">
        {error ? (
          <div className="panel-body">
            <ErrorBox error={error} retry={() => void mutate()} />
          </div>
        ) : isLoading || !data ? (
          <div className="panel-body">
            <SkeletonRows />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>Reader status</th>
                  <th className="r">Current version</th>
                  <th className="r">Versions</th>
                  <th>Published</th>
                  <th>Deliveries of current version</th>
                  <th>Stable link</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/w/${slug}/research/${p.id}`} className="serif" style={{ fontSize: 15 }}>
                        {p.title}
                      </Link>
                    </td>
                    <td>
                      <Status value={p.reliability} />
                    </td>
                    <td className="r num">{p.currentVersion ?? "Draft"}</td>
                    <td className="r num">{p.versions}</td>
                    <td>{fmtDate(p.publishedAt)}</td>
                    <td className="small">{p.deliveries.length ? p.deliveries.map((d) => `${d.n} ${d.status.toLowerCase().replace(/_/g, " ")}`).join(", ") : <span className="muted">None</span>}</td>
                    <td className="small">
                      {p.documentState === "DRAFT" ? (
                        <span className="muted">Not public</span>
                      ) : (
                        <a href={`/p/${p.publicId}`} target="_blank" rel="noreferrer">
                          /p/{p.publicId}
                        </a>
                      )}
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
