import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { runtimeFor, SDK_VERSION } from "../agents/host.js";
import { runtimeView } from "../api/views.js";
import { ENV } from "../config/env.js";
import { db, sqlClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { agentRun, claim, claimImpact, correctionCase, domainEvent, replacementProposal, researchReport, researchRevision, workspace } from "../db/schema.js";
import { advanceReplay } from "../domain/cases.js";
import { scanNumericTokens } from "../domain/document.js";
import { sameDecimal } from "../domain/locator.js";
import { requestRecheck } from "../domain/claims-work.js";
import { reissue, reviewCandidate } from "../domain/publication.js";
import { loadScenario, loadScenarios } from "../domain/scenarios.js";
import { createScenarioWorkspace } from "../domain/workspace.js";
import { loadSourceBytes } from "../sources/ingest.js";
import { datasetsDir, loadProvenance } from "../sources/provenance.js";

const USAGE = `Usage: pnpm errata <command> [options]

Commands:
  verify-sources [--live]                 Re-hash every snapshot in datasets/provenance.json; with --live, re-fetch each from sec.gov and compare.
  scenarios                               List replay scenarios.
  resume --workspace <slug> [--approve]   Recreate a workspace's runtime from stored state and let pending work finish.
         [--recheck]                      --recheck asks for another check of proposals whose automatic checks ended without a verdict.
  replay --scenario <id> [--approve]      Run a scenario end to end with live agents. --approve acts as a synthetic CLI editor
         [--timeout <seconds>]            to approve and reissue a ready draft. Prints the workspace slug for the web UI.
  evaluate --scenario <id> [--runs <n>]   Run the scenario n times with --approve, then score each run against
                                          datasets/evaluation/<id>.expected.json and write evaluation/results.
  score --workspace <slug>                Score a finished scenario workspace against its ground truth and save the result.
  inspect-run --workspace <slug>          Print the agent runs, challenges and outcome for a workspace.
`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The commit a result was produced from. Outside a container BUILD_COMMIT is unset, so read it from git and say when the tree had changes. */
function buildCommit(): string {
  if (ENV.BUILD_COMMIT !== "local") return ENV.BUILD_COMMIT;
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "local";
  }
}

async function waitQuiet(workspaceId: string, deadline: number): Promise<void> {
  let quietChecks = 0;
  await sleep(3000);
  while (Date.now() < deadline) {
    const running = await db.$count(agentRun, and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.status, "STARTED")));
    const holding = await db.$count(domainEvent, and(eq(domainEvent.workspaceId, workspaceId), eq(domainEvent.type, "fault.holding")));
    const released = await db.$count(domainEvent, and(eq(domainEvent.workspaceId, workspaceId), eq(domainEvent.type, "fault.released")));
    if (holding > released) return;
    quietChecks = running ? 0 : quietChecks + 1;
    if (quietChecks >= 5) return;
    await sleep(2500);
  }
  throw new Error("timed out waiting for agents to finish");
}

/** Acts as a clearly labelled synthetic editor: approves and reissues drafts that are ready, until agents go quiet. */
async function approveReady(workspaceId: string, deadline: number, say: (line: string) => void): Promise<number> {
  const cliEditor = { workspaceId, actor: { kind: "human" as const, id: "editor:cli" }, actorName: "CLI editor (synthetic)", principalId: crypto.randomUUID() };
  let reissued = 0;
  let idleChecks = 0;
  while (Date.now() < deadline) {
    const ready = await db.select().from(researchRevision).where(and(eq(researchRevision.workspaceId, workspaceId), eq(researchRevision.kind, "candidate"), eq(researchRevision.candidateState, "READY")));
    if (!ready.length) {
      const running = await db.$count(agentRun, and(eq(agentRun.workspaceId, workspaceId), eq(agentRun.status, "STARTED")));
      idleChecks = running ? 0 : idleChecks + 1;
      if (idleChecks >= 8) break;
      await sleep(5000);
      continue;
    }
    idleChecks = 0;
    for (const candidate of ready) {
      const review = await reviewCandidate(cliEditor, { candidateId: candidate.id, decision: "approve", contentHash: candidate.contentHash, epochVector: candidate.epochVector });
      const result = await reissue(cliEditor, { candidateId: candidate.id, approvalId: review.result.reviewId, candidateHash: candidate.contentHash, expectedBaseRevisionId: candidate.baseRevisionId!, evidenceEpochs: candidate.epochVector });
      reissued += 1;
      say(`approved and reissued ${result.result.publicId} as version ${result.result.version}`);
    }
  }
  return reissued;
}

interface ReplayOutcome {
  workspaceId: string;
  slug: string;
  startedAt: Date;
  endedAt: Date;
  reissued: number;
  caseStatuses: string[];
}

async function replay(scenarioId: string, options: { approve: boolean; timeoutSeconds: number; log: boolean }): Promise<ReplayOutcome> {
  const scenario = await loadScenario(scenarioId);
  const startedAt = new Date();
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const created = await createScenarioWorkspace(scenarioId);
  const say = (line: string) => options.log && console.log(line);
  say(`workspace ${created.slug} (${created.workspaceId}), model ${ENV.MODEL_PROVIDER}/${ENV.MODEL_ID}, ${SDK_VERSION}`);
  await runtimeFor(created.workspaceId);
  for (let position = 0; position < scenario.events.length; position += 1) {
    const step = await advanceReplay(created.workspaceId, position, { kind: "human", id: "operator:cli" });
    say(`released ${step.position}/${step.of}: ${scenario.events[position]!.label}`);
    await waitQuiet(created.workspaceId, deadline);
  }
  const reissued = options.approve ? await approveReady(created.workspaceId, deadline, say) : 0;
  await sleep(2500);
  const cases = await db.select().from(correctionCase).where(eq(correctionCase.workspaceId, created.workspaceId));
  return { workspaceId: created.workspaceId, slug: created.slug, startedAt, endedAt: new Date(), reissued, caseStatuses: cases.map((c) => c.status) };
}

interface Expected {
  scenarioId: string;
  affectedClaims: { report: string; label: string; kind: string; expected: string | null }[];
  candidateClaims: { report: string; label: string; expectedState: string }[];
  unaffectedReports: string[];
  expectedScopePeriodEnds: string[];
}

async function score(workspaceId: string, expected: Expected) {
  const impacts = await db
    .select({ impact: claimImpact, claim, title: researchReport.title })
    .from(claimImpact)
    .innerJoin(claim, eq(claim.id, claimImpact.claimId))
    .innerJoin(researchReport, eq(researchReport.id, claimImpact.reportId))
    .where(inArray(claimImpact.caseId, (await db.select({ id: correctionCase.id }).from(correctionCase).where(eq(correctionCase.workspaceId, workspaceId))).map((c) => c.id)));
  const predicted = impacts.filter((i) => i.impact.classification !== "candidate" && i.claim.material);
  const key = (report: string, label: string) => `${report}::${label}`;
  const truth = new Set(expected.affectedClaims.map((c) => key(c.report, c.label)));
  const predictedKeys = new Set(predicted.map((p) => key(expected.affectedClaims.find((c) => p.title.startsWith(c.report))?.report ?? p.title, p.claim.label)));
  const truePositives = [...predictedKeys].filter((k) => truth.has(k)).length;
  const proposals = await db.select().from(replacementProposal).where(eq(replacementProposal.workspaceId, workspaceId));
  const verified = proposals.filter((p) => p.status === "VERIFIED");
  const replacementRows = expected.affectedClaims
    .filter((c) => c.expected !== null)
    .map((c) => {
      const impact = predicted.find((p) => p.title.startsWith(c.report) && p.claim.label === c.label);
      const accepted = impact ? verified.filter((p) => p.claimId === impact.claim.id) : [];
      const latest = accepted.sort((a, b) => b.epoch - a.epoch)[0];
      return { label: c.label, expected: c.expected, accepted: latest?.value ?? null, correct: Boolean(latest && sameDecimal(latest.value, c.expected)) };
    });
  const unsupportedAccepted = verified.filter((p) => {
    const impact = predicted.find((i) => i.claim.id === p.claimId);
    const truthRow = impact ? expected.affectedClaims.find((c) => impact.title.startsWith(c.report) && c.label === impact.claim.label) : null;
    return truthRow?.expected != null && !sameDecimal(p.value, truthRow.expected);
  }).length;
  const candidates = expected.candidateClaims.map((c) => {
    const row = impacts.find((i) => i.title.startsWith(c.report) && i.claim.label === c.label);
    return { label: c.label, expected: c.expectedState, actual: row?.impact.state ?? "missing" };
  });
  const reports = await db.select().from(researchReport).where(eq(researchReport.workspaceId, workspaceId));
  const falseWarnings = reports.filter((r) => expected.unaffectedReports.includes(r.title) && r.reliability !== "CLEAR").map((r) => r.title);
  let coveredTokens = 0;
  let totalTokens = 0;
  for (const report of reports.filter((r) => r.currentRevisionId)) {
    const revision = (await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, report.currentRevisionId!) }))!;
    const claims = await db.select().from(claim).where(eq(claim.revisionId, revision.id));
    for (const token of scanNumericTokens(revision.blocks)) {
      totalTokens += 1;
      if (claims.some((c) => c.blockId === token.blockId && c.startOffset <= token.start && c.endOffset >= token.end && c.bindingState === "BOUND")) coveredTokens += 1;
    }
  }
  const cases = await db.select().from(correctionCase).where(eq(correctionCase.workspaceId, workspaceId));
  const scopeEnds = [...new Set(cases.flatMap((c) => (c.scope?.periods ?? []).map((p) => p.end)))].sort();
  const events = await db.select().from(domainEvent).where(eq(domainEvent.workspaceId, workspaceId)).orderBy(asc(domainEvent.seq));
  const at = (type: string, predicate: (e: (typeof events)[number]) => boolean = () => true) => events.find((e) => e.type === type && predicate(e))?.committedAt ?? null;
  const seconds = (a: Date | null, b: Date | null) => (a && b ? Math.round((b.getTime() - a.getTime()) / 100) / 10 : null);
  const runtime = await runtimeView(workspaceId);
  return {
    impact: { truePositives, falsePositives: predictedKeys.size - truePositives, falseNegatives: truth.size - truePositives, predicted: predictedKeys.size, groundTruth: truth.size },
    replacements: { correct: replacementRows.filter((r) => r.correct).length, expected: replacementRows.length, rows: replacementRows, unsupportedAccepted, accepted: verified.length, rejected: proposals.filter((p) => p.status === "REJECTED").length },
    candidates,
    falseWarnings,
    scope: { matched: JSON.stringify(scopeEnds) === JSON.stringify([...expected.expectedScopePeriodEnds].sort()), found: scopeEnds },
    finalFigureCoverage: { covered: coveredTokens, total: totalTokens },
    concurrency: { runs: runtime.metrics.runs, overlappingRunPairs: runtime.metrics.overlappingRunPairs, overlapSeconds: runtime.metrics.overlapSeconds, challenges: runtime.metrics.challenges, staleRejections: runtime.metrics.staleRejections, failed: runtime.metrics.failed },
    tokens: { input: runtime.metrics.inputTokens, output: runtime.metrics.outputTokens },
    latencySeconds: {
      noticeToWarning: seconds(at("filing.discovered"), at("report.warning_applied", (e) => (e.payload as { warningType?: string }).warningType === "NON_RELIANCE")),
      amendmentToReadyDraft: seconds(at("filing.discovered", (e) => /\/A$/.test(String((e.payload as { form?: string }).form))), at("report.conclusions_reviewed") ?? at("report.revision_prepared")),
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }
  await runMigrations();
  if (command === "scenarios") {
    for (const s of await loadScenarios()) console.log(`${s.id.padEnd(28)} ${s.label}`);
    return;
  }
  if (command === "verify-sources") {
    const live = process.argv.includes("--live");
    let failures = 0;
    for (const entry of (await loadProvenance()).sources) {
      try {
        await loadSourceBytes(entry, live ? "live" : "snapshot");
        console.log(`ok   ${entry.accession} ${entry.form.padEnd(7)} ${live ? "sec.gov bytes" : "snapshot"} match filing hash ${entry.sha256.slice(0, 12)}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${entry.accession} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures) process.exitCode = 1;
    return;
  }
  if (command === "replay") {
    const scenarioId = arg("scenario");
    if (!scenarioId) throw new Error("--scenario is required");
    const outcome = await replay(scenarioId, { approve: process.argv.includes("--approve"), timeoutSeconds: Number(arg("timeout") ?? 900), log: true });
    console.log(JSON.stringify({ ...outcome, webPath: `/w/${outcome.slug}` }, null, 2));
    return;
  }
  if (command === "evaluate") {
    const scenarioId = arg("scenario");
    if (!scenarioId) throw new Error("--scenario is required");
    const runs = Math.max(1, Number(arg("runs") ?? 1));
    const outDir = resolve(process.cwd(), "../../evaluation/results");
    await mkdir(outDir, { recursive: true });
    const results = [];
    for (let i = 0; i < runs; i += 1) {
      console.log(`run ${i + 1} of ${runs}`);
      const outcome = await replay(scenarioId, { approve: true, timeoutSeconds: Number(arg("timeout") ?? 900), log: true });
      const expected = JSON.parse(await readFile(resolve(datasetsDir(), "evaluation", `${scenarioId}.expected.json`), "utf8")) as Expected;
      const scored = await score(outcome.workspaceId, expected);
      const record = { scenarioId, run: i + 1, model: `${ENV.MODEL_PROVIDER}/${ENV.MODEL_ID}`, sdk: SDK_VERSION, buildCommit: buildCommit(), startedAt: outcome.startedAt.toISOString(), endedAt: outcome.endedAt.toISOString(), workspace: outcome.slug, reissued: outcome.reissued, caseStatuses: outcome.caseStatuses, ...scored };
      results.push(record);
      console.log(JSON.stringify(record, null, 2));
    }
    const file = resolve(outDir, `${scenarioId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${file}`);
    return;
  }
  if (command === "resume") {
    const slug = arg("workspace");
    const ws = slug ? await db.query.workspace.findFirst({ where: eq(workspace.slug, slug) }) : null;
    if (!ws) throw new Error("workspace not found");
    console.log(`resuming ${ws.slug}: recreating its Mozaik runtime from stored state`);
    await runtimeFor(ws.id);
    if (process.argv.includes("--recheck")) {
      const pending = await db
        .select({ proposal: replacementProposal })
        .from(replacementProposal)
        .innerJoin(correctionCase, eq(correctionCase.id, replacementProposal.caseId))
        .where(and(eq(replacementProposal.workspaceId, ws.id), eq(replacementProposal.status, "PROPOSED"), eq(replacementProposal.epoch, correctionCase.evidenceEpoch)));
      for (const { proposal } of pending) {
        const checks = await db.$count(agentRun, and(eq(agentRun.workspaceId, ws.id), eq(agentRun.status, "COMPLETED"), sql`${agentRun.taskKey} like ${`verify:${proposal.id}%`}`));
        if (checks < 2) continue;
        await requestRecheck({ workspaceId: ws.id, actor: { kind: "human", id: "editor:cli" }, actorName: "CLI editor (synthetic)" }, { caseId: proposal.caseId, proposalId: proposal.id });
        console.log(`asked for another independent check of proposal ${proposal.id}`);
      }
    }
    const deadline = Date.now() + Number(arg("timeout") ?? 3600) * 1000;
    await waitQuiet(ws.id, deadline);
    const reissued = process.argv.includes("--approve") ? await approveReady(ws.id, deadline, (line) => console.log(line)) : 0;
    const cases = await db.select().from(correctionCase).where(eq(correctionCase.workspaceId, ws.id));
    console.log(JSON.stringify({ workspace: ws.slug, reissued, caseStatuses: cases.map((c) => c.status) }, null, 2));
    return;
  }
  if (command === "score") {
    const slug = arg("workspace");
    const ws = slug ? await db.query.workspace.findFirst({ where: eq(workspace.slug, slug) }) : null;
    if (!ws?.scenarioId) throw new Error("workspace not found or not a scenario workspace");
    const expected = JSON.parse(await readFile(resolve(datasetsDir(), "evaluation", `${ws.scenarioId}.expected.json`), "utf8")) as Expected;
    const scored = await score(ws.id, expected);
    const cases = await db.select().from(correctionCase).where(eq(correctionCase.workspaceId, ws.id));
    const record = { scenarioId: ws.scenarioId, workspace: ws.slug, model: `${ENV.MODEL_PROVIDER}/${ENV.MODEL_ID}`, sdk: SDK_VERSION, buildCommit: buildCommit(), scoredAt: new Date().toISOString(), caseStatuses: cases.map((c) => c.status), ...scored };
    const outDir = resolve(process.cwd(), "../../evaluation/results");
    await mkdir(outDir, { recursive: true });
    const file = resolve(outDir, `${ws.scenarioId}-${ws.slug}.json`);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    console.log(`wrote ${file}`);
    return;
  }
  if (command === "inspect-run") {
    const slug = arg("workspace");
    const ws = slug ? await db.query.workspace.findFirst({ where: eq(workspace.slug, slug) }) : null;
    if (!ws) throw new Error("workspace not found");
    const runtime = await runtimeView(ws.id);
    for (const r of [...runtime.runs].reverse()) console.log(`${r.startedAt}  ${r.role.padEnd(19)} ${String(r.trigger.kind).padEnd(22)} ${r.status.padEnd(10)} e${r.epoch ?? "-"} ${r.summary ?? r.errorMessage ?? ""}`);
    console.log(JSON.stringify(runtime.metrics, null, 2));
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

process.on("unhandledRejection", (reason) => {
  console.error("[cli] agent loop error recorded on its run:", reason instanceof Error ? reason.message.slice(0, 200) : reason);
});

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sqlClient.end({ timeout: 5 });
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
