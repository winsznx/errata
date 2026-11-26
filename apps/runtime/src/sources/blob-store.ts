import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ENV } from "../config/env.js";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobPath(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid blob hash");
  return resolve(process.cwd(), ENV.SOURCE_CACHE_DIR, hash.slice(0, 2), hash);
}

export async function putBlob(bytes: Uint8Array): Promise<{ hash: string; storageRef: string }> {
  const hash = sha256(bytes);
  const path = blobPath(hash);
  try {
    await access(path);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return { hash, storageRef: `sha256:${hash}` };
}

export async function getBlob(storageRef: string): Promise<Buffer> {
  const hash = storageRef.replace(/^sha256:/, "");
  const bytes = await readFile(blobPath(hash));
  if (sha256(bytes) !== hash) throw new Error(`blob integrity failure for ${storageRef}`);
  return bytes;
}
