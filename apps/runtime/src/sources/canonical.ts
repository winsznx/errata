import { sha256 } from "./blob-store.js";

const CDN_SCRIPT = /<script type="text\/javascript" {1,2}src="\/[A-Za-z0-9_/-]+"><\/script>(?=<\/body>\s*<\/html>\s*$)/;

/**
 * sec.gov's CDN appends a per-request bot-detection script tag just before </body>, so two downloads of the same
 * filing never have the same raw bytes. The canonical form drops only that final tag; everything the issuer filed
 * is hashed unchanged.
 */
export function canonicalFiling(bytes: Uint8Array): Buffer {
  const text = Buffer.from(bytes).toString("latin1");
  return Buffer.from(text.replace(CDN_SCRIPT, ""), "latin1");
}

export function filingHash(bytes: Uint8Array): string {
  return sha256(canonicalFiling(bytes));
}
