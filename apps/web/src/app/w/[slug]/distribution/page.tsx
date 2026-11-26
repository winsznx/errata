"use client";

import { useState } from "react";
import { Empty, ErrorBox, PageHeader, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, ws } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

interface Distribution {
  recipients: { id: string; inboxPath: string; displayName: string; organisation: string; address: string; subscriptions: string[] }[];
  deliveries: { id: string; kind: string; subject: string; status: string; attempts: number; deliveredAt: string | null; lastError: string | null; recipient: string; recipientId: string; noticeId: string | null; createdAt: string }[];
}

interface Inbox {
  recipient: { displayName: string; organisation: string; address: string };
  notice: string;
  messages: { id: string; kind: string; subject: string; deliveredAt: string | null; publicId: string; noticeId: string | null; attempt: number }[];
}

function InboxPreview({ recipientId }: { recipientId: string }) {
  const { data, error, isLoading } = useWs<Inbox>(`/inbox/${recipientId}`);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <SkeletonRows rows={3} />;
  return (
    <div className="stack-sm">
      <p className="small muted">{data.notice}</p>
      {data.messages.length === 0 ? (
        <p className="muted">Nothing delivered yet.</p>
      ) : (
        <ul className="inbox">
          {data.messages.map((m) => (
            <li key={m.id}>
              <span className="small muted">{fmtDateTime(m.deliveredAt)}</span>
              <strong>{m.subject}</strong>
              <span className="small">
                {m.kind === "correction_notice" && m.noticeId ? (
                  <>
                    <a href={`/p/${m.publicId}/notices/${m.noticeId}`} target="_blank" rel="noreferrer">
                      Read the correction notice
                    </a>{" "}
                    or{" "}
                    <a href={`/p/${m.publicId}`} target="_blank" rel="noreferrer">
                      the current version
                    </a>
                  </>
                ) : (
                  <a href={`/p/${m.publicId}`} target="_blank" rel="noreferrer">
                    Open the note
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DistributionPage() {
  const { workspaceId, principal } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useWs<Distribution>("/distribution", { refreshInterval: 6000 });
  const [inbox, setInbox] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Distribution" subtitle="Simulated delivery only. Recipients are fictional, their addresses end in .invalid, and messages go to an in-app inbox. No email is sent." />
      {error ? <ErrorBox error={error} retry={() => void mutate()} /> : null}
      {isLoading || !data ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="grid-main-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Deliveries</h2>
            </div>
            {data.deliveries.length === 0 ? (
              <Empty title="Nothing delivered yet">Original publications and correction notices appear here when they are delivered to the synthetic inboxes.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Message</th>
                      <th>Recipient</th>
                      <th>State</th>
                      <th className="r">Attempts</th>
                      <th>Delivered</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.deliveries.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <div>{d.subject}</div>
                          <div className="small muted">{d.kind === "correction_notice" ? "Correction notice" : "Original publication"}</div>
                          {d.lastError ? <div className="small" style={{ color: "var(--red)" }}>{d.lastError}</div> : null}
                        </td>
                        <td>{d.recipient}</td>
                        <td>
                          <Status value={d.status} />
                        </td>
                        <td className="r num">{d.attempts}</td>
                        <td className="small">{fmtDateTime(d.deliveredAt)}</td>
                        <td>
                          {d.status === "FAILED" ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={principal.role === "analyst"}
                              onClick={async () => {
                                try {
                                  await apiSend("POST", ws(workspaceId, `/deliveries/${d.id}/retry`));
                                  toast("Delivery queued again with the same delivery key");
                                  await mutate();
                                } catch (e) {
                                  toast(e instanceof Error ? e.message : "Retry failed", "error");
                                }
                              }}
                            >
                              Retry
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <aside className="stack">
            <section className="panel">
              <div className="panel-head">
                <h3>Synthetic recipients</h3>
              </div>
              <ul className="plain-list panel-body">
                {data.recipients.map((r) => (
                  <li key={r.id} className="stack-sm" style={{ marginBottom: 8 }}>
                    <div className="spread">
                      <strong className="small">{r.displayName}</strong>
                      <button type="button" className="btn btn-sm" aria-pressed={inbox === r.id} onClick={() => setInbox(inbox === r.id ? null : r.id)}>
                        {inbox === r.id ? "Hide inbox" : "Open inbox"}
                      </button>
                    </div>
                    <span className="small muted">
                      {r.organisation}, {r.address}
                    </span>
                    <span className="small faint">Receives: {r.subscriptions.join("; ") || "nothing yet"}</span>
                    <a className="small" href={r.inboxPath} target="_blank" rel="noreferrer">
                      Recipient&apos;s own inbox link
                    </a>
                  </li>
                ))}
              </ul>
            </section>
            {inbox ? (
              <section className="panel">
                <div className="panel-head">
                  <h3>Inbox: {data.recipients.find((r) => r.id === inbox)?.displayName}</h3>
                </div>
                <div className="panel-body">
                  <InboxPreview recipientId={inbox} />
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      )}
    </>
  );
}
