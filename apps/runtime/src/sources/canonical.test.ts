import { describe, expect, it } from "vitest";
import { canonicalFiling, filingHash } from "./canonical.js";

const body = "<html><body><p>Total current assets 1,275,416</p>";

describe("filingHash", () => {
  it("gives two downloads that differ only in the CDN script the same hash", () => {
    // #given
    const first = Buffer.from(`${body}<script type="text/javascript"  src="/SmPux8FSAuH-Q7UNQ/M01OIG1RMA"></script></body>\n</html>`);
    const second = Buffer.from(`${body}<script type="text/javascript"  src="/ZT7S0xInzq/F7/C3emAbG6"></script></body>\n</html>`);
    // #then
    expect(filingHash(first)).toBe(filingHash(second));
  });

  it("still detects a change in the filed content", () => {
    // #given
    const original = Buffer.from(`${body}<script type="text/javascript"  src="/abc"></script></body></html>`);
    const altered = Buffer.from(original.toString().replace("1,275,416", "1,275,417"));
    // #then
    expect(filingHash(original)).not.toBe(filingHash(altered));
  });

  it("does not strip scripts the issuer placed elsewhere", () => {
    // #given
    const filed = Buffer.from(`<html><body><script type="text/javascript"  src="/x"></script><p>a</p></body></html>`);
    // #then
    expect(canonicalFiling(filed).toString()).toContain('src="/x"');
  });
});
