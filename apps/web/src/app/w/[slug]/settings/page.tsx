"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { ConfirmDialog, PageHeader, Status, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/workspace-context";
import { apiSend, fetcher, ws } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

interface Ready {
  database: string;
  migrations: number;
  model: { provider: string; id: string; configured: boolean };
  mozaikCloud: boolean;
  liveMonitor: boolean;
  build: string;
}

export default function SettingsPage() {
  const { workspaceId, overview, principal } = useWorkspace();
  const ready = useSWR<Ready>("/api/v1/ready", fetcher);
  const toast = useToast();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const w = overview?.workspace;
  return (
    <>
      <PageHeader title="Settings" subtitle="This workspace, the demo persona and what the runtime is configured with. Secret values are never shown." />
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Workspace</h2>
          </div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Name</dt>
              <dd>{w?.name}</dd>
              <dt>Mode</dt>
              <dd>{w?.mode === "replay" ? "Historical replay of public filings" : "Live EDGAR monitor"}</dd>
              <dt>Replay clock</dt>
              <dd>{fmtDateTime(w?.logicalTime)}</dd>
              <dt>Expires</dt>
              <dd>{w?.expiresAt ? fmtDateTime(w.expiresAt) : "Kept for judging (reference workspace)"}</dd>
              <dt>Acting as</dt>
              <dd>{principal.displayName}. Switch roles from the bar at the top; editors approve, analysts map evidence, operators run the replay.</dd>
            </dl>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Runtime configuration</h2>
          </div>
          <div className="panel-body">
            {ready.data ? (
              <dl className="kv">
                <dt>Database</dt>
                <dd>
                  <Status value={ready.data.database === "ok" ? "CLEAR" : "FAILED"} label={ready.data.database === "ok" ? `Connected, ${ready.data.migrations} migrations applied` : "Unavailable"} />
                </dd>
                <dt>Model</dt>
                <dd>
                  <Status value={ready.data.model.configured ? "CLEAR" : "FAILED"} label={`${ready.data.model.provider} ${ready.data.model.id}, ${ready.data.model.configured ? "key configured" : "no key configured"}`} />
                </dd>
                <dt>Mozaik Cloud</dt>
                <dd>
                  <Status value={ready.data.mozaikCloud ? "CLEAR" : "UNDER_REVIEW"} label={ready.data.mozaikCloud ? "Project key configured" : "Not configured; loops run without cloud telemetry"} />
                </dd>
                <dt>Live EDGAR polling</dt>
                <dd>{ready.data.liveMonitor ? "On" : "Off"}</dd>
                <dt>Build</dt>
                <dd className="num">{ready.data.build}</dd>
              </dl>
            ) : (
              <p className="muted">Checking runtime health</p>
            )}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Limits and data</h2>
        </div>
        <div className="panel-body stack-sm" style={{ maxWidth: "75ch" }}>
          <p>Errata is an editorial correction tool using public financial information and synthetic research examples. It does not provide investment advice. It cannot guarantee completeness or revoke copies outside its managed publishing interface.</p>
          <p className="muted">This build covers US domestic SEC filers and Markdown or plain-text research. Demo workspaces stop opening a day after they start; this build does not yet delete their data on expiry. Filings are stored as the exact public bytes with their hash.</p>
        </div>
      </section>
      {!w?.isReference ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Start over</h2>
          </div>
          <div className="panel-body spread">
            <p className="muted" style={{ maxWidth: "60ch" }}>
              Opens a fresh copy of this scenario in a new workspace. This workspace ends now; its public links stop working when it expires.
            </p>
            <button type="button" className="btn btn-danger" disabled={principal.role === "analyst"} onClick={() => setConfirm(true)}>
              Start a fresh workspace
            </button>
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title="Start a fresh workspace?"
        confirmLabel="Start fresh"
        danger
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            const result = await apiSend<{ route: string }>("POST", ws(workspaceId, "/demo/reset"), { confirm: true });
            router.push(result.route);
          } catch (e) {
            toast(e instanceof Error ? e.message : "Could not reset", "error");
            setBusy(false);
          }
        }}
      >
        <p>Only this browser&apos;s workspace is affected. Other people&apos;s workspaces and the reference workspace are untouched.</p>
      </ConfirmDialog>
    </>
  );
}
