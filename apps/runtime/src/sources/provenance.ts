import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ENV } from "../config/env.js";

const SOURCE_ENTRY = z.object({
  ref: z.string(),
  cik: z.string().regex(/^\d{10}$/),
  accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  form: z.string(),
  reportDate: z.string().nullable(),
  filedDate: z.string(),
  acceptedAt: z.string().nullable(),
  availabilityPrecision: z.enum(["second", "date"]),
  url: z.string().url(),
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});

const MANIFEST = z.object({
  schemaVersion: z.literal(1),
  issuers: z.array(z.object({ cik: z.string(), name: z.string(), ticker: z.string() })),
  sources: z.array(SOURCE_ENTRY),
});

export type ProvenanceSource = z.infer<typeof SOURCE_ENTRY>;
export type ProvenanceManifest = z.infer<typeof MANIFEST>;

export function datasetsDir(): string {
  return resolve(process.cwd(), ENV.DATASETS_DIR);
}

export async function loadProvenance(): Promise<ProvenanceManifest> {
  const raw = await readFile(resolve(datasetsDir(), "provenance.json"), "utf8");
  return MANIFEST.parse(JSON.parse(raw));
}

export function sourceAvailableAt(source: ProvenanceSource): Date {
  if (source.acceptedAt) return new Date(source.acceptedAt);
  return new Date(`${source.filedDate}T23:59:59Z`);
}
