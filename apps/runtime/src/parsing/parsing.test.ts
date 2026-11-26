import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractItemSections, extractParagraphs } from "./filing-text.js";
import { parseTables } from "./html-tables.js";
import { parseInlineXbrl, scenarioRole } from "./ixbrl.js";
import { findDates, parseDisplayedNumber } from "./numbers.js";

const filing = (path: string) => readFileSync(resolve(__dirname, "../../../../datasets/public-filings", path));

describe("parseDisplayedNumber", () => {
  it("handles grouping, parentheses, dashes and junk", () => {
    expect(parseDisplayedNumber("1,275,416")).toMatchObject({ kind: "number", negative: false });
    const negative = parseDisplayedNumber("(604,920)");
    expect(negative.kind === "number" && negative.value.toFixed()).toBe("-604920");
    expect(parseDisplayedNumber("–")).toMatchObject({ kind: "dash" });
    expect(parseDisplayedNumber("Total assets")).toMatchObject({ kind: "none" });
    const decimal = parseDisplayedNumber("$ 0.45");
    expect(decimal.kind === "number" && decimal.value.toFixed()).toBe("0.45");
  });

  it("reads written dates", () => {
    expect(findDates("As of March 31, 2025 and December 31,2024")).toEqual(["2025-03-31", "2024-12-31"]);
  });
});

describe("Nocera 10-K/A restatement table", () => {
  const tables = parseTables(filing("0001683168-26-006788/nocera_i10ka2-123125.htm"), (t) => /total current assets/i.test(t));
  const q1 = tables.find((t) => t.columns.some((c) => c.periodEnd === "2025-03-31" && c.role === "as_restated"));

  it("finds the Q1 2025 restated balance sheet with three role columns", () => {
    expect(q1).toBeDefined();
    expect(q1!.columns.map((c) => c.role)).toEqual(["as_reported", "adjustment", "as_restated"]);
    expect(q1!.scale).toBe(0);
  });

  it("reads total current assets and liabilities in every column", () => {
    const byLabel = (label: string) => q1!.rows.find((r) => r.label === label)!.values.map((v) => v.value?.toFixed());
    expect(byLabel("Total current assets")).toEqual(["1275416", "-604920", "670496"]);
    expect(byLabel("Total current liabilities")).toEqual(["706384", "87765", "794149"]);
  });
});

describe("inline XBRL", () => {
  it("reads the original Nocera Q1 2025 current totals", () => {
    const facts = parseInlineXbrl(filing("0001683168-25-003734/nocera_i10q-33125.htm"));
    const find = (concept: string) => facts.find((f) => f.concept === concept && f.contextRef === "AsOf2025-03-31");
    expect(find("us-gaap:AssetsCurrent")?.value?.toFixed()).toBe("1275416");
    expect(find("us-gaap:LiabilitiesCurrent")?.value?.toFixed()).toBe("706384");
  });

  it("applies scale and sign and separates restatement roles for Xencor", () => {
    const facts = parseInlineXbrl(filing("0001326732-25-000017/xncr-20240331.htm")).filter((f) => f.concept === "us-gaap:LiabilitiesCurrent" && f.context.periodEnd === "2024-03-31");
    const roles = facts.map((f) => [scenarioRole(f.context.dimensions).role, f.value?.toFixed()]);
    expect(roles).toContainEqual(["as_reported", "79402000"]);
    expect(roles).toContainEqual(["adjustment", "-8327000"]);
    expect(roles).toContainEqual([null, "71075000"]);
  });
});

describe("8-K text", () => {
  it("isolates the Item 4.02 section of the Nocera notice", () => {
    const sections = extractItemSections(extractParagraphs(filing("0001683168-26-006537/nocera_8k.htm")));
    const item = sections.find((s) => s.item === "4.02");
    expect(item?.paragraphs[0]?.text).toContain("quarterly periods ended March 31, 2025, June 30, 2025, and September 30, 2025");
  });
});
