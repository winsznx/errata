import type * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { Decimal } from "decimal.js";
import { loadDocument } from "./html-tables.js";
import { normalizeWhitespace } from "./numbers.js";

export interface XbrlContext {
  id: string;
  periodType: "instant" | "duration";
  periodStart: string | null;
  periodEnd: string;
  dimensions: Record<string, string>;
}

export interface XbrlFact {
  factId: string;
  concept: string;
  contextRef: string;
  context: XbrlContext;
  unitRef: string | null;
  unit: string;
  decimals: string | null;
  scale: number;
  sign: "-" | null;
  format: string | null;
  rawText: string;
  value: Decimal | null;
  rowLabel: string;
  rowExcerpt: string;
}

const ZERO_FORMATS = /(fixed-zero|zerodash|numdash|fixed-empty)/i;
const RESTATEMENT_AXES = /(:RestatementAxis|:StatementScenarioAxis|:ErrorCorrectionsAndPriorPeriodAdjustmentsRestatementByRestatementPeriodAndAmountAxis)$/;
const ADJUSTMENT_MEMBERS = /(RestatementAdjustmentMember|RevisionOfPriorPeriodErrorCorrectionAdjustmentMember|RevisionOfPriorPeriodAdjustmentMember)$/;
const PREVIOUSLY_REPORTED_MEMBERS = /(ScenarioPreviouslyReportedMember|PreviouslyReportedMember)$/;

function parseContexts($: cheerio.CheerioAPI): Map<string, XbrlContext> {
  const contexts = new Map<string, XbrlContext>();
  $("xbrli\\:context").each((_, el) => {
    const node = $(el);
    const id = node.attr("id");
    if (!id) return;
    const instant = normalizeWhitespace(node.find("xbrli\\:instant").first().text());
    const start = normalizeWhitespace(node.find("xbrli\\:startdate").first().text());
    const end = normalizeWhitespace(node.find("xbrli\\:enddate").first().text());
    const dimensions: Record<string, string> = {};
    node.find("xbrldi\\:explicitmember").each((__, member) => {
      const dimension = $(member).attr("dimension");
      if (dimension) dimensions[dimension] = normalizeWhitespace($(member).text());
    });
    node.find("xbrldi\\:typedmember").each((__, member) => {
      const dimension = $(member).attr("dimension");
      if (dimension) dimensions[dimension] = normalizeWhitespace($(member).text());
    });
    contexts.set(
      id,
      instant
        ? { id, periodType: "instant", periodStart: null, periodEnd: instant, dimensions }
        : { id, periodType: "duration", periodStart: start || null, periodEnd: end, dimensions },
    );
  });
  return contexts;
}

function parseUnits($: cheerio.CheerioAPI): Map<string, string> {
  const units = new Map<string, string>();
  $("xbrli\\:unit").each((_, el) => {
    const id = $(el).attr("id");
    if (!id) return;
    const measures = $(el)
      .find("xbrli\\:measure")
      .toArray()
      .map((m) => normalizeWhitespace($(m).text()).replace(/^iso4217:/i, "").replace(/^xbrli:/i, ""));
    const isDivide = $(el).find("xbrli\\:divide").length > 0;
    units.set(id, isDivide ? measures.join("/") : measures.join("*"));
  });
  return units;
}

function rowContext($: cheerio.CheerioAPI, el: Element): { label: string; excerpt: string } {
  const row = $(el).closest("tr");
  if (!row.length) {
    const text = normalizeWhitespace($(el).parent().text());
    return { label: text.slice(0, 120), excerpt: text.slice(0, 400) };
  }
  const cells = row
    .children("td,th")
    .toArray()
    .map((c) => normalizeWhitespace($(c).text()))
    .filter(Boolean);
  return { label: cells[0] ?? "", excerpt: cells.join(" ").slice(0, 400) };
}

export function parseInlineXbrl(html: string | Buffer): XbrlFact[] {
  const $ = loadDocument(html);
  const contexts = parseContexts($);
  const units = parseUnits($);
  const facts: XbrlFact[] = [];
  $("ix\\:nonfraction").each((_, raw) => {
    const el = raw as Element;
    const node = $(el);
    const concept = node.attr("name");
    const contextRef = node.attr("contextref");
    const factId = node.attr("id");
    if (!concept || !contextRef || !factId) return;
    const context = contexts.get(contextRef);
    if (!context) return;
    const unitRef = node.attr("unitref") ?? null;
    const scale = Number(node.attr("scale") ?? "0") || 0;
    const sign = node.attr("sign") === "-" ? "-" : null;
    const format = node.attr("format") ?? null;
    const rawText = normalizeWhitespace(node.text());
    const isNil = node.attr("xsi:nil") === "true" || node.attr("xs:nil") === "true";
    let value: Decimal | null = null;
    if (!isNil) {
      if (format && ZERO_FORMATS.test(format)) value = new Decimal(0);
      else {
        const digits = rawText.replace(/[,\s$]/g, "");
        if (/^[0-9]+(\.[0-9]+)?$/.test(digits)) value = new Decimal(digits).times(new Decimal(10).pow(scale));
      }
      if (value && sign === "-") value = value.negated();
    }
    const { label, excerpt } = rowContext($, el);
    facts.push({
      factId,
      concept,
      contextRef,
      context,
      unitRef,
      unit: unitRef ? (units.get(unitRef) ?? unitRef) : "pure",
      decimals: node.attr("decimals") ?? null,
      scale,
      sign,
      format,
      rawText,
      value,
      rowLabel: label,
      rowExcerpt: excerpt,
    });
  });
  return facts;
}

/** Splits the restatement axis out of a context so the economic identity excludes it. */
export function scenarioRole(dimensions: Record<string, string>): {
  role: "as_reported" | "adjustment" | null;
  identityDimensions: Record<string, string>;
} {
  const scenarioEntry = Object.entries(dimensions).find(([axis]) => RESTATEMENT_AXES.test(axis));
  if (!scenarioEntry) return { role: null, identityDimensions: dimensions };
  const [scenarioAxis, member] = scenarioEntry;
  const identityDimensions = Object.fromEntries(Object.entries(dimensions).filter(([axis]) => axis !== scenarioAxis));
  if (PREVIOUSLY_REPORTED_MEMBERS.test(member)) return { role: "as_reported", identityDimensions };
  if (ADJUSTMENT_MEMBERS.test(member)) return { role: "adjustment", identityDimensions };
  return { role: null, identityDimensions: dimensions };
}

export function findFactElement(html: string | Buffer, factId: string): { text: string; value: Decimal | null } | null {
  const $ = loadDocument(html);
  const node = $(`ix\\:nonfraction[id="${factId.replace(/"/g, "")}"]`).first();
  if (!node.length) return null;
  const text = normalizeWhitespace(node.text());
  const digits = text.replace(/[,\s$]/g, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(digits)) return { text, value: null };
  const scale = Number(node.attr("scale") ?? "0") || 0;
  const value = new Decimal(digits).times(new Decimal(10).pow(scale));
  return { text, value: node.attr("sign") === "-" ? value.negated() : value };
}
