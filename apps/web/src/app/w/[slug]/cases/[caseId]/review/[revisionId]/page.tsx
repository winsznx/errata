"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DocumentView } from "@/components/document-view";
import { ConfirmDialog, ErrorBox, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, newKey, ws } from "@/lib/api";
import { fmtDateTime, shortHash } from "@/lib/format";
import type { RevisionView } from "@/lib/types";
import { ChangesTable } from "@/components/changes-table";

interface CandidateResponse {
  candidate: RevisionView;
  base: RevisionView | null;
  liveBlockers: string[];
  currentEpochVector: { caseId: string; epoch: number }[];
  reviews: { id: string; decision: string; actorName: string; notes: string | null; valid: boolean; contentHash: string; createdAt: string }[];
  report: { id: string; publicId: string; title: string } | null;
}

export default function ReviewPage() {
  const { caseId, revisionId } = useParams<{ caseId: string; revisionId: string }>();
  const { slug, workspaceId, canAct, principal } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useWs<CandidateResponse>(`/candidates/${revisionId}`, { refreshInterval: 8000 });
  const [dialog, setDialog] = useState<"approve" | "reissue" | "changes" | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (isLoading || !data) return <SkeletonRows rows={10} />;
  const { candidate, base } = data;
  const changes = candidate.notice?.changes ?? [];
  const notice = candidate.notice?.notice;
  const state = candidate.candidateState ?? "DRAFT";
  const approval = data.reviews.find((r) => r.decision === "approve" && r.valid && r.contentHash === candidate.contentHash);
  const isEditor = principal.role === "editor";
  const baseStates = Object.fromEntries((base?.claims ?? []).filter((c) => changes.some((ch) => ch.claimId === c.id) || c.category === "QUALITATIVE").map((c) => [c.id, "INVALIDATED"]));
  const newStates = Object.fromEntries(candidate.claims.filter((c) => c.creationMethod === "verified_placeholder" && c.material).map((c) => [c.id, "VERIFIED_REPLACEMENT"]));

  const act = async (kind: "approve" | "reissue" | "changes") => {
    setBusy(true);
    try {
      if (kind === "reissue") {
        const result = await apiSend<{ version: number; publicUrl: string; noticeUrl: string; queuedDeliveries: number }>(
          "POST",
          ws(workspaceId, `/candidates/${candidate.id}/reissue`),
          { approvalId: approval!.id, candidateHash: candidate.contentHash, expectedBaseRevisionId: candidate.baseRevisionId, evidenceEpochs: candidate.epochVector, confirm: true },
          { idempotencyKey: newKey() },
        );
        toast(`Version ${result.version} reissued. ${result.queuedDeliveries} simulated notices queued.`);
        router.push(`/w/${slug}/research/${candidate.reportId}`);
      } else {
        await apiSend("POST", ws(workspaceId, `/candidates/${candidate.id}/review`), { decision: kind === "approve" ? "approve" : "request_changes", contentHash: candidate.contentHash, epochVector: candidate.epochVector, notes: kind === "changes" ? notes : undefined }, { idempotencyKey: newKey() });
        toast(kind === "approve" ? "Approved this exact draft" : "Changes requested. The Publication Editor will revise the draft.");
        await mutate();
      }
      setDialog(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "The action failed", "error");
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="stack-sm">
          <Link href={`/w/${slug}/cases/${caseId}`} className="small">
            Back to the case
          </Link>
          <h1>Review correction: {data.report?.title}</h1>
          <div className="row">
            <Status value={state} />
            <span className="small muted">
              Draft <span className="num">{shortHash(candidate.contentHash)}</span> from {candidate.createdBy === "publication-editor" ? "the Publication Editor" : candidate.createdBy}, bound to evidence revision {candidate.epochVector?.map((e) => e.epoch).join(", ")}
            </span>
          </div>
        </div>
        <div className="row">
          {state === "PUBLISHED" ? (
            <a className="btn" href={`/p/${data.report?.publicId}`} target="_blank" rel="noreferrer">
              Open public page
            </a>
          ) : (
            <>
              <button type="button" className="btn" disabled={!isEditor || !canAct || state === "PUBLISHED"} onClick={() => setDialog("changes")}>
                Request changes
              </button>
              {state === "APPROVED" && approval ? (
                <button type="button" className="btn btn-primary" disabled={!isEditor || !canAct || data.liveBlockers.length > 0} onClick={() => setDialog("reissue")}>
                  Reissue version {(base?.version ?? 0) + 1}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={!isEditor || !canAct || state !== "READY" || data.liveBlockers.length > 0} onClick={() => setDialog("approve")}>
                  Approve this draft
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {!isEditor ? <p className="small muted">You are in the {principal.role} role. Switch to the editor role to approve or reissue.</p> : null}

      {data.liveBlockers.length ? (
        <div className="banner banner-warn" role="note">
          <strong>Not ready to approve</strong>
          <ul className="plain-list">
            {data.liveBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : state !== "PUBLISHED" ? (
        <div className="banner banner-info" role="note">
          <strong>Every affected figure is verified against the amended filing</strong>
          <span>Approval binds this exact draft and evidence revision. If new evidence arrives, the approval expires and the checks run again.</span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Figures that change</h2>
          <span className="small muted">Previous figures are struck through; corrected figures come from the cited filing or code.</span>
        </div>
        {changes.length ? <ChangesTable changes={changes} /> : <p className="panel-body muted">No figures change in this draft.</p>}
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Published version {base?.version}</h2>
            <span className="small muted">Unchanged; stays in history with its warning</span>
          </div>
          <div className="panel-body">{base ? <DocumentView blocks={base.blocks} claims={base.claims} claimStates={baseStates} /> : null}</div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Corrected draft</h2>
            <span className="small muted">Figures inserted by code from verified values</span>
          </div>
          <div className="panel-body">
            <DocumentView blocks={candidate.blocks} claims={candidate.claims} claimStates={newStates} />
          </div>
        </section>
      </div>

      {notice ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Correction notice preview</h2>
            <span className="small muted">Published with the new version and delivered to the note's synthetic recipients</span>
          </div>
          <div className="panel-body notice-preview">
            <h3>What changed</h3>
            <p>{notice.whatChanged}</p>
            <h3>Why</h3>
            <p>{notice.why}</p>
            <h3>Conclusions</h3>
            <p>{notice.conclusions}</p>
          </div>
        </section>
      ) : null}

      {data.reviews.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Review history</h2>
          </div>
          <ul className="plain-list panel-body">
            {data.reviews.map((r) => (
              <li key={r.id}>
                {r.actorName} {r.decision === "approve" ? "approved" : "requested changes"} at {fmtDateTime(r.createdAt)}
                {r.valid ? "" : " (expired by newer evidence)"}
                {r.notes ? <span className="muted">: {r.notes}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog open={dialog === "approve"} title="Approve this exact draft?" confirmLabel="Approve" busy={busy} onClose={() => setDialog(null)} onConfirm={() => void act("approve")}>
        <p>Approval records your name against draft {shortHash(candidate.contentHash)} and the current evidence revision. It does not publish anything; reissuing is a separate step.</p>
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "reissue"} title={`Reissue as version ${(base?.version ?? 0) + 1}?`} confirmLabel="Reissue now" busy={busy} onClose={() => setDialog(null)} onConfirm={() => void act("reissue")}>
        <p>The public link will show the corrected version. Version {base?.version} stays readable in history with its warning. A correction notice is published and simulated notices go to the note&apos;s synthetic recipients. No real email is sent.</p>
        <p className="small muted">Errata rechecks the evidence and approval inside the same transaction. If anything changed, nothing is published.</p>
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "changes"} title="Request changes" confirmLabel="Send to the Publication Editor" busy={busy} onClose={() => setDialog(null)} onConfirm={() => void act("changes")}>
        <div className="field">
          <label htmlFor="notes">What should change</label>
          <textarea id="notes" className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="For example: say plainly that the company now reports negative working capital." />
        </div>
      </ConfirmDialog>
    </>
  );
}
