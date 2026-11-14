// 1.4.0 outside-content taint: the shared vocabulary. No imports from store.ts (store.ts imports this file).
//
// A note is TAINTED when it carries a reserved `obs.origin:*` tag. Only the store sets one; a plain write cannot add or
// remove one (reserved-tags.ts), and every update re-adds them (Store.update), so taint only ever grows. The origins:
//   obs.origin:tool:<name>  a hook-equipped session in the same namespace ran an outside tool (WebFetch, another MCP server)
//   obs.origin:via:memory   this connection had read a note from outside content that nobody confirmed yet
//   obs.origin:declared     the writer said so: `outside: true` on the write, or a token marked `reads_outside`
// A tainted note with no qualifying confirm for its current rev is UNCONFIRMED: kept out of session start, labelled and
// mildly demoted in search, never hidden or deleted. Notes that existed before the 1.4.0 upgrade (grandfathered) are exempt.
// Monomem can only see outside reads its hooks, its own process, or a declaration show it: a shell `curl`, a downloaded file
// opened with Read, or a host without hooks is not seen.

export const ORIGIN_PREFIX = "obs.origin:";
export const ORIGIN_TOOL_PREFIX = "obs.origin:tool:";
export const ORIGIN_VIA_MEMORY = "obs.origin:via:memory";
export const ORIGIN_DECLARED = "obs.origin:declared";

/** Shown next to an unconfirmed note in search results, reads and index lines. */
export const UNCONFIRMED_LABEL = "[unconfirmed - from outside content]";
/** Mild ranking demotion for an unconfirmed note (still returned). */
export const UNCONFIRMED_FACTOR = 0.9;

/** Writers whose notes the session window never taints: the operator (CLI), the capture writer (it stamps its own exact tools), the server's own jobs, imports, library callers. */
export const SESSION_TAINT_EXEMPT: ReadonlySet<string> = new Set(["", "cli", "capture", "server", "runner", "import:claude"]);

export const isTainted = (tags: readonly string[]): boolean => tags.some((t) => t.startsWith(ORIGIN_PREFIX));

/**
 * Tools whose output is outside content: the web, and MCP servers other than Monomem itself. The name is the hook
 * payload's tool_name, recorded by capture.ts, never text the model wrote.
 * ponytail: local reads (Read/Grep/Glob) and Bash (curl, git pull) are not counted: they run in nearly every session, so
 * the label would mean nothing. A downloaded README read with Read is therefore NOT stamped (said in docs/trust.md).
 */
export function isOutsideTool(tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (tool === "WebFetch" || tool === "WebSearch") return true;
  if (!tool.startsWith("mcp__") || /^mcp__(plugin_monomem_)?monomem__/.test(tool)) return false;
  // MONOMEM_LOCAL_MCP_SERVERS: MCP servers the owner says return only local content (a code index, say), by server name.
  const server = tool.slice(5).split("__")[0].toLowerCase();
  const local = (env.MONOMEM_LOCAL_MCP_SERVERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !local.includes(server);
}

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
/** The stamp used when a tool's name is unsafe to print, or when the linter refuses the named stamp. */
export const OTHER_TOOL = "other";
/** `obs.origin:tool:<name>`, or `...:other` for a name that is not plain name characters. */
export const toolTag = (tool: string): string => ORIGIN_TOOL_PREFIX + (SAFE_TOOL_NAME.test(tool) ? tool : OTHER_TOOL);

/**
 * The comparable form of a stated source: a URL becomes its lowercased host without `www.`; anything else is the trimmed,
 * lowercased text. A stated source is a CLAIM: Monomem never fetches it.
 */
export function sourceKey(s: string): string {
  const t = s.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      return new URL(t).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      /* not a URL after all: fall through */
    }
  }
  return t.toLowerCase();
}

export const promotionRefusal = (verb: string, id: number): string =>
  `Can't ${verb}: this note came from outside content. A person must confirm it first: monomem confirm ${id}`;

/** The one session-start line for held-back notes ("" when none). No titles: a title can carry injected text too. */
export function unconfirmedCountLine(n: number): string {
  if (n <= 0) return "";
  return `Monomem: ${n} ${n === 1 ? "note" : "notes"} from outside content ${n === 1 ? "waits" : "wait"} for confirmation (not shown). Review: monomem review`;
}

// ---- re-confirmation expiry (1a) and derived_from (1d) ---------------------------------------------------------------
// Expiry is computed, never stored: due = max(updated_at, confirmed_at for this rev, grandfathered_at, mode switch) + days.
// off: nothing. label (default): flagged on reads and search. enforce: also kept out of session start, mildly demoted.

export type ConfirmMode = "off" | "label" | "enforce";
export const CONFIRM_MODES: readonly ConfirmMode[] = ["off", "label", "enforce"];
export const DEFAULT_CONFIRM_DAYS = 30;
export const MAX_CONFIRM_DAYS = 3650;
export const expiredLabel = (days: number): string => `[expired - not re-confirmed in ${days} days]`;
/** Shown next to a note whose derived_from includes a note a distrusted writer touched (one hop). */
export const DISTRUSTED_BASE_LABEL = "[built on a distrusted writer]";
/** How many notes one write may say it was built from. */
export const MAX_DERIVED_FROM = 20;

/** Session-start line for notes held back in enforce mode ("" when none). No titles. */
export function expiredCountLine(n: number, days: number): string {
  if (n <= 0) return "";
  return `Monomem: ${n} ${n === 1 ? "note" : "notes"} not re-confirmed in ${days} days (not shown). Review: monomem review`;
}

/** The text labels for a note's 1.4.0 flags, each with a leading space ("" when none). */
export function noteFlags(n: { unconfirmed_label?: string; expired_label?: string; built_on_distrusted_label?: string }): string {
  return [n.unconfirmed_label, n.expired_label, n.built_on_distrusted_label].filter(Boolean).map((l) => ` ${l}`).join("");
}

/** Kept out of session start: unconfirmed outside content, a note built on a distrusted writer, an expired note in enforce mode. */
export function heldFromSessionStart(n: { unconfirmed?: true; built_on_distrusted?: true; expired?: true }, enforce: boolean): boolean {
  return n.unconfirmed === true || n.built_on_distrusted === true || (enforce && n.expired === true);
}

// ---- notes a connection read while they were unconfirmed ------------------------------------------------------------
// Per authenticated writer, per server (REST and MCP over HTTP make a new handler per request, so the memory has to outlive
// one: each HTTP front door keeps one registry). The stdio server keeps its own set (one process = one agent). Cleared
// only by a restart.
// ponytail: unbounded per writer for the server's lifetime; a set of note ids is tiny next to the notes themselves.
export function newTaintRegistry(): (writer: string) => Set<number> {
  const byWriter = new Map<string, Set<number>>();
  return (writer) => {
    let s = byWriter.get(writer);
    if (!s) byWriter.set(writer, (s = new Set()));
    return s;
  };
}

/** Ids of every `unconfirmed: true` note object inside a read result (any nesting the tools use). */
export function unconfirmedIdsIn(payload: unknown, depth = 0): number[] {
  if (!payload || typeof payload !== "object" || depth > 6) return [];
  if (Array.isArray(payload)) return payload.flatMap((p) => unconfirmedIdsIn(p, depth + 1));
  const o = payload as Record<string, unknown>;
  const here = o.unconfirmed === true && typeof o.id === "number" ? [o.id] : [];
  return here.concat(...Object.values(o).map((v) => unconfirmedIdsIn(v, depth + 1)));
}
