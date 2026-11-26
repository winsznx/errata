"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBox, PageHeader, SkeletonRows, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, ws } from "@/lib/api";
import { fmtDate } from "@/lib/format";

interface SourceRow {
  id: string;
  cik: string;
  issuer: string;
  accession: string;
  form: string;
  filedDate: string;
  availableAt: string;
}

const MAX_BYTES = 256 * 1024;

export default function NewResearchPage() {
  const { workspaceId, slug, overview } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const sources = useWs<{ items: SourceRow[] }>("/sources?limit=100");
  const [title, setTitle] = useState("");
  const [asOf, setAsOf] = useState(() => (overview?.workspace.logicalTime ?? new Date().toISOString()).slice(0, 10));
  const [picked, setPicked] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const issuers = [...new Set((sources.data?.items ?? []).filter((s) => picked.includes(s.id)).map((s) => s.cik))];
  const asOfIso = `${asOf}T23:59:59Z`;

  const submit = async () => {
    setProblem(null);
    if (title.trim().length < 5) return setProblem("Give the note a title of at least five characters.");
    if (!picked.length) return setProblem("Choose at least one filing the note relies on, so its figures can be checked.");
    if (markdown.trim().length < 20) return setProblem("Paste the note text or upload a .md or .txt file.");
    if (new Blob([markdown]).size > MAX_BYTES) return setProblem("The note is larger than 256 KiB.");
    setBusy(true);
    try {
      const body = { title, issuerCiks: issuers, asOf: asOfIso, sourceIds: picked };
      const result = filename
        ? await apiSend<{ reportId: string }>("POST", ws(workspaceId, "/reports/import"), { ...body, filename, content: markdown })
        : await apiSend<{ reportId: string }>("POST", ws(workspaceId, "/reports"), { ...body, markdown });
      toast("Draft saved. Next, map its figures to the filings.");
      router.push(`/w/${slug}/research/${result.reportId}/claims`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not save the draft");
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Add a research note" subtitle="Paste or upload public or synthetic research in Markdown or plain text. Do not add private or client material. Figures must be tied to filings before the note can be published." />
      {problem ? (
        <div className="error-box" role="alert">
          <strong>Not saved</strong>
          <span>{problem}</span>
        </div>
      ) : null}
      <div className="grid-main-side">
        <section className="panel panel-body stack">
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="asof">Research as of</label>
            <input id="asof" className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ maxWidth: 220 }} />
            <span className="hint">Only filings public by the end of this day can back the note&apos;s figures.</span>
          </div>
          <div className="field">
            <label htmlFor="body">Note text</label>
            <textarea id="body" className="textarea" value={markdown} onChange={(e) => { setMarkdown(e.target.value); setFilename(null); }} placeholder={"# Title\n\nWrite the note. Use pipe tables for figures if you like."} />
            <div className="row">
              <label className="btn btn-sm" htmlFor="file">
                Upload .md or .txt
              </label>
              <input
                id="file"
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="visually-hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (!/\.(md|markdown|txt)$/i.test(file.name)) return setProblem("Only .md and .txt files are supported.");
                  if (file.size > MAX_BYTES) return setProblem("That file is larger than 256 KiB.");
                  const text = await file.text();
                  if (text.includes("\u0000")) return setProblem("That file is not plain text.");
                  setMarkdown(text);
                  setFilename(file.name);
                  if (!title) setTitle((text.match(/^#\s+(.+)$/m)?.[1] ?? file.name.replace(/\.\w+$/, "")).slice(0, 200));
                }}
              />
              {filename ? <span className="small muted">Loaded {filename}</span> : null}
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Saving" : "Save draft"}
            </button>
          </div>
        </section>
        <aside className="panel">
          <div className="panel-head">
            <h3>Filings the note relies on</h3>
          </div>
          <div className="panel-body stack-sm">
            {sources.error ? <ErrorBox error={sources.error} /> : null}
            {!sources.data ? (
              <SkeletonRows />
            ) : (
              sources.data.items.map((s) => {
                const tooLate = s.availableAt > asOfIso;
                return (
                  <label key={s.id} className="pick" aria-disabled={tooLate}>
                    <input type="checkbox" disabled={tooLate} checked={picked.includes(s.id)} onChange={(e) => setPicked((all) => (e.target.checked ? [...all, s.id] : all.filter((x) => x !== s.id)))} />
                    <span>
                      <span className="small">
                        {s.issuer}, {s.form} <span className="num">{s.accession}</span>
                      </span>
                      <span className="small muted">{tooLate ? `Not public until ${fmtDate(s.availableAt)}` : `Filed ${fmtDate(s.filedDate)}`}</span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
