import { createHash } from "node:crypto";
import type { Block } from "../db/schema.js";

export const MAX_DOCUMENT_BYTES = 256 * 1024;

function blockId(index: number, kind: Block["kind"], text: string): string {
  return `b${index}-${kind}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Parses the supported Markdown subset (headings, paragraphs, lists, pipe tables). Raw HTML is kept as literal text and never rendered. */
export function parseMarkdown(markdown: string): Block[] {
  if (Buffer.byteLength(markdown, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const push = (block: Omit<Block, "id">) => blocks.push({ ...block, id: blockId(blocks.length, block.kind, block.text) });
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      const rows: string[][] = [cellsOf(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        rows.push(cellsOf(lines[i]!));
        i += 1;
      }
      push({ kind: "table", text: rows.map((r) => r.join(" | ")).join("\n"), rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, "").trim());
        i += 1;
      }
      push({ kind: "list", text: items.join("\n") });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4})\s+/.test(lines[i]!) && !/^\s*\|/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) {
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `${"#".repeat(block.level ?? 2)} ${block.text}`;
        case "list":
          return block.text
            .split("\n")
            .map((item) => `- ${item}`)
            .join("\n");
        case "table": {
          const rows = block.rows ?? block.text.split("\n").map((r) => r.split(" | "));
          const [header, ...body] = rows;
          if (!header) return "";
          return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
        }
        default:
          return block.text;
      }
    })
    .join("\n\n");
}

export type EpochVector = { caseId: string; epoch: number }[];

/** jsonb reorders object keys, so epoch vectors are compared through a canonical string. */
export function epochVectorKey(vector: EpochVector): string {
  return [...vector].map((v) => `${v.caseId}:${v.epoch}`).sort().join(",");
}

export function sameEpochVector(a: EpochVector, b: EpochVector): boolean {
  return epochVectorKey(a) === epochVectorKey(b);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function rebuildTableRows(text: string): string[][] {
  return text.split("\n").map((row) => row.split(" | "));
}

export interface NumericToken {
  blockId: string;
  start: number;
  end: number;
  text: string;
}

const NUMERIC_TOKEN = /\(?-?\$?\s?\d[\d,]*(?:\.\d+)?\)?(?:\s?(?:thousand|million|billion))?%?/gi;
const NON_FINANCIAL = /^(19|20)\d{2}$|^\d{1,2}$/;

/** Deterministic safety net: every numeric token in a block, so material figures cannot be silently skipped. */
export function scanNumericTokens(blocks: Block[]): NumericToken[] {
  const tokens: NumericToken[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") continue;
    for (const match of block.text.matchAll(NUMERIC_TOKEN)) {
      const text = match[0].trim().replace(/[,.]+$/, "");
      if (NON_FINANCIAL.test(text.replace(/[$,()]/g, ""))) continue;
      const start = (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
      tokens.push({ blockId: block.id, start, end: start + text.length, text });
    }
  }
  return tokens;
}

export function findOccurrence(text: string, needle: string, occurrence: number): number {
  let index = -1;
  for (let n = 0; n <= occurrence; n += 1) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) return -1;
  }
  return index;
}

/** Locates the nth occurrence of a phrase across blocks in document order. */
export function locatePhrase(blocks: Block[], needle: string, occurrence: number): { blockId: string; start: number; end: number } | null {
  let seen = 0;
  for (const block of blocks) {
    let from = 0;
    for (;;) {
      const index = block.text.indexOf(needle, from);
      if (index < 0) break;
      if (seen === occurrence) return { blockId: block.id, start: index, end: index + needle.length };
      seen += 1;
      from = index + 1;
    }
  }
  return null;
}
