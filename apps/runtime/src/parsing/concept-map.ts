const LABEL_CONCEPTS: [RegExp, string][] = [
  [/^total current assets$/i, "us-gaap:AssetsCurrent"],
  [/^total current liabilities$/i, "us-gaap:LiabilitiesCurrent"],
  [/^total assets$/i, "us-gaap:Assets"],
  [/^total liabilities$/i, "us-gaap:Liabilities"],
  [/^cash and cash equivalents$/i, "us-gaap:CashAndCashEquivalentsAtCarryingValue"],
  [/^goodwill$/i, "us-gaap:Goodwill"],
  [/^accounts receivable(, net)?$/i, "us-gaap:AccountsReceivableNetCurrent"],
  [/^income tax payable$/i, "us-gaap:AccruedIncomeTaxesCurrent"],
  [/^total (stockholders[’']? |shareholders[’']? )?equity$/i, "us-gaap:StockholdersEquity"],
];

export interface ConceptMapping {
  conceptId: string;
  method: "label_map" | "label_only";
}

/** Maps a printed row label to a standard concept only for unambiguous totals; everything else keeps a company-scoped label concept. */
export function conceptForLabel(label: string): ConceptMapping {
  const clean = label.replace(/\s+/g, " ").trim();
  for (const [pattern, conceptId] of LABEL_CONCEPTS) if (pattern.test(clean)) return { conceptId, method: "label_map" };
  const slug = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return { conceptId: `label:${slug}`, method: "label_only" };
}

export function semanticKey(parts: {
  cik: string;
  conceptId: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string;
  dimensions: Record<string, string>;
  unit: string;
}): string {
  const dims = Object.entries(parts.dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([axis, member]) => `${axis}=${member}`)
    .join(",");
  return [parts.cik, parts.conceptId, parts.periodType, parts.periodStart ?? "", parts.periodEnd, dims, parts.unit].join("|");
}
