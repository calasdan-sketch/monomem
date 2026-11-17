// OAuth state that must outlive one server process and be shared with the CLI: <data dir>/oauth.json (mode 0600).
// Holds the on/off switch and public URL, the one-time pairing code (hash only), registered clients, and grants
// (refresh-token hashes only). The access key itself is an ordinary tokens.json entry (tokens-admin.ts), so it shows up
// in `monomem keys` and the dashboard and is removed there. Authorization codes stay in server memory (routes.ts).
// Not in the notes database: SCHEMA_VERSION stays 22, and deleting this one file (plus the oauth: keys) removes OAuth.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, isLoopback } from "../config.js";
import { withFileLock } from "../tokens-admin.js";

/** Tests move time forward without waiting. */
export const clock = { now: (): number => Date.now() };

export const PAIR_TTL_MS = 10 * 60_000;
/** Wrong pairing codes before the code is burned (a new one needs `monomem oauth pair` again). */
export const PAIR_MAX_FAILS = 5;
/** A client nobody approved within a day is dropped (claude.ai registers a new client on every fresh connection). */
export const CLIENT_UNUSED_TTL_MS = 24 * 3600_000;
export const MAX_CLIENTS = 50;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}
export interface OAuthGrant {
  /** The tokens.json label of this grant's access key ("oauth:<client name>"). */
  label: string;
  client_id: string;
  scope: "read" | "write";
  refresh_sha256: string;
  refresh_exp: number;
  /** Earlier refresh tokens of this grant: one coming back means it was copied, so the grant is revoked. */
  used_refresh: string[];
  created_at: number;
  refreshed_at: number;
  redirect_host: string;
}
export interface OAuthState {
  enabled: boolean;
  /** Public https URL people reach the MCP port at (the OAuth issuer); the MCP resource is issuer + "/mcp". */
  issuer?: string;
  pair?: { sha256: string; exp: number; fails: number };
  clients: OAuthClient[];
  grants: OAuthGrant[];
}

export const statePath = (): string => join(DATA_DIR, "oauth.json");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const EMPTY = (): OAuthState => ({ enabled: false, clients: [], grants: [] });
let cache: { sig: string; state: OAuthState } | undefined;

/** The current state; a missing or broken file reads as "off" (fail closed). Cached on the file's mtime and size. */
export function readState(): OAuthState {
  const f = statePath();
  let sig = "none";
  try {
    const st = statSync(f);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    return EMPTY();
  }
  if (cache?.sig === sig) return cache.state;
  let state = EMPTY();
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<OAuthState>;
    state = { enabled: raw.enabled === true, issuer: typeof raw.issuer === "string" ? raw.issuer : undefined, pair: raw.pair, clients: Array.isArray(raw.clients) ? raw.clients : [], grants: Array.isArray(raw.grants) ? raw.grants : [] };
  } catch {
    console.error(`[monomem] ${f} is not valid JSON, so OAuth stays off. Run: monomem oauth off, then monomem oauth on <url>`);
  }
  cache = { sig, state };
  return state;
}

/** Read, change and write oauth.json under its own lock (atomic rename, mode 0600). */
export function updateState<T>(fn: (s: OAuthState) => { next: OAuthState; result: T }): T {
  const f = statePath();
  return withFileLock(f, () => {
    cache = undefined;
    const before = existsSync(f) ? readState() : EMPTY();
    const { next, result } = fn(before);
    if (next === before) return result; // nothing changed: no write
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* not supported on this system */
    }
    renameSync(tmp, f);
    cache = undefined;
    return result;
  });
}

/**
 * The public URL becomes the issuer. It must be https (claude.ai and ChatGPT only talk to https), except a loopback
 * address, which is only useful for testing on this computer. Returns the issuer, or throws a plain sentence.
 */
export function normalizeIssuer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a URL. Give the https address people reach Monomem at, for example https://my-pc.tail1234.ts.net`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(host))) {
    throw new Error("The address must start with https:// (claude.ai and ChatGPT refuse plain http). See docs/oauth.md for Tailscale Funnel or Cloudflare Tunnel.");
  }
  if (u.username || u.password || u.search || u.hash) throw new Error("Give just the address, without a user name, ? or #.");
  return u.origin;
}

export function setEnabled(on: boolean, issuer?: string): OAuthState {
  return updateState((s) => {
    const next: OAuthState = { ...s, enabled: on, ...(issuer !== undefined ? { issuer: normalizeIssuer(issuer) } : {}) };
    if (on && !next.issuer) throw new Error("Give the public https address first: monomem oauth on https://<your address>");
    if (!on) delete next.pair;
    return { next, result: next };
  });
}

const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const normPair = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A fresh one-time pairing code (10 minutes). Only its hash is stored; the caller shows it to the person once. */
export function newPairCode(): string {
  let c = "";
  for (let i = 0; i < 10; i++) c += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  updateState((s) => ({ next: { ...s, pair: { sha256: sha256(c), exp: clock.now() + PAIR_TTL_MS, fails: 0 } }, result: undefined }));
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** Check (and on success use up) the pairing code. A wrong code counts; PAIR_MAX_FAILS wrong codes burn it. */
export function usePairCode(given: string): boolean {
  return updateState((s) => {
    const p = s.pair;
    if (!p || clock.now() > p.exp) {
      const { pair: _gone, ...rest } = s;
      return { next: rest, result: false };
    }
    const ok = timingSafeEqual(Buffer.from(sha256(normPair(given)), "hex"), Buffer.from(p.sha256, "hex"));
    if (ok) {
      const { pair: _used, ...rest } = s;
      return { next: rest, result: true };
    }
    const fails = p.fails + 1;
    if (fails >= PAIR_MAX_FAILS) {
      const { pair: _burned, ...rest } = s;
      return { next: rest, result: false };
    }
    return { next: { ...s, pair: { ...p, fails } }, result: false };
  });
}
