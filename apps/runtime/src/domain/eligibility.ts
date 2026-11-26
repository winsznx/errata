import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { sourceDocument, workspace, workspaceSource } from "../db/schema.js";
import { DomainError } from "./errors.js";

/** A source is usable only if it is linked to the workspace, marked eligible, and was public at the workspace's logical time. */
export async function eligibleSource(tx: DbOrTx, workspaceId: string, sourceId: string) {
  const [row] = await tx
    .select({ source: sourceDocument, link: workspaceSource, logicalTime: workspace.logicalTime, mode: workspace.mode })
    .from(workspaceSource)
    .innerJoin(sourceDocument, eq(sourceDocument.id, workspaceSource.sourceId))
    .innerJoin(workspace, eq(workspace.id, workspaceSource.workspaceId))
    .where(and(eq(workspaceSource.workspaceId, workspaceId), eq(workspaceSource.sourceId, sourceId)));
  if (!row || !row.link.eligible) throw new DomainError("INELIGIBLE_SOURCE", "source is not available in this workspace at the current time", { sourceId });
  if (row.mode === "replay" && row.logicalTime && row.link.availableAt > row.logicalTime) {
    throw new DomainError("INELIGIBLE_SOURCE", "source was not yet public at the replay clock", { sourceId });
  }
  return row.source;
}

export async function eligibleSources(tx: DbOrTx, workspaceId: string) {
  const rows = await tx
    .select({ source: sourceDocument, link: workspaceSource, logicalTime: workspace.logicalTime, mode: workspace.mode })
    .from(workspaceSource)
    .innerJoin(sourceDocument, eq(sourceDocument.id, workspaceSource.sourceId))
    .innerJoin(workspace, eq(workspace.id, workspaceSource.workspaceId))
    .where(and(eq(workspaceSource.workspaceId, workspaceId), eq(workspaceSource.eligible, true)));
  return rows.filter((r) => r.mode !== "replay" || !r.logicalTime || r.link.availableAt <= r.logicalTime).map((r) => ({ ...r.source, availableAt: r.link.availableAt }));
}
