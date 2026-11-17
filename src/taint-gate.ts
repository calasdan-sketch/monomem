// `monomem hook taint-gate`: Claude Code's PreToolUse hook (opt-in: `monomem setup --taint-gate`). Once this session has read
// outside content (a web page, another MCP server: sessions.outside_at, written by the capture hooks), it ASKS the person before
// a short list of high-impact actions:
//   - git push; npm / pnpm / yarn publish
//   - curl, wget, Invoke-WebRequest / Invoke-RestMethod, fetch( ... ) or WebFetch to a host that is not on the known-hosts list
//   - reading or writing .env, ~/.ssh and other credential files (Read, Grep, Write, Edit, or named in a shell command)
//   - writing AGENTS.md / CLAUDE.md, Claude Code's settings files or Monomem's known-hosts list
// It never denies and never allows: the answer is "ask" or nothing, and the person decides in Claude Code's own prompt.
//
// A SPEED BUMP, NOT A SANDBOX. It matches the command text, so an alias, a script file, base64 or a tool it does not list goes
// by unseen; it sees outside reads only through Monomem's capture hooks (a shell curl is not one, and the PostToolUse capture
// runs in the background, so an action in the very next instant can come before the read is recorded); hosts without
// PreToolUse hooks are not covered. Fails open like every hook: any problem prints nothing.
//
// Hook latency: the action is classified first from the payload alone; the database is opened (read-only, short lock wait)
// only for an action on the list. No store, no MCP SDK.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isKnownHost, knownHosts, normHost, urlHost } from "./known-hosts.js";
import { isOutsideTool } from "./taint.js";

/** The tools the gate's PreToolUse entry matches (Claude Code exact-list matcher). */
export const GATE_MATCHER = "Bash|PowerShell|Read|Grep|Write|Edit|MultiEdit|NotebookEdit|WebFetch";
const BUSY_MS = 150;

// Credential files, matched in a path or anywhere in a command (the leading class stops `process.env` from counting).
const SECRET =
  /(?:^|[\s'"=:/\\(<>])(?:\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-][\w.-]*)?|\.ssh(?=[\s'"/\\;|&)]|$)|\.gnupg|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.aws[/\\]credentials|\.docker[/\\]config\.json|\.kube[/\\]config|id_(?:rsa|ed25519|ecdsa|dsa)|credentials\.json)(?=$|[\s'";|&)<>/\\])/i;
// Files whose text an agent follows as instructions or that switch this gate off: asked about on WRITE only.
const STEERING = /(?:^|[/\\])(?:(?:AGENTS|CLAUDE|CLAUDE\.local)\.md|\.claude[/\\]settings(?:\.local)?\.json|known-hosts\.json)$/i;
const STEERING_IN_SHELL = /(?:>>?|\btee\b(?:\s+-a)?|\bsed\s+-i\S*|\bSet-Content|\bAdd-Content|\bOut-File)\s*['"]?[^\s;|&'"]*(?:AGENTS\.md|CLAUDE(?:\.local)?\.md|settings(?:\.local)?\.json|known-hosts\.json)/i;
const GIT_PUSH = /\bgit(?:\.exe)?(?:\s+-{1,2}[\w-]+(?:[=\s]+(?!push\b)[^\s-]\S*)?)*\s+push\b/i;
const PUBLISH = /\b(?:npm|pnpm|yarn)(?:\.cmd)?\b[^;&|\n]*?\spublish\b/i;
const NET = /(?:^|[\s;&|(`"'])(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?:\.exe)?(?=\s|$)|\bfetch\s*\(/i;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`)]+/gi;
// curl/wget flags whose next word is a value, not the destination.
const VALUE_FLAGS = new Set(["-o", "-O", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-X", "--request", "-w", "--write-out", "-T", "--upload-file", "-F", "--form", "-b", "--cookie", "-c", "--cookie-jar", "-P", "--directory-prefix", "--output-document", "-OutFile", "-Method", "-Headers", "-Body"]);

/** A name safe to print in the prompt (paths and tool names come from the payload). */
const shown = (s: string): string => s.replace(/[^\w.@/:+-]/g, "?").slice(0, 80);

/** The destinations a shell command names: every URL's host, else (curl/wget/iwr) its bare host-like words. */
export function commandHosts(cmd: string): string[] {
  const hosts = (cmd.match(URL_RE) ?? []).map(urlHost);
  if (hosts.length) return hosts; // "" stays in: a URL whose host cannot be read is an unknown destination
  const words = cmd.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^['"]|['"]$/g, "");
    if (VALUE_FLAGS.has(words[i - 1] ?? "") || w.startsWith("-")) continue;
    const m = /^((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]|$)/i.exec(w);
    if (m && !/\.(?:txt|json|html?|zip|tar|gz|tgz|sh|ps1|js|ts|md|csv|xml|log|exe)$/i.test(m[1])) out.push(normHost(m[1]));
  }
  return out;
}

/**
 * What a tool call would do that the gate asks about, in a few plain words, or "" when it is not on the list. Pure: the
 * payload and the known-hosts list only. `hosts` is read lazily (only a network action needs it).
 */
export function gatedAction(payload: Record<string, unknown>, hosts: () => readonly string[]): string {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? (payload.tool_input as Record<string, unknown>) : {};
  const s = (k: string): string => (typeof input[k] === "string" ? (input[k] as string).slice(0, 20000) : "");
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = s("command");
    if (GIT_PUSH.test(cmd)) return "push code (git push)";
    if (PUBLISH.test(cmd)) return "publish a package";
    if (NET.test(cmd)) {
      const list = hosts();
      const dests = commandHosts(cmd);
      const unknown = dests.filter((h) => !h || !isKnownHost(h, list));
      if (!dests.length) return "send a web request to an address it cannot read from the command";
      if (unknown.length) return `send a web request to ${[...new Set(unknown.map((h) => h || "an unreadable address"))].slice(0, 3).join(", ")} (not on your known-hosts list)`;
    }
    if (SECRET.test(cmd)) return "touch a credential file (.env, .ssh or similar) from the shell";
    if (STEERING_IN_SHELL.test(cmd)) return "change an instruction or settings file (AGENTS.md, CLAUDE.md, settings.json or known-hosts.json) from the shell";
    return "";
  }
  if (tool === "WebFetch") {
    const h = urlHost(s("url"));
    return h && isKnownHost(h, hosts()) ? "" : `fetch ${h ? shown(h) : "an address it cannot read"} (not on your known-hosts list)`;
  }
  const path = (s("file_path") || s("notebook_path") || s("path")).replace(/\\/g, "/");
  if (!path) return "";
  const name = shown(basename(path));
  const write = tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit";
  if (SECRET.test(" " + path)) return `${write ? "write" : "read"} a credential file (${name})`;
  if (write && STEERING.test(path)) return `change ${name}, which agents read as instructions or settings`;
  return "";
}

/** The outside tools this session used within the taint window, or null when its window is not open. */
async function sessionOutside(dbPath: string, sessionId: string, hours: number, env: NodeJS.ProcessEnv): Promise<{ tools: string[]; minutes: number } | null> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const row = db.prepare("SELECT outside_at FROM sessions WHERE id = ?").get(sessionId) as { outside_at: string | null } | undefined;
    if (!row?.outside_at || row.outside_at < cutoff) return null;
    const tools = (db.prepare("SELECT DISTINCT tool FROM capture_events WHERE session_id = ? AND event IN ('post-tool', 'post-tool-failure') AND at >= ?").all(sessionId, cutoff) as Array<{ tool: string }>)
      .map((r) => r.tool)
      .filter((t) => isOutsideTool(t, env))
      .map((t) => (/^[\w.-]{1,80}$/.test(t) ? t : "other"));
    return { tools: [...new Set(tools)].sort().slice(0, 3), minutes: Math.max(0, Math.round((Date.now() - Date.parse(row.outside_at)) / 60_000)) };
  } finally {
    db.close();
  }
}

export interface GateOptions {
  dbPath?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** The hook's stdout: one PreToolUse "ask" object, or "" (no opinion). Never throws. */
export async function taintGateHook(payload: Record<string, unknown>, opts: GateOptions = {}): Promise<string> {
  try {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id.slice(0, 200) : "";
    if (!sessionId) return "";
    const env = opts.env ?? process.env;
    // An empty list is the strictest one: nothing on it means nothing to ask, without loading config for the data folder.
    if (!gatedAction(payload, () => [])) return "";
    const { DATA_DIR, DB_PATH, taintWindowHours } = await import("./config.js");
    const action = gatedAction(payload, () => knownHosts(opts.dataDir ?? DATA_DIR));
    if (!action) return "";
    const hours = taintWindowHours();
    const dbPath = opts.dbPath ?? DB_PATH;
    if (hours <= 0 || !existsSync(dbPath)) return "";
    const seen = await sessionOutside(dbPath, sessionId, hours, env);
    if (!seen) return "";
    const what = seen.tools.length ? seen.tools.join(", ") : "a web page or another MCP server";
    const reason =
      `Monomem: this session read outside content (${what}) ${seen.minutes} min ago, and now wants to ${action}. ` +
      "Text from outside can carry hidden instructions: allow this only if you asked for it. (A speed bump, not a sandbox: monomem settings known-hosts lists the hosts it trusts.)";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } });
  } catch (e) {
    process.stderr.write(`monomem hook taint-gate: ${(e as Error).message}\n`);
    return "";
  }
}
