// A short-lived, single-use code for `monomem open`. The browser address used to carry the main key itself, which ends up
// in browser history and in the list of running programs. Now the address carries a random code that is worth nothing
// after 60 seconds or after its first use; the dashboard swaps it for the key over a normal request.
// The code is kept hashed in <data dir>/login-code (mode 0600). Only one code is outstanding at a time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { atTerminal } from "./taint.js";

export const LOGIN_CODE_TTL_MS = 60_000;
const file = (): string => join(DATA_DIR, "login-code");
const hash = (code: string): Buffer => createHash("sha256").update(code).digest();

/**
 * 1.4.0: the code remembers whether it was minted at a terminal (stdin and stdout). Only such a code opens a dashboard
 * session (api.ts), the one sign-in whose confirms skip the read rule: `monomem open` run by an agent's shell tool still
 * signs in, but as the plain key. A pseudo-terminal passes this check (SECURITY.md).
 */
export function mintLoginCode(now = Date.now(), terminal = atTerminal()): string {
  const code = randomBytes(16).toString("hex");
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify({ h: hash(code).toString("hex"), exp: now + LOGIN_CODE_TTL_MS, t: terminal }), { mode: 0o600 });
  try {
    chmodSync(file(), 0o600);
  } catch {
    /* not supported on this system */
  }
  return code;
}

/** True once for a good, unexpired code; a good code is spent by its use, a wrong guess spends nothing. */
export function redeemLoginCode(code: unknown, now = Date.now()): boolean {
  return redeemLogin(code, now) !== null;
}

/** redeemLoginCode, saying whether the code was minted at a terminal (null = not a good code). */
export function redeemLogin(code: unknown, now = Date.now()): { terminal: boolean } | null {
  if (typeof code !== "string" || !/^[0-9a-f]{32}$/.test(code) || !existsSync(file())) return null;
  let rec: { h?: string; exp?: number; t?: unknown };
  try {
    rec = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return null;
  }
  // Single use, but only a MATCH (or an expired code) spends it: an unauthenticated POST /login with a wrong guess must not burn the
  // real code (05-RT-4). Guessing is not a risk (128 random bits) and api/login-guard.ts limits wrong guesses per source.
  if (typeof rec.h !== "string" || typeof rec.exp !== "number" || now > rec.exp) {
    rmSync(file(), { force: true });
    return null;
  }
  const want = Buffer.from(rec.h, "hex");
  const got = hash(code);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  // Spent atomically: only the request whose rename wins gets in, so two at once with the right code cannot both pass.
  const spent = `${file()}.${process.pid}.${Date.now()}.spent`;
  try {
    renameSync(file(), spent);
  } catch {
    return null;
  }
  rmSync(spent, { force: true });
  return { terminal: rec.t === true };
}
