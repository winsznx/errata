import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/public-report";
import { fmtDateTime } from "@/lib/format";
import { NotFound, runtimeGet } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Simulated inbox", robots: { index: false } };

interface Inbox {
  recipient: { displayName: string; organisation: string; address: string };
  notice: string;
  messages: { id: string; kind: string; subject: string; deliveredAt: string | null; publicId: string; noticeId: string | null }[];
}

export default async function InboxPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) notFound();
  let inbox: Inbox;
  try {
    inbox = await runtimeGet<Inbox>(`/api/v1/demo/inbox/${token}`);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    throw error;
  }
  return (
    <PublicShell>
      <div className="banner banner-info" role="note">
        <strong>Simulated inbox</strong>
        <span>{inbox.notice} This recipient is fictional.</span>
      </div>
      <header className="stack-sm">
        <h1 className="serif" style={{ fontSize: 28 }}>
          {inbox.recipient.displayName}
        </h1>
        <p className="muted">
          {inbox.recipient.organisation}, {inbox.recipient.address}
        </p>
      </header>
      {inbox.messages.length === 0 ? (
        <p className="muted">No messages yet.</p>
      ) : (
        <ul className="inbox">
          {inbox.messages.map((m) => (
            <li key={m.id}>
              <span className="small muted">{fmtDateTime(m.deliveredAt)}</span>
              <strong>{m.subject}</strong>
              <span>
                {m.kind === "correction_notice" && m.noticeId ? (
                  <>
                    The note you received has been corrected. <Link href={`/p/${m.publicId}/notices/${m.noticeId}`}>Read what changed</Link> or <Link href={`/p/${m.publicId}`}>open the current version</Link>.
                  </>
                ) : (
                  <Link href={`/p/${m.publicId}`}>Open the note</Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PublicShell>
  );
}
