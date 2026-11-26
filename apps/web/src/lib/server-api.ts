import "server-only";

const RUNTIME = process.env.RUNTIME_INTERNAL_URL ?? "http://127.0.0.1:4000";

export class NotFound extends Error {}

export async function runtimeGet<T>(path: string): Promise<T> {
  const response = await fetch(`${RUNTIME}${path}`, { cache: "no-store", headers: { accept: "application/json" } });
  if (response.status === 404) throw new NotFound(path);
  const body = (await response.json()) as { data?: T; error?: { message: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? `runtime responded ${response.status}`);
  return body.data;
}
