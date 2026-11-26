"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DocumentView } from "@/components/document-view";
import { ConfirmDialog, ErrorBox, PageHeader, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, newKey, ws } from "@/lib/api";
import type { RevisionView } from "@/lib/types";

interface ClaimsData {
  revision: RevisionView;
  tokens: { blockId: string; start: number; end: number; text: string }[];
  unmapped: { blockId: string; start: number; end: number; text: string }[];
  readiness: { blockers: string[]; claims: number };
}

interface FactRow {
  id: string;
  label: string;
  concept: string;
  periodEnd: string;
  column: string;
  printed: string;
  scale: number;
  extraction: string;
}

function ManualMap({ token, revision, onDone }: { token: { blockId: string; start: number; end: number; text: string }; revision: RevisionView; onDone: () => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [sourceId, setSourceId] = useState(revision.sources[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [label, setLabel] = useState("");
  const facts = useWs<{ facts: FactRow[] }>(sourceId && q.length >= 2 ? `/sources/${sourceId}?q=${encodeURIComponent(q)}` : null);
  const propose = async (body: Record<string, unknown>) => {
    try {
      await apiSend("POST", ws(workspaceId, `/revisions/${revision.id}/claims`), { blockId: token.blockId, start: token.start, end: token.end, label: label || token.text, ...body });
      toast("Mapping proposed. It still needs an independent check.");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not map this figure", "error");
    }
  };
  return (
    <section className="panel inspector">
      <div className="panel-head">
        <h3>Map &ldquo;{token.text}&rdquo;</h3>
      </div>
      <div className="panel-body stack">
        <div className="field">
          <label htmlFor="label">Label</label>
          <input id="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Total current assets, March 31, 2025" />
        </div>
        <div className="field">
          <label htmlFor="src">Filing</label>
          <select id="src" className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {revision.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.form} {s.accession}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="q">Find the row</label>
          <input id="q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="current assets" />
        </div>
        <ul className="plain-list">
          {(facts.data?.facts ?? []).slice(0, 12).map((f) => (
            <li key={f.id}>
              <button type="button" className="source-chip" style={{ width: "100%" }} onClick={() => void propose({ category: "DIRECT", material: true, factId: f.id })}>
                <span>
                  {f.label} <span className="num">{f.printed}</span>
                  {f.scale ? " (thousands)" : ""}
                </span>
                <span className="small muted">
                  {f.periodEnd}, {f.column.replace(/_/g, " ")}, {f.extraction.startsWith("inline") ? "inline XBRL" : "HTML table"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-sm" onClick={() => void propose({ category: "OTHER", material: false, reason: "Not a financial figure (date, count or label)" })}>
          Mark as not a financial figure
        </button>
      </div>
    </section>
  );
}

export default function ClaimsMappingPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { workspaceId, slug, principal, canAct } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const report = useWs<{ current: RevisionView | null; report: { title: string; documentState: string } }>(`/reports/${reportId}`);
  const revisionId = report.data?.current?.id;
  const { data, error, isLoading, mutate } = useWs<ClaimsData>(revisionId ? `/revisions/${revisionId}/claims` : null, { refreshInterval: 5000 });
  const [token, setToken] = useState<ClaimsData["unmapped"][number] | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const canMap = principal.role === "analyst" || principal.role === "editor";

  if (report.error) return <ErrorBox error={report.error} />;
  if (error) return <ErrorBox error={error} retry={() => void mutate()} />;
  if (!data || isLoading) return <SkeletonRows rows={8} />;
  const draft = data.revision.kind === "draft";
  const claimStates = Object.fromEntries(data.revision.claims.map((c) => [c.id, c.bindingState === "BOUND" ? "BOUND" : c.bindingState ?? ""]));
  const ask = async (path: string, label: string) => {
    setBusy(path);
    try {
      await apiSend("POST", ws(workspaceId, `/revisions/${data.revision.id}/${path}`), undefined, { idempotencyKey: newKey() });
      toast(label);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Request failed", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={`Map figures: ${report.data?.report.title ?? ""}`}
        subtitle="Every figure must point at a filing row, a calculation over mapped figures, or be marked as plain text. A different participant checks each mapping before the note can be published."
        actions={
          <Link className="btn" href={`/w/${slug}/research/${reportId}`}>
            Back to the note
          </Link>
        }
      />
      {draft ? (
        <section className="panel panel-body spread">
          <div className="stack-sm">
            <span>
              {data.revision.claims.length} claims, {data.unmapped.length} figures not mapped yet
            </span>
            {data.readiness.blockers.length ? <span className="small muted">{data.readiness.blockers.length} items block publication</span> : <Status value="READY" label="Every figure is mapped and checked" />}
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={!canMap || !canAct || busy !== null} onClick={() => void ask("extract-claims", "The Impact Analyst is mapping figures to the filings")}>
              Ask the analyst agent to map figures
            </button>
            <button type="button" className="btn" disabled={!canMap || !canAct || busy !== null} onClick={() => void ask("check", "The Financial Verifier is checking each mapping")}>
              Ask the verifier to check mappings
            </button>
            <button type="button" className="btn btn-primary" disabled={principal.role !== "editor" || !canAct || data.readiness.blockers.length > 0} onClick={() => setPublishing(true)}>
              Publish version 1
            </button>
          </div>
        </section>
      ) : (
        <div className="banner banner-info">
          <strong>Published</strong>
          <span>This note is published. Its figures change only through correction drafts.</span>
        </div>
      )}
      <div className="grid-main-side">
        <section className="panel panel-body">
          <DocumentView blocks={data.revision.blocks} claims={data.revision.claims} claimStates={claimStates} />
          {data.readiness.blockers.length ? (
            <div className="stack-sm" style={{ marginTop: 24 }}>
              <span className="label">Blocking publication</span>
              <ul className="plain-list small">
                {data.readiness.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <aside className="stack">
          {token && draft && canMap ? (
            <ManualMap
              token={token}
              revision={data.revision}
              onDone={() => {
                setToken(null);
                void mutate();
              }}
            />
          ) : null}
          <section className="panel">
            <div className="panel-head">
              <h3>Unmapped figures</h3>
            </div>
            <ul className="plain-list panel-body">
              {data.unmapped.length === 0 ? <li className="muted small">None</li> : null}
              {data.unmapped.map((t) => (
                <li key={`${t.blockId}-${t.start}`}>
                  <button type="button" className="btn btn-sm" disabled={!draft || !canMap} aria-pressed={token?.start === t.start && token.blockId === t.blockId} onClick={() => setToken(t)}>
                    {t.text}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Claims</h3>
            </div>
            <ul className="plain-list panel-body">
              {data.revision.claims.map((c) => (
                <li key={c.id} className="spread small">
                  <span>{c.label}</span>
                  <Status value={c.bindingState ?? "UNMAPPED"} />
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
      <ConfirmDialog
        open={publishing}
        title="Publish version 1?"
        confirmLabel="Publish"
        onClose={() => setPublishing(false)}
        onConfirm={async () => {
          try {
            const result = await apiSend<{ publicId: string }>("POST", ws(workspaceId, `/revisions/${data.revision.id}/publish-initial`), { contentHash: data.revision.contentHash, confirm: true }, { idempotencyKey: newKey() });
            toast("Published. Simulated copies went to the synthetic recipients.");
            router.push(`/w/${slug}/research/${reportId}`);
            void result;
          } catch (e) {
            toast(e instanceof Error ? e.message : "Could not publish", "error");
          } finally {
            setPublishing(false);
          }
        }}
      >
        <p>The note gets a stable public link and Errata starts watching its figures. Published text is never edited; later corrections create new versions.</p>
      </ConfirmDialog>
    </>
  );
}
