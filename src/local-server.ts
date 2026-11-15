// 1.5.0: talk to a Monomem server running on THIS computer for THIS store, without handing the main key to whatever
// program happens to listen on the port. The server first answers GET /proof: an HMAC, keyed by the main key's SHA-256,
// over a fresh nonce and the store id (http-common.ts serverProof). Only when it matches is the key sent. Used by the
// session-start hook (recall.ts: body matches on an encrypted store) and `monomem doctor` (the server's body index state).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { TOKEN_FILE, sha256Hex } from "./config.js";
import { serverProof } from "./http-common.js";

/** The main key, read only (MONOMEM_TOKEN, else the .token file): never created here. null when there is none. */
export function localKey(): string | null {
  const env = process.env.MONOMEM_TOKEN?.trim();
  if (env) return env;
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The base URL and key for 127.0.0.1:`port` when the server there proves it holds this main key and has the store
 * `storeId` open; null otherwise (nothing there, too slow for `signal`, another program, or another store).
 */
export async function provenLocalServer(port: number, storeId: string, signal: AbortSignal): Promise<{ base: string; key: string } | null> {
  const key = localKey();
  if (!key) return null;
  const base = `http://127.0.0.1:${port}`;
  try {
    const nonce = randomBytes(16).toString("hex");
    const res = await fetch(`${base}/proof?nonce=${nonce}`, { signal });
    if (!res.ok) return null;
    const proof = ((await res.json()) as { proof?: unknown }).proof;
    const want = Buffer.from(serverProof(sha256Hex(key), nonce, storeId), "hex");
    const got = typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, "hex") : Buffer.alloc(0);
    return got.length === want.length && timingSafeEqual(got, want) ? { base, key } : null;
  } catch {
    return null; // nothing on the port, too slow, or not a Monomem answer
  }
}
