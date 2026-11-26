export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function parse<T>(response: Response): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.error) {
    throw new ApiError(response.status, body?.error?.code ?? "NETWORK", body?.error?.message ?? `Request failed with status ${response.status}`, body?.error?.details ?? {});
  }
  return body.data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" }, cache: "no-store" });
  return parse<T>(response);
}

export async function apiSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, options: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-errata-client": "web", accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const response = await fetch(path, { method, credentials: "same-origin", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return parse<T>(response);
}

export const fetcher = <T,>(path: string): Promise<T> => apiGet<T>(path);

export function newKey(): string {
  return crypto.randomUUID();
}

export function ws(workspaceId: string, path = ""): string {
  return `/api/v1/workspaces/${workspaceId}${path}`;
}
