// Managing the apps that may connect: add / list / remove entries in <data dir>/tokens.json.
//
// Used by `monomem token ...` and by the dashboard's Apps panel (admin only). It never returns or prints a secret except
// the one the caller just minted, once. tokens.json is written atomically (a temporary file, then a rename), with mode 0600,
// and the previous file is kept as tokens.json.bak. The running servers pick the change up on their own (startTokenReload).
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_PORT, BIND_HOST, DATA_DIR, MCP_HTTP_PORT, MIN_TOKEN_LENGTH, resolveTokens, sha256Hex, tokenId, type Scope } from "./config.js";
import { audit } from "./security.js";
import { DEFAULT_SENSITIVITY, SENSITIVITY_HELP, parseSensitivity, type Sensitivity } from "./sensitivity.js";

export class TokenAdminError extends Error {}

interface RawEntry {
  /** Plain-text key: only in a file written by 1.4.x or earlier (hashed automatically on first start of 1.5.0). */
  token?: string;
  /** sha256 (hex) of the key: how 1.5.0 stores it. */
  token_sha256?: string;
  scope: Scope;
  label: string;
  namespace?: string;
  max_sensitivity?: Sensitivity;
  created_at?: string;
  [k: string]: unknown;
}

export interface ListedApp {
  label: string;
  scope: Scope;
  namespace: string | null;
  /** null = no limit (the app can read every label). */
  max_sensitivity: Sensitivity | null;
  /** "file" can be removed here; the others are set in the environment or are the main token. */
  source: "file" | "environment" | "main";
  created_at: string | null;
}

export const tokensPath = (): string => join(DATA_DIR, "tokens.json");

function readRaw(): RawEntry[] {
  const f = tokensPath();
  if (!existsSync(f)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    throw new TokenAdminError(`${f} is not valid JSON, so nothing was changed. Fix or delete the file, then try again.`);
  }
  if (!Array.isArray(parsed)) throw new TokenAdminError(`${f} should hold a JSON list, so nothing was changed.`);
  return parsed as RawEntry[];
}

/**
 * Reading tokens.json, changing it and writing it back must not interleave with another `monomem token ...` or the
 * dashboard doing the same, or one change is lost. A lock directory (like the audit-log rotation uses) serialises them.
 */
function withLock<T>(fn: () => T): T {
  const lock = tokensPath() + ".lock";
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw friendlyFsError(e);
  }
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw friendlyFsError(e);
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true }); // left by a crash
      } catch {
        /* the owner just finished */
      }
      if (Date.now() - start > 5000) throw new TokenAdminError("Another change to the apps list is still running. Wait a moment and try again.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } catch (e) {
    throw friendlyFsError(e);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** A permissions problem becomes a plain sentence instead of a raw EACCES. */
function friendlyFsError(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new TokenAdminError(`Monomem cannot write to its data folder (${DATA_DIR}): permission denied. Fix the folder's permissions (or run as the user who owns it), or point MONOMEM_HOME at a folder you can write to. Nothing was changed.`);
  }
  return e;
}

function writeRaw(entries: RawEntry[], opts: { keepBackup?: boolean } = {}): void {
  const f = tokensPath();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // A file written by 1.4.x or earlier keeps keys in plain text, so a backup copy is one more place a key could sit. Removing an
  // app (and hardening) deletes the backup instead of leaving a revoked or plain-text key in it.
  if (opts.keepBackup !== false && existsSync(f)) {
    copyFileSync(f, f + ".bak");
    try {
      chmodSync(f + ".bak", 0o600);
    } catch {
      /* not supported on this system */
    }
  }
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* not supported on this system */
  }
  renameSync(tmp, f);
  if (opts.keepBackup === false) rmSync(f + ".bak", { force: true });
}

/** A new random token: 64 hex characters (256 bits). */
export const newTokenValue = (): string => randomBytes(32).toString("hex");

export function listApps(): ListedApp[] {
  const fileLabels = new Map<string, RawEntry>();
  try {
    for (const e of readRaw()) if (e && typeof e.label === "string" && (e.token || e.token_sha256)) fileLabels.set(tokenId(e), e);
  } catch {
    /* a broken file is reported by add/remove; list shows what is accepted */
  }
  return resolveTokens().map((t) => {
    const f = fileLabels.get(tokenId(t));
    return {
      label: t.label || "(unnamed)",
      scope: t.scope,
      namespace: t.namespace ?? null,
      max_sensitivity: t.max_sensitivity ?? null,
      source: t.label === "primary" ? "main" : f ? "file" : "environment",
      created_at: f && typeof f.created_at === "string" ? f.created_at : null,
    };
  });
}

export interface AddOptions {
  label: string;
  scope?: string;
  namespace?: string;
  max?: string;
  admin?: boolean;
  /** Make a key with NO sensitivity limit (it can read private notes and change labels). Only for a caller that has none itself. */
  noLimit?: boolean;
  /** Label of whoever asked (the REST caller's token label); "cli" when unset. Goes to the audit log, never the secret. */
  by?: string;
}

export function addApp(o: AddOptions): { token: string; app: ListedApp; ceilingWasDefault: boolean } {
  const label = (o.label ?? "").trim();
  if (!label) throw new TokenAdminError("Give the app a name, for example: monomem token add cursor");
  if (label.length > 64 || !/^[\w .@+-]+$/.test(label)) throw new TokenAdminError(`"${label}" is not a good name: use letters, numbers, spaces, dots, dashes (up to 64).`);
  let scope: Scope = "write";
  if (o.scope !== undefined) {
    if (o.scope !== "read" && o.scope !== "write") {
      throw new TokenAdminError(o.scope === "admin" ? 'To make an app an administrator, add --admin (an administrator app can change and delete anything it can see).' : `--scope must be read or write (got "${o.scope}").`);
    }
    scope = o.scope;
  }
  if (o.admin) scope = "admin";
  let ns: string | undefined;
  if (o.namespace !== undefined) {
    ns = o.namespace.trim();
    if (!ns) throw new TokenAdminError("--namespace needs a name, for example --namespace work");
  }
  let max: Sensitivity | undefined = DEFAULT_SENSITIVITY;
  let ceilingWasDefault = true;
  if (o.noLimit && o.max !== undefined) throw new TokenAdminError("Choose either a limit (--max) or --no-limit, not both.");
  if (o.noLimit) {
    max = undefined;
    ceilingWasDefault = false;
  } else if (o.max !== undefined) {
    const m = parseSensitivity(o.max);
    if (!m) throw new TokenAdminError(`--max must be ${SENSITIVITY_HELP} (got "${o.max}").`);
    max = m;
    ceilingWasDefault = false;
  }
  return withLock(() => {
  const entries = readRaw();
  const taken = new Set([...entries.map((e) => (e.label ?? "").toLowerCase()), ...resolveTokens().map((t) => (t.label ?? "").toLowerCase()), "primary"]);
  if (taken.has(label.toLowerCase())) throw new TokenAdminError(`An app called "${label}" already exists. Pick another name, or remove it first: monomem token remove "${label}"`);
  const token = newTokenValue();
  const entry: RawEntry = { token_sha256: sha256Hex(token), scope, label, ...(ns ? { namespace: ns } : {}), ...(max !== undefined ? { max_sensitivity: max } : {}), created_at: new Date().toISOString() };
  writeRaw([...entries, entry]);
  audit({ op: "token.add", label: o.by ?? "cli", kind: "token", detail: `${label} scope=${scope} ns=${ns ?? "-"} max=${max ?? "none"}` });
  return {
    token,
    ceilingWasDefault,
    app: { label, scope, namespace: ns ?? null, max_sensitivity: max ?? null, source: "file" as const, created_at: entry.created_at! },
  };
  });
}

/**
 * 1.5.0 (owner decision): replace every plain-text key in tokens.json by its sha256, once, on the first start of the new
 * version. The rewrite is atomic (temporary file, then rename) under the same lock as every other change, no plain-text copy
 * (tokens.json.bak) is left behind, and running it again changes nothing. Clients keep sending the same key, so nothing
 * changes for them. A key too short to be accepted is left as it is (hashing it would make it acceptable). A file that
 * cannot be read or written is left alone: the plain-text keys keep working. Downgrading to 1.4.x or earlier afterwards
 * cannot read the hashed entries: run `monomem connect <app>` again for each app (docs/upgrading.md).
 */
export function hardenTokensFile(): { converted: number } {
  const f = tokensPath();
  if (!existsSync(f) && !existsSync(f + ".bak")) return { converted: 0 };
  try {
    return withLock(() => {
      let converted = 0;
      if (existsSync(f)) {
        let entries: RawEntry[];
        try {
          entries = readRaw();
        } catch {
          return { converted: 0 }; // a broken file is reported by resolveTokens; its .bak may be the only good copy
        }
        const next = entries.map((e) => {
          if (!e || typeof e !== "object" || typeof e.token !== "string" || e.token_sha256 !== undefined || e.token.trim().length < MIN_TOKEN_LENGTH) return e;
          const { token, ...rest } = e;
          converted++;
          return { token_sha256: sha256Hex(token.trim()), ...rest } as RawEntry;
        });
        if (converted > 0) writeRaw(next, { keepBackup: false });
      }
      rmSync(f + ".bak", { force: true });
      return { converted };
    });
  } catch (e) {
    console.error(`[monomem] could not harden ${f} (${(e as Error).message}); the keys in it keep working as they are. Try: monomem token harden`);
    return { converted: 0 };
  }
}

/** How many entries in tokens.json still hold a key in plain text (`monomem doctor` says so; `monomem token harden` fixes it). */
export function plainKeyCount(): number {
  try {
    return readRaw().filter((e) => e && typeof e.token === "string").length;
  } catch {
    return 0;
  }
}

export function removeApp(label: string, by = "cli"): boolean {
  return withLock(() => {
    const entries = readRaw();
    const keep = entries.filter((e) => (e.label ?? "").toLowerCase() !== label.trim().toLowerCase());
    if (keep.length === entries.length) return false;
    writeRaw(keep, { keepBackup: false });
    audit({ op: "token.remove", label: by, kind: "token", detail: label.trim() });
    return true;
  });
}

/** One plain sentence: what this app can and cannot do. */
export function describeAccess(a: Pick<ListedApp, "scope" | "namespace" | "max_sensitivity">): string {
  const does = a.scope === "read" ? "read notes" : a.scope === "write" ? "read and write notes" : "read, write, delete and manage everything it can see";
  const sees =
    a.max_sensitivity === "public"
      ? "only notes labelled public"
      : a.max_sensitivity === "internal"
        ? "public and internal notes, but not private ones"
        : a.max_sensitivity === "private"
          ? "every note, including private ones"
          : "every note, including private ones (it has no limit)";
  const where = a.namespace ? ` and only in the "${a.namespace}" space` : "";
  return `This app can ${does}. It can see ${sees}${where}.`;
}

/** Ready-to-paste connection details for an app that uses the HTTP server. */
export function connectionSnippet(token: string, host = BIND_HOST === "0.0.0.0" ? "127.0.0.1" : BIND_HOST): string {
  const mcpUrl = `http://${host}:${MCP_HTTP_PORT}/mcp`;
  const api = `http://${host}:${API_PORT}`;
  return [
    "For an app that talks MCP over HTTP, paste this into its MCP settings:",
    JSON.stringify({ mcpServers: { monomem: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    "",
    "To test it from a terminal (Mac / Linux):",
    `  curl -H "Authorization: Bearer ${token}" ${api}/whoami`,
    "To test it in Windows PowerShell:",
    `  Invoke-RestMethod -Headers @{ Authorization = "Bearer ${token}" } ${api}/whoami`,
    "(The server must be running: monomem start)",
  ].join("\n");
}

/** What `monomem token add` prints after making a key: who it is for, the one-time key, and how to connect. */
export function addedReport(made: { token: string; app: ListedApp; ceilingWasDefault: boolean }, noLimit: boolean): string {
  const out: string[] = [`Added "${made.app.label}".`];
  if (noLimit) out.push(`\n!! WARNING: "${made.app.label}" has NO LIMIT. It can read every private note and change any note's label. Only give this key to an app you trust completely.`);
  out.push(describeAccess(made.app));
  if (made.ceilingWasDefault) out.push("(You did not choose a limit, so it can see public and internal notes only. Change it with --max public|internal|private.)");
  out.push(`\nThis is its key. It is shown ONCE and Monomem will not print it again. (${tokensPath()} keeps only a one-way hash of it; the app's own config file holds the key.)\n`);
  out.push("  " + made.token + "\n");
  out.push(connectionSnippet(made.token));
  out.push(`\nThe running server notices the change within a couple of seconds. To take access away later: monomem token remove "${made.app.label}"`);
  return out.join("\n");
}
