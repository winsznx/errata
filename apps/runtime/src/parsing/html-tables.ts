import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Decimal } from "decimal.js";
import { findDates, normalizeWhitespace, parseDisplayedNumber } from "./numbers.js";

export type ColumnRole = "as_reported" | "adjustment" | "as_restated" | "ordinary" | "unknown";

export interface GridCell {
  start: number;
  end: number;
  text: string;
}

export interface TableColumn {
  key: string;
  positions: number[];
  headerPath: string[];
  role: ColumnRole;
  periodEnd: string | null;
}

export interface TableValue {
  columnKey: string;
  raw: string;
  value: Decimal | null;
}

export interface TableRow {
  rowIndex: number;
  label: string;
  excerpt: string;
  values: TableValue[];
}

export interface ParsedTable {
  tableIndex: number;
  context: string;
  scale: number;
  statementType: string;
  columns: TableColumn[];
  rows: TableRow[];
}

const HEADER_ROLE_PATTERNS: [RegExp, ColumnRole][] = [
  [/as\s+(previously\s+)?reported|previously\s+reported|originally\s+reported/i, "as_reported"],
  [/adjustment/i, "adjustment"],
  [/as\s+restated|restated/i, "as_restated"],
];

function cellText($: cheerio.CheerioAPI, el: AnyNode): string {
  return normalizeWhitespace($(el).text());
}

function rowCells($: cheerio.CheerioAPI, tr: Element): GridCell[] {
  const cells: GridCell[] = [];
  let pos = 0;
  $(tr)
    .children("td,th")
    .each((_, cell) => {
      const span = Math.max(1, Number($(cell).attr("colspan") ?? 1) || 1);
      const text = cellText($, cell);
      if (text) cells.push({ start: pos, end: pos + span - 1, text });
      pos += span;
    });
  return cells;
}

/** Joins split negative closers such as "(103,429" + ")" into one cell positioned at the opening cell. */
function mergeNumericFragments(cells: GridCell[]): GridCell[] {
  const merged: GridCell[] = [];
  for (const cell of cells) {
    if (cell.text === "$") continue;
    const previous = merged.at(-1);
    if (previous && /^[)%]+$/.test(cell.text)) {
      previous.text = `${previous.text}${cell.text}`;
      continue;
    }
    merged.push({ ...cell });
  }
  return merged;
}

function isValueCell(cell: GridCell): boolean {
  const parsed = parseDisplayedNumber(cell.text);
  return parsed.kind !== "none" && cell.start > 0;
}

function precedingContext($: cheerio.CheerioAPI, table: Element): string {
  const parts: string[] = [];
  let node = $(table).prev();
  let hops = 0;
  while (node.length && hops < 8 && parts.join(" ").length < 600) {
    const text = cellText($, node[0]!);
    if (text) parts.unshift(text);
    if (node.is("table")) break;
    node = node.prev();
    hops += 1;
  }
  if (!parts.length) {
    const parentPrev = $(table).parent().prev();
    if (parentPrev.length) parts.push(cellText($, parentPrev[0]!));
  }
  return parts.join(" / ").slice(-800);
}

function detectScale(text: string): number {
  if (/in\s+thousands/i.test(text)) return 3;
  if (/in\s+millions/i.test(text)) return 6;
  return 0;
}

function detectStatementType(text: string): string {
  if (/balance\s+sheets?/i.test(text) || /financial\s+position/i.test(text)) return "balance_sheet";
  if (/statements?\s+of\s+operations|income\s+statements?/i.test(text)) return "income_statement";
  if (/cash\s+flows?/i.test(text)) return "cash_flow";
  return "unknown";
}

function roleFor(headerText: string): ColumnRole {
  for (const [pattern, role] of HEADER_ROLE_PATTERNS) if (pattern.test(headerText)) return role;
  return "ordinary";
}

export function loadDocument(html: string | Buffer): cheerio.CheerioAPI {
  return cheerio.load(typeof html === "string" ? html : html.toString("utf8"));
}

export function parseTable($: cheerio.CheerioAPI, table: Element, tableIndex: number): ParsedTable | null {
  const trs = $(table).find("tr").toArray() as Element[];
  const grid = trs.map((tr) => mergeNumericFragments(rowCells($, tr)));
  const firstDataRow = grid.findIndex((cells) => cells.some(isValueCell) && (cells[0]?.start ?? 1) === 0);
  if (firstDataRow < 0) return null;

  const headerRows = grid.slice(0, firstDataRow);
  const valuePositions = new Set<number>();
  for (const cells of grid.slice(firstDataRow)) for (const cell of cells) if (isValueCell(cell)) valuePositions.add(cell.start);

  const context = precedingContext($, table);
  const tableText = cellText($, table);
  const byPath = new Map<string, TableColumn>();
  const positionToColumn = new Map<number, string>();
  for (const pos of [...valuePositions].sort((a, b) => a - b)) {
    const headerPath = headerRows
      .map((cells) => cells.find((c) => c.start <= pos && c.end >= pos && c.start > 0)?.text)
      .filter((t): t is string => Boolean(t));
    const key = headerPath.join(" | ") || `col@${pos}`;
    const existing = byPath.get(key);
    if (existing) existing.positions.push(pos);
    else {
      const headerText = headerPath.join(" ");
      const dates = findDates(headerText);
      byPath.set(key, { key, positions: [pos], headerPath, role: roleFor(headerText), periodEnd: dates[0] ?? null });
    }
    positionToColumn.set(pos, key);
  }
  const columns = [...byPath.values()];
  const contextDates = findDates(`${context} ${headerRows.flat().map((c) => c.text).join(" ")}`);
  for (const column of columns) if (!column.periodEnd && contextDates.length === 1) column.periodEnd = contextDates[0]!;

  const rows: TableRow[] = [];
  grid.forEach((cells, rowIndex) => {
    if (rowIndex < firstDataRow) return;
    const labelCells = cells.filter((c) => !isValueCell(c));
    const label = labelCells.map((c) => c.text).join(" ").trim();
    const values: TableValue[] = [];
    for (const cell of cells) {
      if (!isValueCell(cell)) continue;
      const columnKey = positionToColumn.get(cell.start);
      if (!columnKey) continue;
      const parsed = parseDisplayedNumber(cell.text);
      values.push({ columnKey, raw: cell.text, value: parsed.kind === "number" ? parsed.value : null });
    }
    if (!label || !values.length) return;
    rows.push({ rowIndex, label, excerpt: cells.map((c) => c.text).join(" "), values });
  });

  return {
    tableIndex,
    context,
    scale: detectScale(`${context} ${tableText.slice(0, 400)}`),
    statementType: detectStatementType(`${context} ${tableText.slice(0, 200)}`),
    columns,
    rows,
  };
}

export function parseTables(html: string | Buffer, filter?: (tableText: string) => boolean): ParsedTable[] {
  const $ = loadDocument(html);
  const out: ParsedTable[] = [];
  $("table").each((index, table) => {
    if (filter && !filter(cellText($, table))) return;
    const parsed = parseTable($, table as Element, index);
    if (parsed) out.push(parsed);
  });
  return out;
}

export function tableAt(html: string | Buffer, tableIndex: number): ParsedTable | null {
  const $ = loadDocument(html);
  const table = $("table").get(tableIndex);
  return table ? parseTable($, table as Element, tableIndex) : null;
}
