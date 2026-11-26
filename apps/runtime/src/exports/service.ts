import { and, eq, isNull } from "drizzle-orm";
import JSZip from "jszip";
import { db } from "../db/client.js";
import { artifactExport, claim, claimBinding, correctionNotice, financialFact, reportWarning, researchReport, researchRevision, sourceDocument } from "../db/schema.js";
import { contentHash } from "../domain/document.js";
import { DomainError, assert } from "../domain/errors.js";
import type { NoticeChange } from "../domain/publication.js";
import { getBlob, putBlob, sha256 } from "../sources/blob-store.js";
import { renderDocx, renderMarkdown, renderPdf, type ExportDocument } from "./render.js";

export type ExportFormat = "markdown" | "pdf" | "docx";

const MIME: Record<ExportFormat, string> = { markdown: "text/markdown; charset=utf-8", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const EXT: Record<ExportFormat, string> = { markdown: "md", pdf: "pdf", docx: "docx" };
const DISCLAIMER = "Not financial advice. Errata is an editorial correction tool using public SEC filings and synthetic research examples.";

function safe(value: string): string {
  return value.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "document";
}

async function revisionDocument(revisionId: string): Promise<{ doc: ExportDocument; overlay: string; filename: string; workspaceId: string; checkValues: string[] }> {
  const revision = await db.query.researchRevision.findFirst({ where: eq(researchRevision.id, revisionId) });
  assert(revision && revision.version !== null, "NOT_FOUND", "only published versions can be exported");
  const report = (await db.query.researchReport.findFirst({ where: eq(researchReport.id, revision.reportId) }))!;
  const warnings = await db.select().from(reportWarning).where(and(eq(reportWarning.revisionId, revision.id), eq(reportWarning.state, "ACTIVE")));
  const claims = await db.select().from(claim).where(eq(claim.revisionId, revision.id));
  const cited = claims.length
    ? await db
        .select({ claimId: claimBinding.claimId, accession: sourceDocument.accession, form: sourceDocument.form, url: sourceDocument.url, filedDate: sourceDocument.filedDate, label: financialFact.label, periodEnd: financialFact.periodEnd, column: financialFact.sourceColumn })
        .from(claimBinding)
        .innerJoin(financialFact, eq(financialFact.id, claimBinding.factId))
        .innerJoin(sourceDocument, eq(sourceDocument.id, financialFact.sourceId))
        .where(eq(claimBinding.kind, "fact"))
    : [];
  const ownCitations = cited.filter((c) => claims.some((cl) => cl.id === c.claimId));
  const citationKeys = [...new Set(ownCitations.map((c) => `${c.accession}|${c.label}|${c.periodEnd}|${c.column}`))];
  const citations = citationKeys.map((key, i) => {
    const c = ownCitations.find((x) => `${x.accession}|${x.label}|${x.periodEnd}|${x.column}` === key)!;
    return { n: i + 1, text: `${c.label}, ${c.periodEnd}, ${c.column.replace(/_/g, " ")} column. Form ${c.form}, accession ${c.accession}, filed ${c.filedDate}.`, url: c.url };
  });
  const markerFor = (claimId: string) => {
    const c = ownCitations.find((x) => x.claimId === claimId);
    return c ? citationKeys.indexOf(`${c.accession}|${c.label}|${c.periodEnd}|${c.column}`) + 1 : null;
  };
  const successor = await db.query.researchRevision.findFirst({ where: and(eq(researchRevision.reportId, report.id), eq(researchRevision.baseRevisionId, revision.id), eq(researchRevision.documentState, "PUBLISHED")) });
  const banners: ExportDocument["banners"] = warnings.map((w) => ({ tone: w.type === "NON_RELIANCE" ? "danger" : "warning", title: w.headline, body: w.detail }));
  if (successor) banners.unshift({ tone: "info", title: `Superseded by version ${successor.version}`, body: `A corrected version of this note was published on ${successor.publishedAt?.toISOString().slice(0, 10)}. This copy is kept unchanged for the record.` });
  if (report.documentState === "WITHDRAWN") banners.unshift({ tone: "danger", title: "Withdrawn", body: "This note has been withdrawn and should not be relied upon." });
  const overlay = contentHash({ banners });
  const blocks = revision.blocks.map((block) => ({
    ...block,
    markers: claims
      .filter((c) => c.blockId === block.id && c.material)
      .map((c) => ({ offset: c.endOffset, n: markerFor(c.id) }))
      .filter((m): m is { offset: number; n: number } => m.n !== null),
  }));
  const doc: ExportDocument = {
    title: report.title,
    meta: [
      `${report.publisherName} (synthetic publisher). Version ${revision.version}. ${revision.publicationLabel ?? "Published"} ${revision.publishedAt?.toISOString().slice(0, 10) ?? ""}.`,
      `Research as of ${revision.asOf.toISOString().slice(0, 10)}. Revision ${revision.id}. Content hash ${revision.contentHash.slice(0, 16)}.`,
      `Overlay generated ${new Date().toISOString()}.`,
    ],
    banners,
    blocks,
    sections: [],
    citations,
    footer: [DISCLAIMER, `Errata export of ${report.publicId} v${revision.version}`],
  };
  const checkValues = claims.filter((c) => c.material && /\d/.test(c.text)).map((c) => c.text);
  return { doc, overlay, filename: `errata-${safe(report.publicId)}-v${revision.version}-research`, workspaceId: revision.workspaceId, checkValues };
}

async function noticeDocument(noticeId: string): Promise<{ doc: ExportDocument; overlay: string; filename: string; workspaceId: string; checkValues: string[] }> {
  const notice = await db.query.correctionNotice.findFirst({ where: eq(correctionNotice.id, noticeId) });
  assert(notice, "NOT_FOUND", "notice not found");
  const report = (await db.query.researchReport.findFirst({ where: eq(researchReport.id, notice.reportId) }))!;
  const body = notice.body as { reportTitle: string; previousVersion: number | null; replacementVersion: number | null; whatChanged: string; why: string; conclusions: string; changes: NoticeChange[]; approvedBy: string; approvedAt: string; disclaimer: string; cases: { title?: string; periods?: { label: string }[] }[] };
  const sources = [...new Map(body.changes.flatMap((c) => c.sources).map((s) => [s.accession, s])).values()];
  const doc: ExportDocument = {
    title: `${notice.type === "WITHDRAWAL" ? "Withdrawal" : "Correction"} notice: ${body.reportTitle}`,
    meta: [
      `${report.publisherName} (synthetic publisher). Notice ${notice.id}.`,
      `Issued ${notice.publishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC in an Errata demo workspace. Approved by ${body.approvedBy}.`,
      body.replacementVersion ? `Replaces version ${body.previousVersion} with version ${body.replacementVersion}.` : "No replacement version.",
    ],
    banners: [],
    blocks: [],
    sections: [
      { heading: "What changed", paragraphs: [body.whatChanged] },
      { heading: "Why", paragraphs: [body.why, ...body.cases.flatMap((c) => (c.periods?.length ? [`Periods named in the disclosure: ${c.periods.map((p) => p.label).join("; ")}.`] : []))] },
      { heading: "Conclusions", paragraphs: [body.conclusions] },
      ...(body.changes.length
        ? [{ heading: "Figures", paragraphs: ["Differences are new minus previous, computed in code from the cited filings."], table: { header: ["Figure", "Previously", "Corrected", "Difference"], rows: body.changes.map((c) => [c.label, c.previous, c.replacement, c.delta]) } }]
        : []),
    ],
    citations: sources.map((s, i) => ({ n: i + 1, text: `Form ${s.form}, accession ${s.accession}, ${s.column.replace(/_/g, " ")} column.`, url: s.url })),
    footer: [body.disclaimer || DISCLAIMER, `Notice hash ${notice.contentHash.slice(0, 16)}`],
  };
  return { doc, overlay: notice.contentHash, filename: `errata-${safe(report.publicId)}-notice-${notice.id.slice(0, 8)}`, workspaceId: notice.workspaceId, checkValues: body.changes.flatMap((c) => [c.previous, c.replacement]) };
}

function pdfHex(text: string): string {
  return Buffer.from(text, "latin1").toString("hex");
}

/** Reopens a generated artifact and confirms the key figures are present. A download button alone is not proof. */
async function verifyArtifact(format: ExportFormat, bytes: Buffer, values: string[]): Promise<string[]> {
  let haystack = "";
  if (format === "markdown") haystack = bytes.toString("utf8");
  if (format === "docx") haystack = (await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string")) ?? "";
  if (format === "pdf") {
    const raw = bytes.toString("latin1").replace(/>\s*-?\d+(\.\d+)?\s*</g, "").toLowerCase();
    return values.filter((v) => !raw.includes(pdfHex(v).toLowerCase()) && !raw.includes(v.toLowerCase()));
  }
  return values.filter((v) => !haystack.includes(v.replace(/&/g, "&amp;")));
}

export async function generateExport(target: { revisionId?: string; noticeId?: string }, format: ExportFormat) {
  const built = target.revisionId ? await revisionDocument(target.revisionId) : target.noticeId ? await noticeDocument(target.noticeId) : null;
  if (!built) throw new DomainError("INVALID_INPUT", "choose a revision or a notice");
  const existing = await db.query.artifactExport.findFirst({
    where: and(
      eq(artifactExport.workspaceId, built.workspaceId),
      target.revisionId ? eq(artifactExport.revisionId, target.revisionId) : isNull(artifactExport.revisionId),
      target.noticeId ? eq(artifactExport.noticeId, target.noticeId) : isNull(artifactExport.noticeId),
      eq(artifactExport.format, format),
      eq(artifactExport.overlayVersion, built.overlay),
    ),
  });
  if (existing?.status === "READY") return existing;
  const bytes = format === "markdown" ? Buffer.from(renderMarkdown(built.doc), "utf8") : format === "pdf" ? await renderPdf(built.doc) : await renderDocx(built.doc);
  const missing = await verifyArtifact(format, bytes, built.checkValues);
  const { storageRef } = await putBlob(bytes);
  const values = {
    workspaceId: built.workspaceId,
    revisionId: target.revisionId ?? null,
    noticeId: target.noticeId ?? null,
    overlayVersion: built.overlay,
    format,
    filename: `${built.filename}.${EXT[format]}`,
    storageRef,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    status: missing.length ? "FAILED" : "READY",
    error: missing.length ? `figures missing from the generated file: ${missing.join(", ")}` : null,
  };
  const [row] = existing
    ? await db.update(artifactExport).set(values).where(eq(artifactExport.id, existing.id)).returning()
    : await db.insert(artifactExport).values(values).onConflictDoUpdate({ target: [artifactExport.workspaceId, artifactExport.revisionId, artifactExport.noticeId, artifactExport.format, artifactExport.overlayVersion], set: values }).returning();
  if (missing.length) throw new DomainError("BLOCKED", `export failed its content check: ${missing.join(", ")}`, { exportId: row!.id });
  return row!;
}

export async function exportBytes(exportId: string): Promise<{ bytes: Buffer; filename: string; mime: string; workspaceId: string }> {
  const row = await db.query.artifactExport.findFirst({ where: eq(artifactExport.id, exportId) });
  assert(row?.status === "READY" && row.storageRef, "NOT_FOUND", "export not ready");
  return { bytes: await getBlob(row.storageRef), filename: row.filename, mime: MIME[row.format as ExportFormat], workspaceId: row.workspaceId };
}

export { MIME as EXPORT_MIME };
