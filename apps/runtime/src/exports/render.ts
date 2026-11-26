import { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import PDFDocument from "pdfkit";
import type { Block } from "../db/schema.js";

export interface ExportCitation {
  n: number;
  text: string;
  url: string;
}

export interface ExportBanner {
  tone: "danger" | "warning" | "info";
  title: string;
  body: string;
}

export interface ExportDocument {
  title: string;
  meta: string[];
  banners: ExportBanner[];
  blocks: (Block & { markers?: { offset: number; n: number }[] })[];
  sections: { heading: string; paragraphs: string[]; table?: { header: string[]; rows: string[][] } }[];
  citations: ExportCitation[];
  footer: string[];
}

function withMarkers(block: ExportDocument["blocks"][number]): string {
  if (!block.markers?.length) return block.text;
  let text = block.text;
  for (const marker of [...block.markers].sort((a, b) => b.offset - a.offset)) text = `${text.slice(0, marker.offset)} [${marker.n}]${text.slice(marker.offset)}`;
  return text;
}

function tableRows(block: Block): string[][] {
  return block.rows ?? block.text.split("\n").map((r) => r.split(" | "));
}

export function renderMarkdown(doc: ExportDocument): string {
  const out: string[] = [`# ${doc.title}`, "", ...doc.meta.map((m) => `_${m}_  `), ""];
  for (const banner of doc.banners) out.push(`> **${banner.title}**`, `> ${banner.body}`, "");
  for (const block of doc.blocks) {
    if (block.kind === "heading") {
      if (block.text === doc.title) continue;
      out.push(`${"#".repeat(Math.min(4, (block.level ?? 2) + 1))} ${block.text}`, "");
    } else if (block.kind === "table") {
      const rows = withMarkers(block).split("\n").map((r) => r.split(" | "));
      const [header, ...body] = rows;
      out.push(`| ${header!.join(" | ")} |`, `| ${header!.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`), "");
    } else if (block.kind === "list") {
      out.push(...block.text.split("\n").map((i) => `- ${i}`), "");
    } else out.push(withMarkers(block), "");
  }
  for (const section of doc.sections) {
    out.push(`## ${section.heading}`, "", ...section.paragraphs.flatMap((p) => [p, ""]));
    if (section.table) out.push(`| ${section.table.header.join(" | ")} |`, `| ${section.table.header.map(() => "---").join(" | ")} |`, ...section.table.rows.map((r) => `| ${r.join(" | ")} |`), "");
  }
  if (doc.citations.length) out.push("## Sources", "", ...doc.citations.map((c) => `${c.n}. ${c.text} ${c.url}`), "");
  out.push("---", "", ...doc.footer.map((f) => `_${f}_  `));
  return `${out.join("\n").trim()}\n`;
}

const PDF_COLORS = { text: "#17231F", muted: "#59665F", line: "#DCE3DD", danger: "#A12831", warning: "#8B550E", info: "#176B55" };

export async function renderPdf(doc: ExportDocument): Promise<Buffer> {
  const pdf = new PDFDocument({ compress: false, size: "A4", margins: { top: 56, bottom: 64, left: 56, right: 56 }, info: { Title: doc.title, Producer: "Errata", Creator: "Errata" }, bufferPages: true });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;

  pdf.font("Times-Bold").fontSize(20).fillColor(PDF_COLORS.text).text(doc.title, { width });
  pdf.moveDown(0.4);
  pdf.font("Helvetica").fontSize(8.5).fillColor(PDF_COLORS.muted);
  for (const line of doc.meta) pdf.text(line, { width });
  pdf.moveDown(0.8);

  for (const banner of doc.banners) {
    const color = PDF_COLORS[banner.tone];
    const top = pdf.y;
    pdf.font("Helvetica-Bold").fontSize(10).fillColor(color).text(banner.title, pdf.page.margins.left + 10, top + 8, { width: width - 20 });
    pdf.font("Helvetica").fontSize(9).fillColor(PDF_COLORS.text).text(banner.body, { width: width - 20 });
    const bottom = pdf.y + 8;
    pdf.save().lineWidth(2).strokeColor(color).moveTo(pdf.page.margins.left, top).lineTo(pdf.page.margins.left, bottom).stroke().restore();
    pdf.y = bottom + 8;
    pdf.x = pdf.page.margins.left;
  }

  const drawTable = (header: string[], rows: string[][]) => {
    const cols = header.length;
    const colWidth = width / cols;
    const drawRow = (cells: string[], bold: boolean) => {
      const heights = cells.map((cell) => pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).heightOfString(cell, { width: colWidth - 10 }));
      const rowHeight = Math.max(...heights) + 10;
      if (pdf.y + rowHeight > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
      const y = pdf.y;
      cells.forEach((cell, i) => {
        pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(PDF_COLORS.text).text(cell, pdf.page.margins.left + i * colWidth + 5, y + 5, { width: colWidth - 10, align: i === 0 ? "left" : "right" });
      });
      pdf.save().lineWidth(0.5).strokeColor(PDF_COLORS.line).moveTo(pdf.page.margins.left, y + rowHeight).lineTo(pdf.page.margins.left + width, y + rowHeight).stroke().restore();
      pdf.y = y + rowHeight;
    };
    drawRow(header, true);
    for (const row of rows) drawRow(header.map((_, i) => row[i] ?? ""), false);
    pdf.x = pdf.page.margins.left;
    pdf.moveDown(0.8);
  };

  for (const block of doc.blocks) {
    if (block.kind === "heading") {
      if (block.text === doc.title) continue;
      pdf.moveDown(0.4).font("Times-Bold").fontSize(13).fillColor(PDF_COLORS.text).text(block.text, { width });
      pdf.moveDown(0.3);
    } else if (block.kind === "table") {
      const [header, ...rows] = withMarkers(block).split("\n").map((r) => r.split(" | "));
      drawTable(header!, rows);
    } else if (block.kind === "list") {
      pdf.font("Times-Roman").fontSize(11).fillColor(PDF_COLORS.text).list(block.text.split("\n"), { width });
      pdf.moveDown(0.6);
    } else {
      pdf.font("Times-Roman").fontSize(11).fillColor(PDF_COLORS.text).text(withMarkers(block), { width, lineGap: 2 });
      pdf.moveDown(0.6);
    }
  }
  for (const section of doc.sections) {
    pdf.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor(PDF_COLORS.text).text(section.heading, { width });
    pdf.moveDown(0.3);
    for (const p of section.paragraphs) {
      pdf.font("Helvetica").fontSize(9.5).fillColor(PDF_COLORS.text).text(p, { width, lineGap: 1.5 });
      pdf.moveDown(0.4);
    }
    if (section.table) drawTable(section.table.header, section.table.rows);
  }
  if (doc.citations.length) {
    pdf.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor(PDF_COLORS.text).text("Sources", { width });
    pdf.moveDown(0.3);
    for (const c of doc.citations) {
      pdf.font("Helvetica").fontSize(8.5).fillColor(PDF_COLORS.text).text(`${c.n}. ${c.text}`, { width, continued: false });
      pdf.font("Helvetica").fontSize(8).fillColor(PDF_COLORS.info).text(c.url, { width, link: c.url, underline: true });
      pdf.moveDown(0.2);
    }
  }
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    const bottom = pdf.page.height - pdf.page.margins.bottom + 16;
    pdf.font("Helvetica").fontSize(7).fillColor(PDF_COLORS.muted).text(`${doc.footer.join("  ·  ")}  ·  Page ${i + 1} of ${range.count}`, pdf.page.margins.left, bottom, { width, align: "center", lineBreak: true, height: 30 });
  }
  pdf.end();
  return done;
}

export async function renderDocx(doc: ExportDocument): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title })] }));
  for (const line of doc.meta) children.push(new Paragraph({ children: [new TextRun({ text: line, italics: true, size: 18, color: "59665F" })] }));
  for (const banner of doc.banners) {
    const color = banner.tone === "danger" ? "A12831" : banner.tone === "warning" ? "8B550E" : "176B55";
    children.push(
      new Paragraph({
        border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 8 } },
        shading: { type: ShadingType.CLEAR, color: "auto", fill: "F6F7F5" },
        spacing: { before: 160, after: 40 },
        children: [new TextRun({ text: banner.title, bold: true, color })],
      }),
      new Paragraph({ border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 8 } }, spacing: { after: 160 }, children: [new TextRun({ text: banner.body })] }),
    );
  }
  const table = (header: string[], rows: string[][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [header, ...rows].map(
        (cells, rowIndex) =>
          new TableRow({
            tableHeader: rowIndex === 0,
            children: header.map((_, i) => new TableCell({ children: [new Paragraph({ alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT, children: [new TextRun({ text: cells[i] ?? "", bold: rowIndex === 0 })] })] })),
          }),
      ),
    });
  for (const block of doc.blocks) {
    if (block.kind === "heading") {
      if (block.text === doc.title) continue;
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: block.text })] }));
    } else if (block.kind === "table") {
      const [header, ...rows] = withMarkers(block).split("\n").map((r) => r.split(" | "));
      children.push(table(header!, rows), new Paragraph({ children: [] }));
    } else if (block.kind === "list") {
      for (const item of block.text.split("\n")) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item })] }));
    } else children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: withMarkers(block) })] }));
  }
  for (const section of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: section.heading })] }));
    for (const p of section.paragraphs) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: p })] }));
    if (section.table) children.push(table(section.table.header, section.table.rows), new Paragraph({ children: [] }));
  }
  if (doc.citations.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Sources" })] }));
    for (const c of doc.citations) children.push(new Paragraph({ children: [new TextRun({ text: `${c.n}. ${c.text} ` }), new ExternalHyperlink({ link: c.url, children: [new TextRun({ text: c.url, style: "Hyperlink" })] })] }));
  }
  for (const f of doc.footer) children.push(new Paragraph({ children: [new TextRun({ text: f, italics: true, size: 16, color: "59665F" })] }));
  const document = new Document({ creator: "Errata", title: doc.title, description: doc.footer.join(" "), sections: [{ children }] });
  return Packer.toBuffer(document);
}

export function getRenderedBlockText(block: Block): string {
  return block.kind === "table" ? tableRows(block).map((r) => r.join(" | ")).join("\n") : block.text;
}
