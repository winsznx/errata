import { loadDocument } from "./html-tables.js";
import { normalizeWhitespace } from "./numbers.js";

export interface TextParagraph {
  index: number;
  text: string;
}

const BLOCK_SELECTOR = "p, div, li, td";

/** Returns leaf-level text blocks in document order. A block is kept only if no descendant block carries the same text. */
export function extractParagraphs(html: string | Buffer): TextParagraph[] {
  const $ = loadDocument(html);
  const out: TextParagraph[] = [];
  $(BLOCK_SELECTOR).each((_, el) => {
    if ($(el).find(BLOCK_SELECTOR).length > 0) return;
    const text = normalizeWhitespace($(el).text());
    if (text.length < 2) return;
    out.push({ index: out.length, text });
  });
  return out;
}

export interface ItemSection {
  item: string;
  heading: string;
  paragraphs: TextParagraph[];
}

const ITEM_HEADING = /^Item\s+(\d{1,2}\.\d{2})\.?\s*(.*)$/i;

export function extractItemSections(paragraphs: TextParagraph[]): ItemSection[] {
  const sections: ItemSection[] = [];
  let current: ItemSection | null = null;
  for (const paragraph of paragraphs) {
    const match = ITEM_HEADING.exec(paragraph.text);
    if (match && paragraph.text.length < 220) {
      current = { item: match[1]!, heading: paragraph.text, paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (/^SIGNATURES?$/i.test(paragraph.text)) current = null;
    if (current) current.paragraphs.push(paragraph);
  }
  return sections;
}
