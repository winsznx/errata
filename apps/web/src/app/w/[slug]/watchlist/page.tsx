"use client";

import { useState } from "react";
import { ErrorBox, PageHeader, SkeletonRows, Status, useToast } from "@/components/ui";
import { useWorkspace, useWs } from "@/components/workspace-context";
import { apiSend, ws } from "@/lib/api";
import { relative } from "@/lib/format";

interface Watch {
  cik: string;
  name: string;
  active: boolean;
  forms: string[];
  intervalSeconds: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export default function WatchlistPage() {
  const { workspaceId, overview, principal, canAct } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useWs<Watch[]>("/watchlist");
  const [cik, setCik] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const replay = overview?.workspace.mode === "replay";
  const canEdit = principal.role !== "reader";

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      toast(success);
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That did not work", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Watchlist"
        subtitle={replay ? "Issuers this workspace follows. In a historical replay, new filings arrive on the replay clock from verified snapshots, not from live polling." : "Issuers polled on SEC EDGAR for 8-K, 10-K, 10-Q and amendments. Polling is rate limited and declares a contact as SEC requires."}
        actions={
          !replay ? (
            <button type="button" className="btn" disabled={!canAct || busy !== null} onClick={() => void run("refresh", () => apiSend("POST", ws(workspaceId, "/watchlist/refresh")), "Checked EDGAR for new filings")}>
              {busy === "refresh" ? "Checking EDGAR" : "Refresh filings"}
            </button>
          ) : null
        }
      />
      {canEdit ? (
        <form
          className="panel panel-body row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^\d{1,10}$/.test(cik)) {
              toast("Enter a CIK of up to ten digits", "error");
              return;
            }
            void run("add", () => apiSend("POST", ws(workspaceId, "/watchlist"), { cik }), "Issuer added to the watchlist").then(() => setCik(""));
          }}
        >
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="cik">Add an issuer by SEC CIK</label>
            <input id="cik" className="input" inputMode="numeric" value={cik} onChange={(e) => setCik(e.target.value.replace(/\D/g, ""))} placeholder="1756180" />
          </div>
          <button type="submit" className="btn" style={{ alignSelf: "flex-end" }} disabled={busy !== null || !cik}>
            {busy === "add" ? "Looking up" : "Add issuer"}
          </button>
          <span className="hint" style={{ alignSelf: "flex-end" }}>
            The name is looked up on EDGAR. Removing an issuer keeps its evidence.
          </span>
        </form>
      ) : null}
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
                  <th>Issuer</th>
                  <th>Forms</th>
                  <th>State</th>
                  <th>Last check</th>
                  <th>Last success</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((w) => (
                  <tr key={w.cik}>
                    <td>
                      <div>{w.name}</div>
                      <div className="small faint num">CIK {w.cik}</div>
                    </td>
                    <td className="small">{w.forms.join(", ")}</td>
                    <td>{w.lastError ? <Status value="FAILED" label="Last check failed" /> : w.active ? <Status value="CLEAR" label="Watching" /> : <Status value="EXPIRED" label="Paused" />}</td>
                    <td className="small">{replay ? "Replay clock" : relative(w.lastCheckedAt)}</td>
                    <td className="small">
                      {replay ? "Not polled" : relative(w.lastSuccessAt)}
                      {w.lastError ? <div style={{ color: "var(--red)" }}>{w.lastError}</div> : null}
                    </td>
                    <td>
                      {canEdit && w.active ? (
                        <button type="button" className="btn btn-sm btn-quiet" disabled={busy !== null} onClick={() => void run(w.cik, () => apiSend("DELETE", ws(workspaceId, `/watchlist/${w.cik}`)), `Stopped watching ${w.name}`)}>
                          Stop watching
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
    </>
  );
}
