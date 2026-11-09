// Read and edit <data dir>/tokens.json for `monomem token add|list|remove`.
// Format: a JSON array of { token, scope, label, namespace? } (docs/token-namespaces.md), exactly what
// config.ts resolveTokens() loads. This file never prints or logs a token it did not just generate.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "./security.js";

export type TokenScope = "read" | "write" | "admin";
export interface TokenRow {
  token: string;
  scope: TokenScope;
  label: string;
  namespace?: string;
}

export class TokenFileError extends Error {}

const SCOPES: readonly string[] = ["read", "write", "admin"];

function needFolder(file: string): void {
  if (!existsSync(dirname(file))) {
    throw new TokenFileError(`The data folder ${dirname(file)} does not exist yet. Start Monomem once (or run: monomem init) to create it, then try again.`);
  }
}

function load(file: string): TokenRow[] {
  if (!existsSync(file)) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new TokenFileError(`${file} is not valid JSON; fix or remove it by hand first (nothing was changed).`);
  }
  if (!Array.isArray(arr)) throw new TokenFileError(`${file} is not a JSON array; fix it by hand first (nothing was changed).`);
  return arr as TokenRow[];
}

const isRow = (r: unknown): r is TokenRow => r !== null && typeof r === "object" && !Array.isArray(r);

function save(file: string, rows: TokenRow[]): void {
  needFolder(file);
  const tmp = `${file}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); // a stale tmp file would keep whatever mode it already had
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600); // explicit, whatever the umask
  renameSync(tmp, file); // atomic; the new file keeps the tmp file's 0600 on POSIX (Windows ignores modes)
}

export function tokensPath(dataDir: string): string {
  return join(dataDir, "tokens.json");
}

/** Add a new random token. Returns it ONCE; only the caller can show it. */
export function addToken(dataDir: string, label: string, scope: string, namespace?: string): TokenRow {
  const name = label.trim();
  if (!name) throw new TokenFileError("--label is required (a short name for who uses this token).");
  if (!SCOPES.includes(scope)) throw new TokenFileError("--scope must be read, write or admin.");
  const ns = namespace?.trim();
  if (namespace !== undefined && !ns) throw new TokenFileError("--namespace must not be empty.");
  const file = tokensPath(dataDir);
  needFolder(file);
  const rows = load(file);
  if (rows.some((r) => isRow(r) && r.label === name)) throw new TokenFileError(`A token labelled "${name}" already exists; pick another label or remove it first.`);
  const row: TokenRow = { token: randomBytes(32).toString("hex"), scope: scope as TokenScope, label: name, ...(ns ? { namespace: ns } : {}) };
  save(file, [...rows, row]);
  audit({ op: "token.add", label: "cli", kind: "token", detail: `${name} scope=${scope} ns=${ns ?? "-"} max=none` });
  return row;
}

/** Labels, scopes and pins only: never the secret. A null or non-object row is skipped (the server skips it too; `remove` leaves it in the file). */
export function listTokens(dataDir: string): Array<Omit<TokenRow, "token">> {
  const file = tokensPath(dataDir);
  needFolder(file);
  return load(file)
    .filter(isRow)
    .map(({ scope, label, namespace }) => ({ label, scope, ...(namespace ? { namespace } : {}) }));
}

/** Count and labels of the extra tokens that come from MONOMEM_TOKENS (never the secrets); null when unset or not a JSON array. */
export function envTokenLabels(raw: string | undefined = process.env.MONOMEM_TOKENS): string[] | null {
  if (!raw || !raw.trim()) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter(isRow).map((r) => String(r.label ?? "(no label)"));
  } catch {
    return null;
  }
}

/** True when a token with that label was removed. */
export function removeToken(dataDir: string, label: string): boolean {
  const file = tokensPath(dataDir);
  const rows = load(file);
  const kept = rows.filter((r) => !(isRow(r) && r.label === label));
  if (kept.length === rows.length) return false;
  save(file, kept);
  audit({ op: "token.remove", label: "cli", kind: "token", detail: label });
  return true;
}
