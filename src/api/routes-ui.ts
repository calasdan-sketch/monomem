// REST routes the dashboard alone uses: the installable-app files, the "Needs you" count, the Review list (the same items
// as `monomem review`), the Welcome screen and the Settings sheet.
//
// Two gates on top of the key:
//   - every /ui/ route needs the main (admin) key with no namespace pin and no sensitivity limit;
//   - the routes that touch this computer (connect apps, update, remove, start with the computer, backups, settings) also
//     need a LOCAL sign-in: the session /login hands out for a `monomem open` code. The code is written into the data
//     folder, so only someone on this computer can make one; an app holding the key over HTTP (a tunnel, claude.ai) cannot.
//     Anyone who can make a code can also run the same commands in a terminal, so this adds no power: it keeps the key
//     alone from reaching the machine. Keeping an agent's flag ("keep as it is") needs the stronger terminal session,
//     like `monomem review keep` needs a person.
// The computer-touching actions run the ordinary commands (setup, update, uninstall, service) as a child process, so
// their own backups, undo history and checks apply unchanged.
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBody } from "../http-common.js";
import { sendJson } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DB_PATH, PACKAGE_VERSION } from "../config.js";
import { selfCommand } from "../self.js";
import { needsYou } from "../ui/needs-you.js";
import { readUiSettings, updateUiSettings, readBackupStatus, writeBackupStatus } from "../ui/settings.js";
import { MANIFEST, ICON_SVG, ICON_192_PNG, ICON_512_PNG } from "../ui/assets.js";

// ---- local sign-in sessions -------------------------------------------------------------------------------------------
const LOCAL_TTL_MS = 8 * 3_600_000;
const localSessions = new Map<string, number>();
/** Called by POST /login for every good code (terminal or not). */
export function mintLocalSession(now = Date.now()): string {
  const s = randomBytes(24).toString("hex");
  localSessions.set(s, now + LOCAL_TTL_MS);
  if (localSessions.size > 100) localSessions.delete(localSessions.keys().next().value as string);
  return s;
}
function hasLocal(req: IncomingMessage): boolean {
  const h = req.headers["x-monomem-local"];
  const exp = typeof h === "string" ? localSessions.get(h) : undefined;
  if (exp === undefined) return false;
  if (exp > Date.now()) return true;
  localSessions.delete(h as string);
  return false;
}
function hasPerson(c: ApiCtx, req: IncomingMessage): boolean {
  const h = req.headers["x-monomem-dashboard"];
  const s = typeof h === "string" ? c.dashboardSessions.get(h) : undefined;
  return !!s && s.exp > Date.now();
}

// ---- running the ordinary commands -----------------------------------------------------------------------------------
export interface RunResult {
  code: number;
  output: string;
}
export type UiRunner = (args: string[], timeoutMs: number) => Promise<RunResult>;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const tidy = (s: string): string => s.replace(ANSI, "").split(/\r?\n/).slice(-60).join("\n").slice(-6000);
const realRunner: UiRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    const self = selfCommand(args);
    execFile(self.command, self.args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, output: tidy(`${stdout}${stderr}`) });
    });
  });
let runner: UiRunner = realRunner;
/** Tests replace the child process; nothing real runs from a test. */
export function setUiRunner(r: UiRunner | null): void {
  runner = r ?? realRunner;
}
/**
 * Start a command in the background, detached from this server, its output into `logFile`. The Update button uses it: the
 * update stops this server and starts the new version, so it cannot be a child the server waits on.
 */
export type UiStarter = (args: string[], logFile: string) => void;
const realStarter: UiStarter = (args, logFile) => {
  const self = selfCommand(args);
  const fd = openSync(logFile, "w");
  try {
    spawn(self.command, self.args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true }).unref();
  } finally {
    closeSync(fd);
  }
};
let starter: UiStarter = realStarter;
export function setUiStarter(s: UiStarter | null): void {
  starter = s ?? realStarter;
}
const updateLog = (): string => join(dirname(DB_PATH), "update.log");

// ---- the installable app (no key) -------------------------------------------------------------------------------------
const ASSETS: Record<string, { type: string; body: string | Buffer }> = {
  "/manifest.webmanifest": { type: "application/manifest+json", body: MANIFEST },
  "/icon.svg": { type: "image/svg+xml", body: ICON_SVG },
  "/icon-192.png": { type: "image/png", body: ICON_192_PNG },
  "/icon-512.png": { type: "image/png", body: ICON_512_PNG },
};
/** Before authentication, like the page itself and its favicon. */
export function uiAssetRoute(req: IncomingMessage, res: ServerResponse, path: string, anonLimited: () => boolean): boolean {
  const a = req.method === "GET" ? ASSETS[path] : undefined;
  if (!a) return false;
  if (anonLimited()) return true;
  res.writeHead(200, { "Content-Type": a.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400" });
  res.end(a.body);
  return true;
}

const APP_ID = /^[a-z-]{1,40}$/;
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse((await readBody(req)) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function uiRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store } = c;
  const { req, res, path, principal, nsCtx } = r;
  if (!path.startsWith("/ui/")) return false;
  if (principal.scope !== "admin" || principal.max_sensitivity !== undefined || nsCtx.active) {
    sendJson(res, 403, { error: "This part of the dashboard needs the main key (the one monomem open signs you in with)." });
    return true;
  }
  const local = hasLocal(req);
  const needLocal = (): boolean => {
    if (local) return false;
    sendJson(res, 403, { error: "This changes things on your computer. Open Monomem from its Start menu entry, or run  monomem open  on this computer, then try again.", local_required: true });
    return true;
  };

  // GET /ui/state -> what the page needs to choose Welcome or Notes. No secrets.
  if (req.method === "GET" && path === "/ui/state") {
    const s = readUiSettings();
    sendJson(res, 200, { version: PACKAGE_VERSION, welcome_done: s.welcome_done, settings: s, local, person: hasPerson(c, req), backup: readBackupStatus(dirname(DB_PATH)) });
    return true;
  }
  // GET /ui/needs-you -> { count, items }: held, unconfirmed, conflicts, failed backup.
  if (req.method === "GET" && path === "/ui/needs-you") {
    sendJson(res, 200, needsYou(store));
    return true;
  }
  // GET /ui/review -> the same lists as `monomem review --json`.
  if (req.method === "GET" && path === "/ui/review") {
    const ns = r.url.searchParams.get("namespace") || undefined;
    const scope = ns ? [ns] : undefined;
    const notes = store.reviewList(scope);
    const flagged = store.flaggedList(scope);
    const codeChanged = store.codeChangedList(scope);
    const held = store.listQuarantine({ ...(scope ? { namespaces: scope } : {}), limit: 500 }).length;
    sendJson(res, 200, { notes, flagged, code_changed: codeChanged, held_writes: held, count: new Set([...notes, ...flagged, ...codeChanged].map((x) => x.id)).size });
    return true;
  }
  // POST /ui/review/:id/keep -> a person keeps a flagged or code-changed note as it is (`monomem review keep <id>`).
  const keep = /^\/ui\/review\/(\d+)\/keep$/.exec(path);
  if (req.method === "POST" && keep) {
    if (!hasPerson(c, req)) {
      sendJson(res, 403, { error: "Keeping a note as it is needs a person: run  monomem open  in a terminal and press Keep there, or run  monomem review keep " + keep[1] + "." });
      return true;
    }
    const id = Number(keep[1]);
    const flags = store.keepFlagged(id);
    const files = store.refreshCodeAnchors(id);
    sendJson(res, 200, { id, flags_cleared: flags, files_checked: files });
    return true;
  }

  // ---- this computer (local sign-in) ----
  if (req.method === "PUT" && path === "/ui/settings") {
    if (needLocal()) return true;
    const b = await jsonBody(req);
    if (!b) { sendJson(res, 400, { error: "invalid JSON body" }); return true; }
    try {
      sendJson(res, 200, { settings: updateUiSettings(b) });
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
    return true;
  }
  // GET /ui/apps -> the apps setup finds on this computer, and which already use Monomem.
  if (req.method === "GET" && path === "/ui/apps") {
    if (needLocal()) return true;
    const { detectClients, connectedApps, realEnv } = await import("../setup.js");
    const e = realEnv(PACKAGE_VERSION);
    const connected = new Set(connectedApps(e).connected);
    const declined = new Set(readUiSettings().declined_apps);
    const seen = new Set<string>();
    const apps = detectClients(e)
      .filter((a) => a.present && a.id !== "project" && !seen.has(a.label) && seen.add(a.label))
      .map((a) => ({ id: a.id, label: a.label, connected: connected.has(a.label), declined: declined.has(a.id) }));
    sendJson(res, 200, { apps });
    return true;
  }
  // POST /ui/apps/connect { id } -> `monomem setup --only <id> --yes` (its backup and undo history apply).
  // POST /ui/apps/undo -> `monomem setup --undo --yes` (puts back what the last setup changed).
  if (req.method === "POST" && (path === "/ui/apps/connect" || path === "/ui/apps/undo")) {
    if (needLocal()) return true;
    let args = ["setup", "--undo", "--yes"];
    if (path === "/ui/apps/connect") {
      const b = await jsonBody(req);
      const id = b && typeof b.id === "string" ? b.id : "";
      if (!APP_ID.test(id) || id === "project") { sendJson(res, 400, { error: "Unknown app." }); return true; }
      args = ["setup", "--only", id, "--yes", "--no-test-note", "--no-doctor"];
    }
    const out = await runner(args, 120_000);
    sendJson(res, out.code === 0 ? 200 : 500, { ok: out.code === 0, ...out });
    return true;
  }
  // POST /ui/update { check } -> `monomem update --check` (answers its output), or `monomem update --restart-server <pid>`
  // started in the background (answers at once; the page reads GET /ui/update/log and waits for the new version on /health).
  // Only when the person presses the button.
  if (req.method === "POST" && path === "/ui/update") {
    if (needLocal()) return true;
    const b = (await jsonBody(req)) ?? {};
    if (b.check === true) {
      const out = await runner(["update", "--check"], 120_000);
      sendJson(res, 200, { ok: out.code === 0, ...out });
      return true;
    }
    try {
      starter(["update", "--restart-server", String(process.pid)], updateLog());
      sendJson(res, 202, { ok: true, started: true });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "The update could not start: " + (e as Error).message });
    }
    return true;
  }
  // GET /ui/update/log -> what the update started by the button printed so far; `done` is its exit code once it ended.
  if (req.method === "GET" && path === "/ui/update/log") {
    if (needLocal()) return true;
    const text = existsSync(updateLog()) ? tidy(readFileSync(updateLog(), "utf8")) : "";
    const end = /\(update ended with exit code (\d+)\)/.exec(text);
    sendJson(res, 200, { output: text, done: end ? Number(end[1]) : null });
    return true;
  }
  // POST /ui/remove -> `monomem uninstall --yes`: takes Monomem out of every app; the notes stay (never --purge from here).
  if (req.method === "POST" && path === "/ui/remove") {
    if (needLocal()) return true;
    const out = await runner(["uninstall", "--yes"], 120_000);
    sendJson(res, 200, { ok: out.code === 0, ...out });
    return true;
  }
  // POST /ui/service { on } -> start with the computer: `monomem service install` / `service uninstall`.
  if (req.method === "POST" && path === "/ui/service") {
    if (needLocal()) return true;
    const b = await jsonBody(req);
    if (!b || typeof b.on !== "boolean") { sendJson(res, 400, { error: "on must be true or false" }); return true; }
    const out = await runner(["service", b.on ? "install" : "uninstall"], 60_000);
    sendJson(res, 200, { ok: out.code === 0, ...out });
    return true;
  }
  // GET /ui/sync -> whether `monomem sync setup` was run here, how, and whether it runs by itself. Never the key file, and an
  // address is shown without any password inside it.
  if (req.method === "GET" && path === "/ui/sync") {
    if (needLocal()) return true;
    const { readSyncConfig } = await import("../sync/device.js");
    const { scrubUrls } = await import("../sync-git.js");
    const cfg = readSyncConfig(dirname(DB_PATH));
    sendJson(res, 200, cfg ? { set: true, kind: cfg.kind, where: scrubUrls(cfg.target), auto: cfg.auto, every_minutes: cfg.everyMinutes } : { set: false });
    return true;
  }
  // POST /ui/sync/setup { target, name? } -> `monomem sync setup <target> [--name <name>]` (its own checks apply: an address
  // with a password inside is refused, the key never goes into the folder). One line each; never starts with "-".
  if (req.method === "POST" && path === "/ui/sync/setup") {
    if (needLocal()) return true;
    const b = await jsonBody(req);
    const target = b && typeof b.target === "string" ? b.target.trim() : "";
    const name = b && typeof b.name === "string" ? b.name.trim() : "";
    const plain = (s: string, max: number): boolean => s.length <= max && !s.startsWith("-") && !/[\x00-\x1f\x7f]/.test(s);
    if (!target || !plain(target, 1000) || !plain(name, 40)) {
      sendJson(res, 400, { error: "Give a shared folder (such as your OneDrive folder) or a private git address, on one line." });
      return true;
    }
    const out = await runner(["sync", "setup", target, ...(name ? ["--name", name] : [])], 600_000);
    sendJson(res, 200, { ok: out.code === 0, ...out });
    return true;
  }
  // POST /ui/backup -> a copy of the database now, in <data dir>/backups/<time>; the result is recorded for "Needs you".
  if (req.method === "POST" && path === "/ui/backup") {
    if (needLocal()) return true;
    const at = new Date().toISOString();
    const dir = join(dirname(DB_PATH), "backups", at.replace(/[:.]/g, "-"));
    try {
      const { backupStore, backupStoreOffThread } = await import("../backup.js");
      // The server's database file is copied on a worker thread (serving does not pause); a store with no file (tests) directly.
      const b = existsSync(DB_PATH) ? await backupStoreOffThread(DB_PATH, dir) : backupStore(store, DB_PATH, dir);
      writeBackupStatus({ ok: true, at, dir }, dirname(DB_PATH));
      sendJson(res, 200, { ok: true, at, dir, notes: b.notes, key_left_out: b.keyLeftOut });
    } catch (e) {
      writeBackupStatus({ ok: false, at, error: (e as Error).message }, dirname(DB_PATH));
      sendJson(res, 500, { ok: false, error: "The backup failed: " + (e as Error).message });
    }
    return true;
  }
  sendJson(res, 404, { error: "no such route" });
  return true;
}
