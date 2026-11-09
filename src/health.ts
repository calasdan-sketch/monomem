// `monomem health`: one pass over the checks Monomem already has (doctor essentials, security settings, the poisoning
// drill, the audit chain, held writes, distrust rules, redaction markers, the meter) and one grade with a rule anyone can
// re-compute from the lines. The store is opened to count things (opening an older database file upgrades its schema once)
// and drill works on a copy. The only thing health writes is one small row noting how long the audit log was.
import { createHash } from "node:crypto";
import { accessSync, constants as fsc, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BIND_HOST, DATA_DIR, DB_PATH } from "./config.js";
import { runDrill, DRILL_SCOPE, type DrillReport } from "./drill.js";
import { meterStats } from "./meter.js";
import { cardBrand, cardFooter, esc, svgLines } from "./receipts.js";
import { auditFailureCount, auditPath as defaultAuditPath, printable, verifyAuditChain } from "./security.js";
import { Store } from "./store.js";
import { embeddingsConfig } from "./embeddings.js";
import { acceptLegacyHeartbeats } from "./liveness.js";
import { scanPii } from "./pii.js";

/** info: a fact worth showing that never lowers the grade. */
export type Status = "ok" | "warn" | "fail" | "info";
export interface HealthCheck {
  id: string;
  /** Short name, used on the card. */
  label: string;
  status: Status;
  /** One line: what was found and what it means. */
  text: string;
}
export interface HealthReport {
  grade: string;
  rule: string;
  checks: HealthCheck[];
  not_covered: string;
  date: string;
  exit_code: 0 | 1;
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];
export const GRADE_RULE =
  "Start at A. Each warn lowers it one step (A to F). Any fail caps it at D. Unexpected drill reach (an attack other than the two known misses got through) is F. Info lines never change the grade. A to C exits 0, D to F exits 1.";
export const NOT_COVERED = "Not covered: the injection check is a pattern linter; reworded attacks and self-poisoning still get through. " + DRILL_SCOPE;

/** The grade, computed only from the check statuses (the drill check failing is the F case). */
export function gradeOf(checks: Pick<HealthCheck, "id" | "status">[]): string {
  if (checks.some((c) => c.id === "drill" && c.status === "fail")) return "F";
  let i = checks.filter((c) => c.status === "warn").length;
  if (checks.some((c) => c.status === "fail")) i = Math.max(i, 3);
  return LETTERS[Math.min(i, LETTERS.length - 1)];
}

export interface SecurityFinding {
  id: string;
  /** Short name for the card and the reason line. */
  label: string;
  /** info: shown, never lowers the grade (a proxy setting on a loopback bind). */
  status: "warn" | "fail" | "info";
  /** One line for `monomem health`. */
  short: string;
  /** The longer wording `monomem doctor` prints. */
  detail: string;
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
const CLOUD_SYNC = /(?:^|[\\/])(?:OneDrive[^\\/]*|Dropbox[^\\/]*|iCloud Drive[^\\/]*|iCloudDrive|Google Drive[^\\/]*|GoogleDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/i;

/** The settings that weaken protection: the one list `monomem doctor` and `monomem health` both use. Each finding counts separately. */
export async function securityFindings(dataDir: string, bindHost: string): Promise<SecurityFinding[]> {
  const { lintPolicy, lintPolicyUnrecognised, lintDidYouMean } = await import("./lint.js");
  const out: SecurityFinding[] = [];
  const p = lintPolicy();
  const policy = `secrets: ${p.secret}, injection: ${p.injection}`;
  const lintDetail = `MONOMEM_LINT="${process.env.MONOMEM_LINT}" stores notes the memory linter would otherwise hold or refuse (${policy}). Remove it unless you chose this.`;
  if (p.secret === "warn" && p.injection === "warn") {
    out.push({ id: "lint", label: "linter off", status: "fail", short: `MONOMEM_LINT is warn-only, so the memory linter holds and refuses nothing (${policy})`, detail: lintDetail });
  } else if (p.secret === "warn" || p.injection === "warn") {
    out.push({ id: "lint", label: "linter weakened", status: "warn", short: `MONOMEM_LINT weakens the memory linter (${policy})`, detail: lintDetail });
  }
  if (process.env.MONOMEM_STDIO_ADMIN_TOOLS === "1") {
    out.push({ id: "admin", label: "stdio admin tools", status: "fail", short: "MONOMEM_STDIO_ADMIN_TOOLS=1 lets an agent approve its own held writes", detail: "MONOMEM_STDIO_ADMIN_TOOLS=1 lets an agent on the stdio server use the admin tools (approve its own quarantined writes, unpin, delete). Unset it unless you want that." });
  }
  if (!LOOPBACK.includes(bindHost)) {
    out.push({ id: "bind", label: "non-loopback bind", status: "warn", short: `MONOMEM_BIND=${bindHost} is not loopback`, detail: `MONOMEM_BIND=${bindHost} is not a loopback address: anything that can reach this machine on the network can reach the API, so it must be behind your own authenticated tunnel (INFRA.md).` });
  }
  if (CLOUD_SYNC.test(dataDir)) {
    out.push({ id: "sync", label: "cloud-sync folder", status: "warn", short: "data folder is inside a cloud-sync folder", detail: `data dir ${dataDir} is inside a cloud-sync folder (OneDrive, Dropbox, iCloud or Google Drive): the sync client uploads the database and token, and can corrupt a live SQLite file. See SECURITY.md; set MONOMEM_HOME to a local folder.` });
  }
  // Settings that move or loosen trust without being a hole on their own; each is one line, none changes data.
  const embed = embeddingsConfig();
  if (embed.enabled) {
    let host = "";
    try {
      host = new URL(embed.url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      /* unreadable URL: embedding calls fail, nothing is sent */
    }
    if (host && !LOOPBACK.includes(host) && !/^127(\.\d{1,3}){3}$/.test(host)) {
      out.push({ id: "embed-remote", label: "remote embeddings", status: "warn", short: `MONOMEM_EMBED_URL sends note text to ${host}, not this machine`, detail: `MONOMEM_EMBED_URL points at ${host}: with embeddings on, the text of every note and search leaves this machine for that host. Use a local endpoint (the default is Ollama on localhost) unless you chose this.` });
    }
  }
  const origins = (process.env.MONOMEM_ALLOWED_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (origins.length) {
    out.push({ id: "origins", label: "browser origins allowed", status: "warn", short: `MONOMEM_ALLOWED_ORIGINS lets ${origins.length} browser origin${origins.length === 1 ? "" : "s"} call the API`, detail: `MONOMEM_ALLOWED_ORIGINS lets web pages from ${origins.join(", ")} call this server from a browser. Each one can use anything a token of yours can. Remove origins you do not run.` });
  }
  if (process.platform !== "win32" && process.env.MONOMEM_NO_CHMOD === "1") {
    out.push({ id: "no-chmod", label: "file permissions not tightened", status: "warn", short: "MONOMEM_NO_CHMOD=1 leaves the data folder and database readable by other users", detail: "MONOMEM_NO_CHMOD=1 stops Monomem from making the data folder, database, token and audit files private (owner only). Other accounts on this computer may read your notes. Remove it unless the folder is shared on purpose." });
  }
  const proxies = [process.env.MONOMEM_TRUST_PROXY === "1" ? "MONOMEM_TRUST_PROXY" : "", process.env.MONOMEM_TRUST_CLOUDFLARE === "1" ? "MONOMEM_TRUST_CLOUDFLARE" : ""].filter(Boolean);
  if (proxies.length) {
    const loop = LOOPBACK.includes(bindHost);
    out.push({
      id: "trust-proxy",
      label: "forwarded IP trusted",
      status: loop ? "info" : "warn",
      short: loop ? `${proxies.join(" and ")} set: the client address comes from a forwarded header (fine behind your own proxy on a loopback bind)` : `${proxies.join(" and ")} set on a non-loopback bind: anyone who can reach the port directly can forge the client address and dodge rate limits`,
      detail: `${proxies.join(" and ")} makes Monomem believe the forwarded client address header. ${loop ? "The bind is loopback, so only a proxy on this computer can reach it: fine if that proxy sets the header." : "The bind is not loopback: a client that skips the proxy can set the header itself and get a fresh rate-limit bucket each time. Bind to loopback behind the proxy, or remove it."}`,
    });
  }
  if (acceptLegacyHeartbeats()) {
    out.push({ id: "runner-legacy", label: "legacy runner heartbeats", status: "warn", short: "MONOMEM_RUNNER_ACCEPT_LEGACY accepts runner heartbeats with no writer marker", detail: "MONOMEM_RUNNER_ACCEPT_LEGACY lets a runner heartbeat with no server-stamped writer count as alive, so any writer that can post a note can fake a healthy runner. Upgrade the runner (OneMemory 1.3.4 or later) and remove it." });
  }
  if (lintPolicyUnrecognised()) {
    out.push({ id: "lint-typo", label: "MONOMEM_LINT not understood", status: "warn", short: `MONOMEM_LINT="${printable(process.env.MONOMEM_LINT ?? "", 40)}" is not recognised, using the default for it (secrets=${p.secret}, injection=${p.injection})`, detail: `MONOMEM_LINT="${printable(process.env.MONOMEM_LINT ?? "", 80)}" is not recognised (or only partly), so the safe default applies to the parts that were not understood. Check the spelling: values are block, quarantine, warn, or secrets=/injection=/entropy=/pii=/directive= each set to one of those.${lintDidYouMean(process.env.MONOMEM_LINT ?? "")}` });
  }
  return out;
}

function hookWired(settingsPath: string): boolean {
  try {
    const entries = (JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: { SessionStart?: unknown } }).hooks?.SessionStart;
    return Array.isArray(entries) && /(monomem|onememory|cli\.js)[\s\S]{0,60}\b(recall|hook session-start)\b/.test(JSON.stringify(entries));
  } catch {
    return false;
  }
}

/** The Claude Code plugin is installed (installed_plugins.json has a monomem@<marketplace> key) and not switched off in settings.json. */
function pluginInstalled(pluginsPath: string, settingsPath: string): boolean {
  try {
    const keys = Object.keys((JSON.parse(readFileSync(pluginsPath, "utf8")) as { plugins?: Record<string, unknown> }).plugins ?? {}).filter((k) => k.startsWith("monomem@"));
    let enabled: Record<string, unknown> = {};
    try {
      enabled = (JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {};
    } catch {
      /* no readable settings.json: a plugin counts as enabled */
    }
    return keys.some((k) => enabled[k] !== false);
  } catch {
    return false;
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const sha = (line: string): string => createHash("sha256").update(line).digest("hex");
const SEEN_KEY = "health_audit_seen";
type Db = ReturnType<Store["captureDb"]>;
type Result = Pick<HealthCheck, "status" | "text">;

/** Every audit line, oldest file first (the order verifyAuditChain reads them). */
function auditLines(path: string): string[] {
  const files: string[] = [];
  for (let i = 1; existsSync(`${path}.${i}`); i++) files.unshift(`${path}.${i}`);
  if (existsSync(path)) files.push(path);
  return files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean));
}

/**
 * Audit-log check. Remembers (in _meta) how many lines the log had and the hash of the last one, and warns when a later run
 * finds fewer lines or a different line in that place. It cannot see tampering that happened before its first run.
 */
function auditCheck(path: string | undefined, db: Db | undefined, notes: number): Result {
  const a = verifyAuditChain(path);
  if (a.breaks > 0) return { status: "fail", text: `${plural(a.breaks, "break")} (first at line ${a.brokenLine}): a log line was edited or removed` };
  let seen: { lines: number; hash: string } | undefined;
  try {
    const row = db?.prepare("SELECT value FROM _meta WHERE key = ?").get(SEEN_KEY) as { value: string } | undefined;
    seen = row ? (JSON.parse(row.value) as { lines: number; hash: string }) : undefined;
  } catch {
    /* unreadable note: treat as none */
  }
  if (a.lines === 0) {
    if (notes > 0 || seen) return { status: "warn", text: `audit log missing: it may have been deleted (${plural(notes, "note")} in the store${seen ? `; it had ${plural(seen.lines, "line")} at the last health check` : ""})` };
    return { status: "ok", text: "no audit log yet" };
  }
  const lines = auditLines(path ?? defaultAuditPath());
  if (seen && lines.length < seen.lines) return { status: "warn", text: `the log has ${plural(lines.length, "line")}, fewer than the ${seen.lines} it had at the last health check: lines were removed (rotation can also drop old lines)` };
  if (seen && sha(lines[seen.lines - 1]) !== seen.hash) return { status: "warn", text: `line ${seen.lines} is not the line health saw there last time: the log was edited or replaced (health only notices changes since its last run)` };
  try {
    db?.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(SEEN_KEY, JSON.stringify({ lines: lines.length, hash: sha(lines[lines.length - 1]) }));
  } catch {
    /* read-only database: skip the note */
  }
  return { status: "ok", text: `${plural(a.lines, "line")}, no breaks, ${plural(a.forks, "fork")} (forks are concurrent writers, not tampering)` };
}

export interface HealthOpts {
  dbPath?: string;
  dataDir?: string;
  bindHost?: string;
  settingsPath?: string;
  /** Claude Code's installed_plugins.json (to find a plugin install of the hook). */
  pluginsPath?: string;
  auditPath?: string;
  now?: Date;
  drill?: typeof runDrill;
}

export async function runHealth(o: HealthOpts = {}): Promise<HealthReport> {
  const dbPath = o.dbPath ?? process.env.MONOMEM_DB_PATH ?? DB_PATH;
  const checks: HealthCheck[] = [];
  const add = (id: string, label: string, status: Status, text: string): void => void checks.push({ id, label, status, text });

  const { nodeIsOk, MIN_NODE_TEXT, sqliteHasFts5, HOOKS_DECLINED_FILE } = await import("./setup.js");
  const nodeOk = nodeIsOk(process.versions.node) && sqliteHasFts5();
  add("node", "Node", nodeOk ? "ok" : "fail", nodeOk ? `Node ${process.versions.node} with SQLite FTS5` : `Node ${process.versions.node} needs >= ${MIN_NODE_TEXT} with SQLite FTS5, or search fails`);

  let notes = 0, held = 0, distrust = 0, marked = 0, dbOk = false;
  let meterText = "meter unavailable";
  let piiNotes = 0, privateNotes = 0, labelledNotes = 0;
  let audit: Result | undefined;
  if (existsSync(dbPath)) {
    try {
      const s = new Store(dbPath);
      try {
        notes = s.countAll();
        held = s.listQuarantine({ limit: 500 }).length;
        distrust = s.distrustRules().length;
        // ponytail: loads every live note to count markers; use SQL if a store gets big enough for this to show up in the runtime
        const live = s.exportAll({ live: true }); // gate-ok: operator CLI, counts redaction markers only; no note content is returned or printed
        marked = live.filter((n) => /\[REDACTED:/.test(`${n.title}\n${n.body}`)).length;
        piiNotes = scanPii(live, 200).suggestions.length;
        privateNotes = live.filter((n) => n.sensitivity === "private").length;
        labelledNotes = live.filter((n) => n.sensitivity !== undefined).length;
        const m = meterStats(s);
        meterText = `${plural(notes, "note")}, database ${(m.db_bytes / 1048576).toFixed(1)} MB; the meter counts ~${m.totals.saved_tokens} tokens saved over ${plural(m.totals.sessions, "session")} (estimate, ~4 characters a token)`;
        try {
          audit = auditCheck(o.auditPath, s.captureDb(), notes);
        } catch (e) {
          audit = { status: "warn", text: `could not read the audit log: ${(e as Error).message}` };
        }
        dbOk = true;
      } finally {
        s.close();
      }
    } catch (e) {
      add("database", "Database", "fail", `cannot open ${dbPath}: ${(e as Error).message}`);
    }
  } else add("database", "Database", "info", `no database yet at ${dbPath}: nothing is stored, and it is created on first use (monomem setup)`);
  if (dbOk) add("database", "Database", "ok", `database opens (${plural(notes, "note")})`);

  const settingsPath = o.settingsPath ?? join(homedir(), ".claude", "settings.json");
  if (hookWired(settingsPath)) add("hooks", "Hooks", "ok", "SessionStart hook wired in ~/.claude/settings.json");
  else if (pluginInstalled(o.pluginsPath ?? join(homedir(), ".claude", "plugins", "installed_plugins.json"), settingsPath)) add("hooks", "Hooks", "ok", "the monomem Claude Code plugin is installed (its SessionStart hook comes with it)");
  else if (!existsSync(dirname(settingsPath))) add("hooks", "Hooks", "info", "Claude Code does not seem to be installed here (no ~/.claude folder), so there is no Claude Code hook to check");
  else if (existsSync(join(o.dataDir ?? DATA_DIR, HOOKS_DECLINED_FILE))) add("hooks", "Hooks", "info", "you chose no Claude Code hook when you ran setup, so Claude Code gets no memory at session start (run monomem setup --hook to add it)");
  else add("hooks", "Hooks", "info", "optional: no monomem SessionStart hook in ~/.claude/settings.json and no monomem plugin in Claude Code's plugin list, so Claude Code does not get your notes at session start (add it with monomem setup --hook)");

  const sec = await securityFindings(o.dataDir ?? DATA_DIR, o.bindHost ?? BIND_HOST);
  if (sec.length) for (const f of sec) add(`security:${f.id}`, f.label, f.status, `${f.short} (monomem doctor has the detail)`);
  else add("security", "Security settings", "ok", "no weakening settings found (lint, stdio admin tools, bind address, cloud-sync folder, remote embeddings, browser origins, file permissions, proxy trust, legacy runners)");

  if (dbOk) {
    try {
      const d: DrillReport = await (o.drill ?? runDrill)({ dbPath });
      const known = d.reached.length - d.unexpected.length;
      add("drill", "Drill", d.ok ? "ok" : "fail", d.ok ? (d.reached.length ? `${d.reached.length} of ${d.attacks} known attacks reached the agent, all known misses (${known})` : `none of ${d.attacks} known attacks reached the agent`) + (d.approve_first ? " (approve-first is on: held writes wait for your review; approving one unread lets it in)" : "") : `${d.unexpected.length} unexpected of ${d.attacks} attacks reached the agent: ${d.unexpected.map((x) => x.id).join(", ")} (monomem drill has the detail)`);
    } catch (e) {
      add("drill", "Drill", "warn", `could not run: ${(e as Error).message}`);
    }
  } else add("drill", "Drill", "info", "not run: there is no database to replay the attacks against yet");

  if (dbOk) {
    // Exposure: reasons the notes are more reachable than the labels suggest. One check, so it costs at most one grade step however many reasons it lists.
    const reasons: string[] = [];
    try {
      const { resolveTokens } = await import("./config.js");
      const open = resolveTokens().filter((t) => t.label !== "primary" && t.max_sensitivity === undefined && t.scope !== "admin");
      if (open.length && labelledNotes > 0) reasons.push(`${plural(open.length, "app key")} with no limit can read your private notes (${open.map((t) => `"${t.label || "unnamed"}"`).slice(0, 3).join(", ")}; monomem token add <name> --max internal)`);
    } catch {
      /* tokens unreadable: the other checks say so */
    }
    if (piiNotes > 0) reasons.push(`${plural(piiNotes, "note")} may hold personal data and ${piiNotes === 1 ? "is" : "are"} not labelled private (monomem pii scan)`);
    if (privateNotes > 0) {
      try {
        const { detectClients, realEnv } = await import("./setup.js");
        const { PACKAGE_VERSION } = await import("./config.js");
        const { fileURLToPath } = await import("node:url");
        const wired = detectClients(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url))).filter((c) => {
          try {
            return c.exists && /"monomem"|\[mcp_servers\.monomem\]/.test(readFileSync(c.file, "utf8")) && !/Authorization/i.test(readFileSync(c.file, "utf8"));
          } catch {
            return false;
          }
        });
        if (wired.length) reasons.push(`${wired.map((c) => c.label).join(", ")} connect${wired.length === 1 ? "s" : ""} without a key, so a limit does not apply to ${wired.length === 1 ? "it" : "them"} (monomem connect <app> --max internal)`);
      } catch {
        /* client config unreadable: skip */
      }
    }
    add("exposure", "Exposure", reasons.length ? "warn" : "ok", reasons.length ? reasons.join("; ") + " (counts as one warning)" : "no unlimited app keys, unlabelled personal data or keyless apps found");
  }

  if (audit) add("audit", "Audit chain", audit.status, audit.text);
  else {
    try {
      const a = verifyAuditChain(o.auditPath);
      add("audit", "Audit chain", a.breaks > 0 ? "fail" : "info", a.breaks > 0 ? `${plural(a.breaks, "break")} (first at line ${a.brokenLine}): a log line was edited or removed` : a.lines === 0 ? "no audit log yet" : `${plural(a.lines, "line")}, no breaks (no database, so the log length was not recorded)`);
    } catch (e) {
      add("audit", "Audit chain", "warn", `could not read the audit log: ${(e as Error).message}`);
    }
  }

  // Audit writes never fail a request, so a log that cannot be written is otherwise silent. This checks it can be written
  // now, and counts this process's failed entries (a running server reports its own count in GET /stats audit_failures).
  {
    const p = o.auditPath ?? defaultAuditPath();
    let writable = true;
    try {
      accessSync(existsSync(p) ? p : dirname(p), fsc.W_OK);
    } catch {
      writable = existsSync(p) || existsSync(dirname(p)) ? false : true; // a folder that does not exist yet is made on the first write
    }
    const failed = auditFailureCount();
    if (!writable || failed > 0) add("audit-write", "Audit writes", "warn", `${!writable ? `the audit log ${p} cannot be written, so operations go unrecorded` : ""}${!writable && failed ? "; " : ""}${failed ? `${failed} audit entr${failed === 1 ? "y" : "ies"} could not be written by this process` : ""}`);
  }

  if (dbOk) {
    add("held", "Held writes", "info", held ? `${held >= 500 ? "500 or more writes" : plural(held, "write")} held for review: the defence working, nothing was stored without you (monomem quarantine list)` : "no writes waiting for review");
    add("distrust", "Distrusted writers", "info", `${plural(distrust, "distrust rule")}${distrust ? " (their notes are hidden from agents)" : ""}`);
    add("redacted", "Redacted notes", "info", `notes with a [REDACTED:...] marker (secret redaction replaced a credential): ${marked}`);
    add("memory", "Memory size", "ok", meterText);
  }

  const grade = gradeOf(checks);
  return { grade, rule: GRADE_RULE, checks, not_covered: NOT_COVERED, date: (o.now ?? new Date()).toISOString().slice(0, 10), exit_code: grade <= "C" ? 0 : 1 };
}

const TAG: Record<Status, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]", info: "[info]" };

/** "C: 2 warnings (hooks, linter weakened)": why the grade is what it is. */
export function gradeReason(r: HealthReport): string {
  const bad = r.checks.filter((c) => c.status === "warn" || c.status === "fail");
  if (!bad.length) return `${r.grade}: no warnings`;
  const fails = bad.filter((c) => c.status === "fail").length;
  const count = fails ? `${plural(fails, "fail")}, ${plural(bad.length - fails, "warning")}` : plural(bad.length, "warning");
  return `${r.grade}: ${count} (${bad.map((c) => c.label.toLowerCase()).join(", ")})`;
}

export function renderHealth(r: HealthReport): string {
  return [
    "monomem health\n",
    ...r.checks.map((c) => `  ${TAG[c.status]} ${c.label}: ${c.text}`),
    "",
    `Grade ${r.grade}`,
    gradeReason(r),
    `Rule: ${r.rule}`,
    r.not_covered,
  ].join("\n");
}

/** A 640x360 SVG in the meter card's colours; red for a fail and for grades D to F. Every text goes through esc(). */
export function renderHealthCard(r: HealthReport): string {
  const colour: Record<Status, string> = { ok: "#FFFFFF", info: "#FFFFFF", warn: "#F0C171", fail: "#FF6B5B" };
  const gradeColour = r.grade > "C" ? "#FF6B5B" : "#F0C171";
  const step = Math.min(20, 170 / Math.max(1, r.checks.length));
  const rows = r.checks
    .map((c, i) => `<text x="190" y="${Math.round(100 + i * step)}" font-size="14" fill="${colour[c.status]}">${esc(`${c.label}: ${c.status}`)}</text>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
    `<rect width="640" height="360" rx="18" fill="#0B2E45"/>` +
    cardBrand("health") +
    `<text x="600" y="56" font-size="13" font-weight="600" text-anchor="end" fill="#F0C171">${esc(r.date)}</text>` +
    `<text x="40" y="210" font-size="150" font-weight="700" fill="${gradeColour}">${esc(r.grade)}</text>` +
    rows +
    svgLines(gradeReason(r), 40, 264, 70, `font-size="14" font-weight="600" fill="${gradeColour}"`) +
    svgLines(r.not_covered, 40, 296, 88, `font-size="12" fill="#9FB3C4"`, 16) +
    cardFooter() +
    `</svg>\n`
  );
}

export const HEALTH_USAGE = `monomem health [--json] [--card [file.svg]]

  One line per check (setup, hook, each weakening security setting, drill, audit chain, held writes, distrusted writers,
  redacted notes, memory size), then a grade and the reason for it.
  Health opens your store to count things (an older database file is upgraded once, as with any monomem command), and
  drill runs on a copy. It writes one small row noting how long the audit log was, so the next run can see lines removed.

  Grade rule: ${GRADE_RULE}
  ${NOT_COVERED}
  --card writes a shareable SVG (default: monomem-health.svg in your Monomem data folder; the path is printed).`;

export async function healthMain(argv: string[], out: (s: string) => void = console.log, opts: HealthOpts = {}): Promise<number> {
  let json = false;
  let card: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return out(HEALTH_USAGE), 0;
    if (a === "--json") json = true;
    else if (a === "--card") card = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : join(opts.dataDir ?? DATA_DIR, "monomem-health.svg");
    else return console.error(`health: unknown option ${a} (try: monomem health --help)`), 2;
  }
  const r = await runHealth(opts);
  if (card) {
    if (!isAbsolute(card)) card = join(process.cwd(), card);
    mkdirSync(dirname(card), { recursive: true });
    writeFileSync(card, renderHealthCard(r));
  }
  out(json ? JSON.stringify({ ...r, reason: gradeReason(r), ...(card ? { card } : {}) }, null, 2) : renderHealth(r) + (card ? `\nwrote ${card}` : ""));
  return r.exit_code;
}
