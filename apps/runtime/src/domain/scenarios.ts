import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { FORMULA_SCHEMA } from "../formula/engine.js";
import { datasetsDir } from "../sources/provenance.js";

const FAULT = z.object({
  type: z.enum(["hold_stale_commit", "inject_wrong_period_proposal", "verifier_timeout_once"]),
  role: z.string(),
  epoch: z.number().int().optional(),
  label: z.string(),
});

const SCENARIO = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  mode: z.literal("replay"),
  initialAsOf: z.string().datetime(),
  preloadedSources: z.array(z.string()),
  events: z.array(z.object({ id: z.string(), sourceRef: z.string(), label: z.string() })),
  reports: z.array(z.string()),
  watchlist: z.array(z.string()),
  faults: z.array(FAULT),
  /** Scenarios that replay the same notes and filings share one ground truth file in datasets/evaluation. */
  groundTruth: z.string().optional(),
});

const BINDING = z.object({ sourceRef: z.string(), concept: z.string(), periodEnd: z.string() });

const FIXTURE_CLAIM = z.object({
  key: z.string(),
  match: z.string().min(1),
  occurrence: z.number().int().min(0),
  category: z.enum(["DIRECT", "DERIVED", "QUALITATIVE", "OTHER"]),
  label: z.string(),
  material: z.boolean().optional(),
  reason: z.string().optional(),
  binding: BINDING.optional(),
  formula: FORMULA_SCHEMA.optional(),
  displayPrecision: z.number().int().min(0).max(6).optional(),
  displayUnit: z.string().optional(),
  displayScale: z.number().int().min(0).max(9).optional(),
  dependsOn: z.array(z.string()).optional(),
});

const FIXTURE_REPORT = z.object({
  key: z.string(),
  file: z.string(),
  issuerCiks: z.array(z.string()),
  asOf: z.string().datetime(),
  sourceRefs: z.array(z.string()),
  recipients: z.array(z.string()),
  claims: z.array(FIXTURE_CLAIM),
});

const FIXTURES = z.object({
  schemaVersion: z.literal(1),
  notice: z.string(),
  publisher: z.object({ name: z.string(), label: z.string() }),
  recipients: z.array(z.object({ displayName: z.string(), organisation: z.string(), address: z.string().endsWith(".invalid") })),
  reports: z.array(FIXTURE_REPORT),
});

export type Scenario = z.infer<typeof SCENARIO>;
export type ScenarioFault = z.infer<typeof FAULT>;
export type Fixtures = z.infer<typeof FIXTURES>;
export type FixtureReport = z.infer<typeof FIXTURE_REPORT>;
export type FixtureClaim = z.infer<typeof FIXTURE_CLAIM>;

export async function loadScenarios(): Promise<Scenario[]> {
  const raw = JSON.parse(await readFile(resolve(datasetsDir(), "scenarios/scenarios.json"), "utf8")) as { scenarios: unknown[] };
  return z.array(SCENARIO).parse(raw.scenarios);
}

export async function loadScenario(id: string): Promise<Scenario> {
  const scenario = (await loadScenarios()).find((s) => s.id === id);
  if (!scenario) throw new Error(`unknown scenario ${id}`);
  return scenario;
}

export async function loadFixtures(): Promise<Fixtures> {
  return FIXTURES.parse(JSON.parse(await readFile(resolve(datasetsDir(), "synthetic-research/fixtures.json"), "utf8")));
}

export async function loadFixtureMarkdown(report: FixtureReport): Promise<string> {
  return readFile(resolve(datasetsDir(), "synthetic-research", report.file), "utf8");
}
