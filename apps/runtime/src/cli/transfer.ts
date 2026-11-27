import { readFile, writeFile } from "node:fs/promises";
import { sqlClient } from "../db/client.js";

/**
 * Copies one finished workspace between databases, so a real recorded run can be published as a read-only
 * reference workspace on the hosted deployment without spending model budget there.
 *
 * Rows are moved as Postgres JSON so every column keeps its exact type. The SEC corpus (filings, locators, facts)
 * is shared by all workspaces and each database gave it its own ids, so those ids are remapped by natural key:
 * filing by accession and hash, locator by filing, kind and excerpt hash, fact by locator, column and concept.
 */

const OWNED_TABLES = [
  "workspace_source",
  "synthetic_recipient",
  "watch_subscription",
  "research_report",
  "research_revision",
  "claim",
  "claim_binding",
  "claim_dependency",
  "calculation",
  "correction_case",
  "disclosure_event",
  "replacement_proposal",
  "verification_attestation",
  "challenge",
  "report_warning",
  "editorial_review",
  "correction_notice",
  "delivery",
  "publication_status_event",
  "artifact_export",
  "runtime_session",
  "agent_run",
  "domain_event",
  "evaluation_run",
] as const;

/** Child tables without a workspace_id column, with the parent column that scopes them. */
const CHILD_TABLES = [
  { table: "case_source", column: "case_id", parent: "correction_case" },
  { table: "claim_impact", column: "case_id", parent: "correction_case" },
  { table: "delivery_attempt", column: "delivery_id", parent: "delivery" },
  { table: "publication_recipient", column: "report_id", parent: "research_report" },
  { table: "tool_call", column: "agent_run_id", parent: "agent_run" },
] as const;

interface CorpusKeys {
  sources: { id: string; accession: string; sha256: string }[];
  locators: { id: string; source_id: string; kind: string; excerpt_hash: string }[];
  facts: { id: string; locator_id: string; source_column: string; concept_id: string }[];
}

interface WorkspaceExport {
  format: "errata-workspace/1";
  exportedAt: string;
  slug: string;
  rows: Record<string, unknown[]>;
  corpus: CorpusKeys;
}

async function rowsOf(table: string, column: string, ids: string[]): Promise<unknown[]> {
  if (!ids.length) return [];
  const [row] = await sqlClient.unsafe(`select coalesce(json_agg(t), '[]'::json) as rows from ${table} t where ${column}::text = any($1::text[])`, [ids]);
  return (row?.rows as unknown[]) ?? [];
}

export async function exportWorkspace(slug: string, file: string): Promise<{ tables: number; rows: number }> {
  const [ws] = await sqlClient`select id from workspace where slug = ${slug}`;
  if (!ws) throw new Error(`workspace ${slug} not found`);
  const workspaceId = String(ws.id);
  const rows: Record<string, unknown[]> = { workspace: await rowsOf("workspace", "id", [workspaceId]) };
  for (const table of OWNED_TABLES) rows[table] = await rowsOf(table, "workspace_id", [workspaceId]);
  for (const { table, column, parent } of CHILD_TABLES) {
    const parentIds = (rows[parent] ?? []).map((r) => String((r as { id: string }).id));
    rows[table] = await rowsOf(table, column, parentIds);
  }
  const corpus: CorpusKeys = {
    sources: (await sqlClient`select id, accession, sha256 from source_document`) as unknown as CorpusKeys["sources"],
    locators: (await sqlClient`select id, source_id, kind, excerpt_hash from source_locator`) as unknown as CorpusKeys["locators"],
    facts: (await sqlClient`select id, locator_id, source_column, concept_id from financial_fact`) as unknown as CorpusKeys["facts"],
  };
  const payload: WorkspaceExport = { format: "errata-workspace/1", exportedAt: new Date().toISOString(), slug, rows, corpus };
  await writeFile(file, JSON.stringify(payload));
  return { tables: Object.keys(rows).length, rows: Object.values(rows).reduce((n, list) => n + list.length, 0) };
}

async function corpusIdMap(exported: CorpusKeys): Promise<Map<string, string>> {
  const local = {
    sources: (await sqlClient`select id, accession, sha256 from source_document`) as unknown as CorpusKeys["sources"],
    locators: (await sqlClient`select id, source_id, kind, excerpt_hash from source_locator`) as unknown as CorpusKeys["locators"],
    facts: (await sqlClient`select id, locator_id, source_column, concept_id from financial_fact`) as unknown as CorpusKeys["facts"],
  };
  const map = new Map<string, string>();
  const sourceByKey = new Map(local.sources.map((s) => [`${s.accession}|${s.sha256}`, String(s.id)]));
  for (const s of exported.sources) {
    const target = sourceByKey.get(`${s.accession}|${s.sha256}`);
    if (target) map.set(String(s.id), target);
  }
  const locatorByKey = new Map(local.locators.map((l) => [`${l.source_id}|${l.kind}|${l.excerpt_hash}`, String(l.id)]));
  for (const l of exported.locators) {
    const target = locatorByKey.get(`${map.get(String(l.source_id)) ?? ""}|${l.kind}|${l.excerpt_hash}`);
    if (target) map.set(String(l.id), target);
  }
  const factByKey = new Map(local.facts.map((f) => [`${f.locator_id}|${f.source_column}|${f.concept_id}`, String(f.id)]));
  for (const f of exported.facts) {
    const target = factByKey.get(`${map.get(String(f.locator_id)) ?? ""}|${f.source_column}|${f.concept_id}`);
    if (target) map.set(String(f.id), target);
  }
  return map;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Every corpus id the workspace's rows mention, so an import can refuse when the target database lacks one. */
function referencedCorpusIds(text: string, exported: CorpusKeys): string[] {
  const corpusIds = new Set([...exported.sources, ...exported.locators, ...exported.facts].map((r) => String(r.id)));
  return [...new Set(text.match(UUID) ?? [])].filter((id) => corpusIds.has(id));
}

export async function importWorkspace(file: string, options: { reference: boolean; name?: string }): Promise<{ slug: string; rows: number }> {
  const exported = JSON.parse(await readFile(file, "utf8")) as WorkspaceExport;
  if (exported.format !== "errata-workspace/1") throw new Error("not an Errata workspace export");
  const [existing] = await sqlClient`select id from workspace where slug = ${exported.slug}`;
  if (existing) throw new Error(`workspace ${exported.slug} already exists here`);

  const ids = await corpusIdMap(exported.corpus);
  const text = JSON.stringify(exported.rows);
  const unmatched = referencedCorpusIds(text, exported.corpus).filter((id) => !ids.has(id));
  if (unmatched.length) throw new Error(`${unmatched.length} filing, locator or fact ids have no match in this database; ingest the same snapshots first (for example ${unmatched.slice(0, 3).join(", ")})`);
  const rows = JSON.parse(text.replace(UUID, (id) => ids.get(id) ?? id)) as Record<string, Record<string, unknown>[]>;

  const workspaceRow = rows.workspace?.[0];
  if (!workspaceRow) throw new Error("the export has no workspace row");
  if (options.reference) {
    Object.assign(workspaceRow, { is_reference: true, expires_at: null });
    for (const session of rows.runtime_session ?? []) if (session.status === "ACTIVE") Object.assign(session, { status: "ENDED", ended_at: session.heartbeat_at });
  }
  if (options.name) workspaceRow.name = options.name;

  let inserted = 0;
  await sqlClient.begin(async (tx) => {
    // Rows arrive in no particular foreign-key order; replica mode skips FK triggers for this transaction only.
    await tx.unsafe("set local session_replication_role = replica");
    for (const [table, list] of Object.entries(rows)) {
      if (!list.length) continue;
      await tx.unsafe(`insert into ${table} select * from json_populate_recordset(null::${table}, $1::json)`, [JSON.stringify(list)]);
      inserted += list.length;
    }
  });
  return { slug: exported.slug, rows: inserted };
}
