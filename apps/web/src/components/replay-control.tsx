"use client";

import { Play } from "lucide-react";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { apiSend, newKey, ws } from "@/lib/api";
import { useToast } from "./ui";
import { useWorkspace } from "./workspace-context";

/** Releases the next scheduled public filing. Pending until the server confirms the replay clock moved. */
export function ReplayControl({ compact = false }: { compact?: boolean }) {
  const { workspaceId, overview, canAct, principal } = useWorkspace();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const scenario = overview?.scenario;
  if (!scenario || overview?.workspace.mode !== "replay") return null;
  const done = !scenario.next;
  const allowed = principal.role === "editor" || principal.role === "operator";
  return (
    <div className={compact ? "row" : "replay"}>
      {!compact ? (
        <div className="stack-sm">
          <span className="small muted">
            Disclosure {Math.min(scenario.position + 1, scenario.total)} of {scenario.total}
          </span>
          <strong>{done ? "Every scheduled filing has been released" : scenario.next!.label}</strong>
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || done || !canAct || !allowed}
        title={!allowed ? "Switch to the editor or operator role to advance the replay" : !canAct ? "Reconnecting to the runtime" : undefined}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await apiSend<{ label?: string; position: number }>("POST", ws(workspaceId, "/replay/advance"), { expectedPosition: scenario.position }, { idempotencyKey: newKey() });
            toast(`Released disclosure ${result.position} of ${scenario.total}. Agents are reacting.`);
            await mutate((key) => typeof key === "string" && key.startsWith(ws(workspaceId)));
          } catch (error) {
            toast(error instanceof Error ? error.message : "Could not advance the replay", "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play size={15} aria-hidden="true" />
        {busy ? "Releasing" : done ? "Replay complete" : "Play next disclosure"}
      </button>
    </div>
  );
}
