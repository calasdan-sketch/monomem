// A short-lived, single-use code for `monomem open`. The browser address used to carry the main key itself, which ends up
// in browser history and in the list of running programs. Now the address carries a random code that is worth nothing
// after 60 seconds or after its first use; the dashboard swaps it for the key over a normal request.
// The code is kept hashed in <data dir>/login-code (mode 0600). Only one code is outstanding at a time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

export const LOGIN_CODE_TTL_MS = 60_000;
const file = (): string => join(DATA_DIR, "login-code");
const hash = (code: string): Buffer => createHash("sha256").update(code).digest();

export function mintLoginCode(now = Date.now()): string {
  const code = randomBytes(16).toString("hex");
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify({ h: hash(code).toString("hex"), exp: now + LOGIN_CODE_TTL_MS }), { mode: 0o600 });
  try {
    chmodSync(file(), 0o600);
  } catch {
    /* not supported on this system */
  }
  return code;
}

/** True once for a good, unexpired code; the code is spent either way. */
export function redeemLoginCode(code: unknown, now = Date.now()): boolean {
  if (typeof code !== "string" || !/^[0-9a-f]{32}$/.test(code) || !existsSync(file())) return false;
  let rec: { h?: string; exp?: number };
  try {
    rec = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return false;
  }
  rmSync(file(), { force: true }); // single use: spent whether or not it matches (a wrong guess burns it)
  if (typeof rec.h !== "string" || typeof rec.exp !== "number" || now > rec.exp) return false;
  const want = Buffer.from(rec.h, "hex");
  const got = hash(code);
  return want.length === got.length && timingSafeEqual(want, got);
}
