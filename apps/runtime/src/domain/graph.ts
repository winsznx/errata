import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";

export interface ScopePeriod {
  start: string | null;
  end: string;
  type: "instant" | "duration";
  label: string;
}

export interface FactKeyParts {
  cik: string;
  conceptId: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string;
  dimensions: string;
  unit: string;
}

export function parseFactNode(node: string): FactKeyParts | null {
  if (!node.startsWith("fact:")) return null;
  const [cik, conceptId, periodType, periodStart, periodEnd, dimensions, unit] = node.slice(5).split("|");
  if (!cik || !conceptId || !periodType || periodEnd === undefined || unit === undefined) return null;
  return { cik, conceptId, periodType, periodStart: periodStart || null, periodEnd, dimensions: dimensions ?? "", unit };
}

/** A fact falls in scope when its period ends on the end date of an affected period (balance sheet date or duration end). */
export function factInScope(fact: FactKeyParts, cik: string, periods: ScopePeriod[]): ScopePeriod | null {
  if (fact.cik !== cik) return null;
  return periods.find((p) => p.end === fact.periodEnd && (fact.periodType === "instant" || !p.start || !fact.periodStart || fact.periodStart >= p.start)) ?? null;
}

export async function factNodesForIssuer(tx: DbOrTx, workspaceId: string, cik: string): Promise<string[]> {
  const rows = await tx.execute<{ from_node: string }>(sql`
    select distinct from_node from claim_dependency
    where workspace_id = ${workspaceId} and from_node like ${`fact:${cik}|%`}
  `);
  return rows.map((r) => r.from_node);
}

export interface ReachedClaim {
  claimId: string;
  path: string[];
}

/** Walks dependency edges from the given nodes and returns every reachable claim with the shortest reason path. */
export async function reachableClaims(tx: DbOrTx, workspaceId: string, startNodes: string[]): Promise<ReachedClaim[]> {
  if (!startNodes.length) return [];
  const rows = await tx.execute<{ node: string; path: string[] }>(sql`
    with recursive walk(node, path) as (
      select to_node, array[from_node, to_node]
      from claim_dependency
      where workspace_id = ${workspaceId} and from_node in (${sql.join(startNodes.map((n) => sql`${n}`), sql`, `)})
      union
      select d.to_node, w.path || d.to_node
      from claim_dependency d
      join walk w on d.from_node = w.node
      where d.workspace_id = ${workspaceId} and not (d.to_node = any(w.path)) and array_length(w.path, 1) < 12
    )
    select node, path from walk
  `);
  const best = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.node.startsWith("claim:")) continue;
    const existing = best.get(row.node);
    if (!existing || row.path.length < existing.length) best.set(row.node, row.path);
  }
  return [...best.entries()].map(([node, path]) => ({ claimId: node.slice(6), path })).sort((a, b) => a.claimId.localeCompare(b.claimId));
}
