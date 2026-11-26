import { ENV } from "../config/env.js";

const ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "efts.sec.gov"]);
const ALLOWED_PATH = /^\/(Archives\/edgar\/data\/\d+\/[\w-]+\/[\w.-]+|submissions\/CIK\d{10}\.json|api\/xbrl\/companyfacts\/CIK\d{10}\.json)$/;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export class SecAccessError extends Error {
  constructor(
    message: string,
    readonly code: "FORBIDDEN_URL" | "RATE_LIMITED" | "HTTP_ERROR" | "TIMEOUT" | "TOO_LARGE" | "NETWORK",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function assertAllowedSecUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || !ALLOWED_PATH.test(url.pathname) || url.username || url.password) {
    throw new SecAccessError(`URL not allowed: ${raw}`, "FORBIDDEN_URL", false);
  }
  return url;
}

let nextSlot = 0;
async function acquireSlot(): Promise<void> {
  const interval = 1000 / ENV.SEC_REQUESTS_PER_SECOND;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + interval;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function secFetch(raw: string, attempt = 1): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = assertAllowedSecUrl(raw);
  await acquireSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": ENV.SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new SecAccessError(`SEC request failed: ${String(error)}`, timedOut ? "TIMEOUT" : "NETWORK", true);
  }
  clearTimeout(timer);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || attempt > 2) throw new SecAccessError("unexpected redirect", "HTTP_ERROR", false);
    return secFetch(new URL(location, url).toString(), attempt + 1);
  }
  if (response.status === 429 || response.status === 503) {
    if (attempt >= 4) throw new SecAccessError(`SEC responded ${response.status}`, "RATE_LIMITED", true);
    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
    const backoff = Math.max(retryAfter * 1000, 2 ** attempt * 1000) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, backoff));
    return secFetch(raw, attempt + 1);
  }
  if (!response.ok) throw new SecAccessError(`SEC responded ${response.status}`, "HTTP_ERROR", response.status >= 500);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new SecAccessError("response too large", "TOO_LARGE", false);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new SecAccessError("response too large", "TOO_LARGE", false);
  return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
}

export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  if (!digits || digits.length > 10) throw new Error(`invalid CIK ${cik}`);
  return digits.padStart(10, "0");
}

export function archiveUrl(cik: string, accession: string, primaryDocument: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${primaryDocument}`;
}
