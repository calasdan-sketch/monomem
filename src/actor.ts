// Who is writing? The label of the token (or MCP connection) behind the call,
// carried through async code so the store can stamp it on the change_log row
// of every write (change_log.actor) and, since 1.3.3, on the note itself
// (notes.written_by / created_by). It is NOT the note's `source` (provenance
// a client can set freely): exclude_self filters on the actor.
//
// A per-request holder object (not a bare string) lets the HTTP API open the
// context before it has authenticated and fill the label in afterwards.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Sensitivity } from "./sensitivity.js";

export interface ActorRef {
  label: string;
  /**
   * True once the label comes from an authenticated token (HTTP API, MCP over
   * HTTP). Only then does it count as a server-verified writer identity; a
   * bare label (tests, scripts) never becomes `written_by` on its own.
   */
  authed?: boolean;
  /**
   * The token's sensitivity ceiling (config `max_sensitivity`). Undefined = no ceiling (the primary/operator token, stdio,
   * the CLI, a token with none set). Set, the store hides every note labelled above it, on every read path, and refuses
   * writes above it. See src/sensitivity.ts.
   */
  maxSensitivity?: Sensitivity;
  /** False for a non-admin token: it may raise a note's label but not lower it. Undefined = may (operator, CLI, stdio). */
  canDeclassify?: boolean;
  /**
   * 1.4.0: `obs.origin:*` tags this connection adds to every note it writes (taint.ts): `via:memory` once it has read an
   * unconfirmed note, `declared` for a token marked reads_outside. Set by the entry point, never from a request body.
   */
  taint?: readonly string[];
  /** 1.4.0: ids of unconfirmed notes this connection has read (its confirm of one of them does not count). */
  taintedReads?: ReadonlySet<number>;
  /**
   * 1.4.0: the namespaces this connection may read, when its server confines it (a namespace-pinned token or server).
   * Undefined = no boundary. The store checks a write's derived_from against it, so a link cannot probe other namespaces.
   */
  readable?: readonly string[];
}

export const actorStore = new AsyncLocalStorage<ActorRef>();

/** The sensitivity ceiling of the current call, or undefined when it has none. */
export function currentCeiling(): Sensitivity | undefined {
  return actorStore.getStore()?.maxSensitivity;
}

/** The writer's label for the current call, or "" (CLI, scripts, unknown). */
export function currentActor(): string {
  return actorStore.getStore()?.label ?? "";
}

/**
 * Fixed markers for writers that have no token. They are set by the entry
 * point (never by a client): `stdio` = the local MCP stdio server, `cli` =
 * an `monomem` command run by the machine owner, `server` = the server's
 * own background jobs, `runner` = the command runner process (it writes the
 * heartbeat that runner_status trusts), `import:claude` = `monomem import --claude` (set explicitly by that command), `capture` = the
 * capture hooks (`monomem hook <event>`: observations and session summaries). A token labelled like one of these is stored as
 * `token:<label>` so it cannot impersonate a marker. The stdio server stamps `stdio:<app>` instead of `stdio`
 * when its launch config names the app (stdioWriter); a token labelled `stdio:...` is escaped the same way.
 */
export const WRITER_MARKERS = ["stdio", "cli", "server", "runner", "import:claude", "capture"] as const;
export type WriterMarker = (typeof WRITER_MARKERS)[number];

/** One plain-words description per marker. describeWriter, describeCreator and why's writerKind are all built from this, so a new marker cannot drift. */
export const MARKER_DESCRIPTIONS: Record<WriterMarker, string> = {
  stdio: "local MCP client, no sign-in",
  cli: "the local monomem command",
  server: "Monomem's own background job",
  runner: "the command runner process on the owner's PC",
  "import:claude": "monomem import --claude, run by the machine owner",
  capture: "a capture hook (monomem hook), no sign-in",
};

export const isWriterMarker = (w: string): w is WriterMarker => (WRITER_MARKERS as readonly string[]).includes(w);

/** Markers for notes the machine owner or the server wrote itself (not an agent). The dashboard review queue skips these, and unstamped ("") rows. */
export const HUMAN_WRITER_MARKERS: readonly WriterMarker[] = ["cli", "server", "import:claude"];
/** {cli:1, server:1, "import:claude":1, "":1}: the lookup object dashboard.ts HUMAN_WRITERS uses. */
export const humanWriterMap = (): Record<string, 1> => Object.fromEntries([...HUMAN_WRITER_MARKERS, ""].map((k) => [k, 1 as const]));

let processWriter = "";

/** Set once by an entry point (mcp-stdio, cli, start) for writes with no token. */
export function setProcessWriter(marker: WriterMarker | `stdio:${string}` | ""): void {
  processWriter = marker;
}

/** An app name for the stdio marker: a-z 0-9 . _ -, 1-40 characters, starting with a letter or digit. */
const CLIENT_LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * The stdio writer marker: `stdio:<app>` when the launch config sets MONOMEM_CLIENT (setup writes the app's id
 * there), else plain `stdio`. The app name is a CLAIM made by whoever can edit that config file, not an
 * authenticated identity: it tells apps apart, it does not prove which one wrote. An invalid value is ignored
 * (plain `stdio`) and reported in `warning`, so a typo never stops the server and never reaches written_by.
 */
export function stdioWriter(env: NodeJS.ProcessEnv = process.env): { writer: "stdio" | `stdio:${string}`; warning?: string } {
  const raw = env.MONOMEM_CLIENT;
  if (raw === undefined || raw.trim() === "") return { writer: "stdio" };
  const label = raw.trim().toLowerCase();
  if (!CLIENT_LABEL.test(label)) {
    return { writer: "stdio", warning: 'MONOMEM_CLIENT ignored (use 1-40 characters a-z 0-9 . _ -, starting with a letter or digit); writes are stamped plain "stdio"' };
  }
  return { writer: `stdio:${label}` };
}

/** Longest stored writer identity (labels are operator-chosen; this is a backstop). */
export const WRITER_MAX = 100;

/** The whitespace/control-character part of cleanWriter, without the length cap. */
export function squashWriter(s: unknown): string {
  if (typeof s !== "string") return "";
  // NFKC first, so a rule, a filter and a stored label spelled with different but canonically
  // equivalent characters ("e" + combining accent vs the precomposed letter, full-width letters)
  // are the same label; then invisible format characters (zero-width space/joiner, bidi marks, BOM)
  // go, so they cannot make two labels that look identical differ. Letter case is NOT folded:
  // labels are exact (`Alice` and `alice` are two writers).
  // Dropping a format character can make a base letter and a combining mark adjacent ("e" + ZWSP + U+0301), which a second NFKC
  // would then recompose; so the pass repeats until nothing changes (it settles in two rounds), which makes this idempotent:
  // squash(squash(x)) === squash(x), and a rule typed with or without the invisible character matches the same stored label.
  let t = s;
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-control-regex
    const next = t.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * One printable line: control characters and line breaks become spaces, runs
 * of whitespace collapse, ends are trimmed. A label longer than WRITER_MAX is
 * shortened to a prefix plus "~" and 12 hex digits of its SHA-256, so two
 * long labels sharing a prefix stay distinct and the SAME function applied to
 * a filter value finds the stored one. Idempotent.
 */
export function cleanWriter(s: unknown): string {
  const t = squashWriter(s);
  if (t.length <= WRITER_MAX) return t;
  return t.slice(0, WRITER_MAX - 13) + "~" + createHash("sha256").update(t).digest("hex").slice(0, 12);
}

/**
 * The server-verified identity of the current writer, for `written_by`:
 * the authenticated token's label, else the entry point's fixed marker,
 * else "" (unknown: a library caller or an old row). Never derived from
 * anything the client sent in the request body.
 *
 * A token label that equals a marker (any letter case) or starts with
 * `token:` or `stdio:` is stored as `token:<label>`, so no label can impersonate a marker
 * or another token's escaped form.
 */
export function currentWriter(): string {
  const a = actorStore.getStore();
  if (a?.authed) {
    const label = cleanWriter(a.label) || "(unlabeled)";
    const lower = label.toLowerCase();
    // `stdio:` is reserved for the per-app stdio markers (stdioWriter): a token cannot pose as a local app either.
    return (WRITER_MARKERS as readonly string[]).includes(lower) || lower.startsWith("token:") || lower.startsWith("stdio:") ? cleanWriter(`token:${label}`) : label;
  }
  return processWriter;
}
