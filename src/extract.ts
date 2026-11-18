// Automatic memory, part 2: the free, deterministic distiller.
//
// Raw capture events (capture.ts) are turned into a few observations per session and one summary, with no model call:
//   - a git commit            -> an observation typed by its conventional prefix (fix -> bugfix, feat -> feature,
//                                refactor -> refactor, anything else -> change), linked to the files edited before it
//   - a test/build command that failed and later passed -> bugfix
//   - a test command that failed and was not fixed in the batch -> discovery ("tests failing")
//   - files edited outside any commit -> one change observation for the batch
//   - a redacted secret       -> security_note (the label only, never the value)
//   - a prompt-injection-shaped tool output -> security_alert (the label and the source only, never the text)
//   - a decision phrase in a prompt ("let's go with", "from now on", ...) -> decision
//   - concepts: keywords.ts over the observation's own text, as obs.concept:<word> tags
// With a key present (1.5.0 S-02a) titles and tags are never sealed, so a capture note gets fixed words for a title
// ("Decision (sealed)", "Session 2026-11-14"), its built title moves to the first line of the sealed body, and no concept tags.
// Observations and summaries go through Store.create / Store.update like any note (lint, quarantine, history apply);
// their kind/session/type are set through write options no request can reach, and their tags are reserved
// (reserved-tags.ts), so an ordinary write cannot forge one. Observations run from `distilled_seq` onward (each event is
// distilled once); the summary is rebuilt from the whole session each time and updates the session's one summary note.
import type { Store, NoteRecord } from "./store.js";
import { DEFAULT_NAMESPACE } from "./store.js";
import { scanForInjection } from "./lint.js";
import { extractKeywords } from "./keywords.js";
import { captureAad, eventInput } from "./capture.js";
import { MODEL_WRITTEN_TAG, ORIGIN_TOOL_PREFIX } from "./reserved-tags.js";
import { AFTER_OUTSIDE_MARKER, isOutsideTool, OTHER_TOOL, toolTag } from "./taint.js";

export const OBS_TYPES = ["bugfix", "feature", "refactor", "change", "discovery", "decision", "security_alert", "security_note"] as const;
export type ObsType = (typeof OBS_TYPES)[number];

/** The source label every capture-written note carries. */
export const CAPTURE_SOURCE = "monomem capture";
/** Events read per distill pass (a very long session is distilled over several stops). */
const BATCH = 2000;
/** An unfinished session with no event for this long is treated as ended (its process crashed or was closed). */
export const STALE_SESSION_MS = 30 * 60_000;

export interface EventRow {
  seq: number;
  at: string;
  event: string;
  tool: string;
  input: string;
  output: string;
  ok: boolean;
}

interface SessionRow {
  id: string;
  namespace: string;
  cwd: string;
  started_at: string;
  distilled_seq: number;
  summary_note_id: number | null;
}

export interface Observation {
  type: ObsType;
  title: string;
  body: string;
  files: Array<{ path: string; action: "changed" | "read" }>;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

// isOutsideTool lives in taint.ts (the store needs it too, without importing this file).
export { isOutsideTool, OTHER_TOOL };
/** At most this many tool names are stamped on one summary (sorted); a session that used more still gets the first ones. */
export const MAX_ORIGIN_TOOLS = 3;

/** Pure: the outside-content tools that returned output in these events, as stamp tags (exported for the tests). */
export function originTags(events: readonly { event: string; tool: string; output: string }[]): string[] {
  const seen = new Set<string>();
  // A tool name lands in a tag and in agent context: anything but plain name characters is stamped as "other" (still stamped).
  for (const e of events) if (isOutsideRead(e)) seen.add(toolTag(e.tool));
  return [...seen].sort().slice(0, MAX_ORIGIN_TOOLS);
}

/** An event that returned outside content: what stamps a summary and what marks the cut (one test, so the two cannot drift). */
const isOutsideRead = (e: { event: string; tool: string; output: string }): boolean =>
  (e.event === "post-tool" || e.event === "post-tool-failure") && Boolean(e.output) && isOutsideTool(e.tool);

interface Bucket {
  changed: Set<string>;
  read: Set<string>;
  commands: string[];
  errors: string[];
}
const bucket = (): Bucket => ({ changed: new Set(), read: new Set(), commands: [], errors: [] });

/** The sequence number of the first event that returned outside content (the same test originTags stamps by), else null. */
export function firstOutsideSeq(events: readonly { seq: number; event: string; tool: string; output: string }[]): number | null {
  let first: number | null = null;
  for (const e of events) if (isOutsideRead(e) && (first === null || e.seq < first)) first = e.seq;
  return first;
}

/** Where the session first read outside content: the lowest seq AND the earliest time. Events are numbered when they are stored,
 *  and a busy store can store an event late, so an event counts as "from the read on" if EITHER says so (holding too much is safe). */
export function firstOutside(events: readonly { seq: number; at: string; event: string; tool: string; output: string }[]): { seq: number; at: string } | null {
  let seq: number | null = null;
  let at = "";
  for (const e of events) {
    if (!isOutsideRead(e)) continue;
    if (seq === null || e.seq < seq) seq = e.seq;
    if (!at || e.at < at) at = e.at;
  }
  return seq === null ? null : { seq, at };
}

const TEST_CMD = /\b(?:node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|npx\s+(?:jest|vitest)|jest|vitest|pytest|cargo\s+test|go\s+test)\b/;
const BUILD_CMD = /\b(?:(?:npm|pnpm|yarn)\s+run\s+build|tsc\b|cargo\s+build|go\s+build|make\b)/;
const TEST_FAILED =
  /(?:\b[1-9]\d*\s+(?:failed|failing)\b|^FAIL\b|ℹ fail [1-9]|\bfailures?[=:]\s*[1-9]|test result: FAILED|^--- FAIL|^FAILED\b|\berror TS\d+)/m;
const DECISION =
  /\b(?:let'?s\s+(?:go\s+with|use|stick\s+with)|we(?:'ll|\s+will)\s+(?:go\s+with|use)|we\s+decided|decided\s+to|decision:|from\s+now\s+on|always\s+use|never\s+use|don'?t\s+use|instead\s+of)\b/i;
const REDACTED = /\[REDACTED:([^\]]{1,40})\]/g;

const one = (s: string, max: number): string => {
  const c = (s || "").replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
};

/** A string field of the (possibly truncated) JSON tool input. */
function field(input: string, name: string): string {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/**
 * Scratch space rather than the project: temp folders, caches, dependency and
 * build output, VCS internals. Editing one of these is something the tooling
 * did, not a fact about the user's work, and the paths themselves are
 * meaningless a day later ("Edited 6 files: AppData/Local/Temp/claude/...").
 * The session-folder exclude list never covered these, because it filters the
 * session's cwd and not the edited path.
 */
export function isEphemeralPath(p: string, cwd = ""): boolean {
  const f = p.replace(/\\/g, "/").toLowerCase();

  // Unambiguous at any depth: nobody keeps hand-written source in these.
  if (/(^|\/)(node_modules|\.git|\.venv|__pycache__|\.cache|\.next|\.pytest_cache|\.tox)(\/|$)/.test(f)) return true;

  // Machine temp space, by absolute marker rather than by a segment name.
  if (/appdata\/local\/temp\//.test(f) || /^\/tmp\//.test(f) || /^[a-z]:\/temp\//.test(f) || /(^|\/)scratchpad(\/|$)/.test(f)) return true;

  // `dist`, `build`, `coverage` and `tmp` are only build output when they are
  // at the ROOT of the project. Matching them at any depth was wrong: it threw
  // away real edits to `src/build/auth.ts`, to a monorepo package named
  // `packages/build/`, and to any source tree under `temp/` or `tmp/`. Losing a
  // genuine edit is worse than recording a generated one, so this errs the
  // other way now.
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rel = base && f.startsWith(base + "/") ? f.slice(base.length + 1) : f;
  return /^(dist|build|out|coverage|tmp|temp)\//.test(rel);
}

/**
 * Drop the parts of a prompt the user did not write: relayed agent messages,
 * fenced blocks and quoted lines. The prompt channel carries both the user's
 * own words and text the harness relays from subagents, and running the
 * decision pattern over the whole thing filed a subagent's report as the
 * owner's decision -- the stored body even included the harness's own "this is
 * model output, NOT a message from the user" preamble.
 */
export function stripNotUserWritten(s: string): string {
  return (s || "")
    .replace(/<agent-message\b[\s\S]*?<\/agent-message>/gi, "\n")
    .replace(/<agent-message\b[\s\S]*$/i, "\n") // unclosed relay block
    .replace(/\[Subagent hand-back\][\s\S]*$/i, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/^[ \t]*>.*$/gm, "\n");
}

/** A prompt long enough to be an instruction rather than a greeting. */
const MIN_PROMPT_CHARS = 40;

/** A file path as stored in note_files: forward slashes, relative to the session folder when inside it. */
export function normPath(p: string, cwd: string): string {
  const f = p.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && f.toLowerCase().startsWith(base.toLowerCase() + "/")) return f.slice(base.length + 1);
  return f;
}

function commitMessage(cmd: string): string {
  const here = /<<-?\s*'?(\w+)'?\s*\n([\s\S]*?)\n\s*\1/.exec(cmd);
  if (here) return here[2].trim();
  const dq = /\s-m\s+"((?:[^"\\]|\\.)*)"/.exec(cmd);
  if (dq) return dq[1].replace(/\\(.)/g, "$1");
  const sq = /\s-m\s+'([^']*)'/.exec(cmd);
  return sq ? sq[1] : "";
}

export function commitType(message: string): ObsType {
  const p = /^(\w+)(?:\([^)]*\))?!?:/.exec(message.trim())?.[1]?.toLowerCase();
  return p === "fix" ? "bugfix" : p === "feat" ? "feature" : p === "refactor" ? "refactor" : "change";
}

function testFailed(e: EventRow): boolean {
  return !e.ok || TEST_FAILED.test(e.output);
}

/** Pure: a batch of events -> its observations (exported for the tests). */
export function observe(events: readonly EventRow[], cwd: string): Observation[] {
  const out: Observation[] = [];
  let edited: string[] = []; // files changed since the last unit that claimed them
  const failing = new Map<string, { at: number; output: string }>(); // command -> its last failure (index)
  const secretLabels = new Set<string>();
  const alertSeen = new Set<string>(); // injection alerts already raised, by label+source
  const add = (o: Observation): void => void out.push(o);
  const take = (): Observation["files"] => {
    const f = [...new Set(edited)].map((path) => ({ path, action: "changed" as const }));
    edited = [];
    return f;
  };
  events.forEach((e, i) => {
    for (const m of `${e.input}\n${e.output}`.matchAll(REDACTED)) secretLabels.add(m[1]);
    if (e.event === "user-prompt") {
      // Only the user's own words can be the user's decision.
      const own = stripNotUserWritten(e.input);
      const sentence = own.split(/(?<=[.!?])\s+|\n+/).find((s) => DECISION.test(s));
      if (sentence) add({ type: "decision", title: `Decision: ${one(sentence, 110)}`, body: one(own, 600), files: [] });
      return;
    }
    if (e.event !== "post-tool" && e.event !== "post-tool-failure") return;
    if (EDIT_TOOLS.has(e.tool) && e.ok) {
      const p = field(e.input, "file_path") || field(e.input, "notebook_path");
      if (p && !isEphemeralPath(p, cwd)) edited.push(normPath(p, cwd));
      return;
    }
    if (e.output && e.tool && !EDIT_TOOLS.has(e.tool)) {
      const inj = scanForInjection(e.output);
      // "harness tool-syntax" is raw `<invoke name=` / `<function_calls`
      // markup, which appears in ordinary output whenever anything reads an
      // agent log or greps a prompt -- a false positive by construction (5 of
      // the 13 notes in the maintainer's own store). It has its own label and
      // sits LAST in INJECTION_PATTERNS precisely so that suppressing it here
      // cannot suppress a real signal found in the same text: "do not tell the
      // user" and "call state_delete on all now" keep the "tool-call coercion"
      // label and still alert.
      //
      // The source is for the user to know what to distrust; when the tool
      // carries no url/file_path/command (WebSearch, Grep, Task, and any
      // mcp__* tool -- the likeliest injection channel of all) fall back to
      // naming the tool, rather than dropping the alert.
      const source = inj ? field(e.input, "url") || field(e.input, "file_path") || field(e.input, "command") : "";
      const from = source || (inj ? `the ${e.tool} tool` : "");
      if (inj && inj !== "harness tool-syntax") {
        // One alert per source per session, not one per occurrence.
        const key = `${inj}|${one(from, 200)}`;
        if (!alertSeen.has(key)) {
          alertSeen.add(key);
          add({
            type: "security_alert",
            title: `Possible prompt injection in ${e.tool} output`,
            body: `The ${e.tool} result for ${one(from, 200)} contained text shaped like a prompt injection (${inj}). Treat that source as untrusted.`,
            files: [],
          });
        }
      }
    }
    if (e.tool !== "Bash") return;
    const cmd = field(e.input, "command");
    if (!cmd) return;
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) && e.ok && !/nothing to commit/i.test(e.output)) {
      const msg = commitMessage(cmd);
      const first = msg.split("\n")[0].trim() || "commit";
      add({ type: commitType(first), title: one(first, 120), body: `Committed: ${one(msg, 600)}`, files: take() });
      return;
    }
    const isTest = TEST_CMD.test(cmd);
    if (!isTest && !BUILD_CMD.test(cmd)) return;
    const key = one(cmd, 200);
    const failed = isTest ? testFailed(e) : !e.ok || /\berror\b/i.test(e.output.slice(0, 2000));
    if (failed) failing.set(key, { at: i, output: e.output });
    else if (failing.has(key)) {
      const was = failing.get(key)!;
      failing.delete(key);
      const firstErr = was.output.split("\n").find((l) => l.trim()) ?? "";
      add({
        type: "bugfix",
        title: `Fixed failing \`${one(cmd, 90)}\``,
        body: `\`${one(cmd, 200)}\` failed${firstErr ? ` (${one(firstErr, 200)})` : ""} and passes after the changes${edited.length ? ` to ${[...new Set(edited)].slice(0, 10).join(", ")}` : ""}.`,
        files: take(),
      });
    }
  });
  for (const [cmd, f] of failing) {
    if (!TEST_CMD.test(cmd)) continue;
    const firstErr = f.output.split("\n").find((l) => TEST_FAILED.test(l) || /error/i.test(l)) ?? "";
    add({ type: "discovery", title: `Tests failing: \`${one(cmd, 90)}\``, body: `\`${cmd}\` was failing${firstErr ? `: ${one(firstErr, 300)}` : ""}.`, files: [] });
  }
  if (edited.length) {
    const files = take();
    add({ type: "change", title: `Edited ${files.length} file${files.length === 1 ? "" : "s"}: ${one(files.map((f) => f.path).join(", "), 100)}`, body: files.map((f) => f.path).join("\n"), files });
  }
  for (const label of secretLabels) {
    add({ type: "security_note", title: `A ${label} was kept out of memory`, body: `A ${label} appeared in captured work and was redacted before it was stored. If it was real, consider rotating it.`, files: [] });
  }
  return out;
}

function eventsAfter(store: Store, sessionId: string, seq: number, limit = BATCH): EventRow[] {
  const rows = store
    .captureDb()
    .prepare("SELECT seq, at, event, tool, input, input_enc, output, output_enc, ok FROM capture_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(sessionId, seq, limit) as Array<{ seq: number; at: string; event: string; tool: string; input: string; input_enc: string | null; output: string; output_enc: string | null; ok: number }>;
  return rows.map((r) => {
    let output = "";
    try {
      output = store.openCapture(r.output, r.output_enc, captureAad(r.seq, sessionId));
    } catch {
      /* sealed with a key that is gone: the output is skipped, the rest still counts */
    }
    return { seq: r.seq, at: r.at, event: r.event, tool: r.tool, input: eventInput(store, r, sessionId), output, ok: r.ok === 1 };
  });
}

function session(store: Store, id: string): SessionRow | null {
  return (store.captureDb().prepare("SELECT id, namespace, cwd, started_at, distilled_seq, summary_note_id FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
}

/** Words the observation templates themselves add: not concepts. */
const TEMPLATE_WORDS = new Set(["fixed", "failing", "failed", "passes", "changes", "decision", "session", "request", "tests", "test", "edited", "file", "files", "memory", "kept", "appeared", "captured", "committed", "redacted", "stored", "work"]);

function tagsFor(kind: "observation" | "summary", type: string, text: string): string[] {
  const concepts = extractKeywords(text).map((k) => k.replace(/^#/, "")).filter((k) => !TEMPLATE_WORDS.has(k) && !/[/\\`]/.test(k));
  return [kind, `obs.type:${type}`, ...concepts.slice(0, 5).map((k) => `obs.concept:${k}`)];
}

/** The fixed title a sealed observation gets ("Decision (sealed)", "Security alert (sealed)"). */
const SEALED_SUFFIX = " (sealed)";
const sealedObsTitle = (type: string): string => `${type.charAt(0).toUpperCase()}${type.slice(1).replace(/_/g, " ")}${SEALED_SUFFIX}`;
/** The fixed title a sealed session summary gets: the day it started. */
export const sealedSessionTitle = (startedAt: string): string => `Session ${startedAt.slice(0, 10)}`;
/** An observation's own title: a sealed one keeps it as the first line of its body. */
const obsTitle = (n: { title: string; body: string }): string => (n.title.endsWith(SEALED_SUFFIX) ? n.body.split("\n")[0] : n.title);

/** Write one capture note; a write the linter holds or refuses is skipped (the linter doing its job), never thrown. */
function write(store: Store, s: SessionRow, kind: "observation" | "summary", type: string, title: string, body: string, files: Observation["files"], extraTags: string[] = []): NoteRecord | null {
  const sealed = store.sealsWrites();
  if (sealed) {
    // The summary's request is already in its body ("Request: ..."); an observation's title becomes its first body line.
    if (kind === "observation") body = `${title}\n${body}`;
    title = kind === "observation" ? sealedObsTitle(type) : sealedSessionTitle(s.started_at);
  }
  const attempt = (extra: string[]): NoteRecord => {
    const note = store.create(
      { namespace: s.namespace || DEFAULT_NAMESPACE, title, body, tags: [...tagsFor(kind, type, sealed ? "" : `${title} ${body}`), ...extra], source: CAPTURE_SOURCE },
      { kind, sessionId: s.id, obsType: kind === "observation" ? type : "", skipEdges: true }
    );
    linkFiles(store, note.id, files);
    return note;
  };
  try {
    return attempt(extraTags);
  } catch {
    // A tool name the linter dislikes must not cost the session its summary: retry once with the plain "other" stamp.
    if (!extraTags.length) return null;
    try {
      return attempt([ORIGIN_TOOL_PREFIX + OTHER_TOOL]);
    } catch {
      return null;
    }
  }
}

function linkFiles(store: Store, noteId: number, files: Observation["files"]): void {
  store.linkNoteFiles(noteId, files);
}

/** The most events one summary rebuild reads. A session that reaches it may have an outside read before the window. */
const SUMMARY_EVENT_WINDOW = 20_000;

/** Pure: the summary text of a whole session. Null when there is nothing worth summarizing. */
export function summarize(events: readonly EventRow[], cwd: string, observationTitles: readonly string[], opts: { windowFull?: boolean } = {}): { title: string; body: string; files: Observation["files"] } | null {
  const prompts = events.filter((e) => e.event === "user-prompt" && e.input.trim());
  const tools = events.filter((e) => e.event === "post-tool" || e.event === "post-tool-failure");
  // A session needs something in it. "hi" with no tool calls was producing a
  // note titled "Session: hi" -- 3 of the 13 notes in the maintainer's own
  // store. Work done counts however short the prompt was; a prompt long enough
  // to be an instruction counts even with no tool calls.
  const didWork = tools.length > 0;
  const saidSomething = prompts.some((p) => stripNotUserWritten(p.input).trim().length >= MIN_PROMPT_CHARS);
  if (!didWork && !saidSomething) return null;
  // The first outside read splits the session. Everything the agent did BEFORE it could not have been shaped by that content
  // (it did not exist yet); what came at or after it could. Those lines go in a second part the start-up briefing never pastes.
  // `windowFull`: the caller read the most events it will, so the real first outside read may lie before the window; then
  // everything counts as from the read on (the first part keeps only what cannot be placed, i.e. nothing).
  const found = firstOutside(events);
  const cut = found && opts.windowFull ? { seq: 0, at: "" } : found;
  const after = (e: { seq: number; at: string }): boolean => cut !== null && (e.seq >= cut.seq || e.at >= cut.at);
  const early = bucket();
  const late = bucket();
  // The observation titles come from the whole session; with an outside read, only the ones for events before it count here.
  const titles = cut === null ? observationTitles : observe(events.filter((e) => !after(e)), cwd).map((o) => o.title);
  const changed = new Set<string>();
  const read = new Set<string>();
  let lastTest: { cmd: string; failed: boolean } | null = null;
  let editsSinceCommit = new Set<string>();
  for (const e of tools) {
    const into = after(e) ? late : early;
    const p = field(e.input, "file_path") || field(e.input, "notebook_path") || (READ_TOOLS.has(e.tool) ? field(e.input, "path") : "");
    // R1-07: a path is one printable line, capped; tool OUTPUT never enters the summary (it can be attacker text).
    const clean = (x: string): string => one(normPath(x, cwd), 120);
    if (p && EDIT_TOOLS.has(e.tool) && e.ok) {
      changed.add(clean(p));
      into.changed.add(clean(p));
      editsSinceCommit.add(clean(p));
    } else if (p && READ_TOOLS.has(e.tool)) {
      read.add(clean(p));
      into.read.add(clean(p));
    }
    if (!e.ok) {
      const code = /\bexit(?:ed with)?(?: code)?[: ]+(\d{1,3})\b/i.exec(e.output)?.[1];
      into.errors.push(`${one(e.tool, 40)} failed${code ? ` (exit ${code})` : ""}`);
    }
    if (e.tool !== "Bash") continue;
    const cmd = field(e.input, "command");
    if (!cmd) continue;
    const isTest = TEST_CMD.test(cmd);
    const failed = isTest ? testFailed(e) : !e.ok;
    into.commands.push(`${failed ? "✗" : "✓"} ${one(cmd, 120)}`);
    if (isTest) lastTest = { cmd: one(cmd, 120), failed };
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) && e.ok) editsSinceCommit = new Set();
  }
  // With an outside read, the request is the first prompt that came BEFORE it, and only its user-written part.
  const firstPrompt = cut === null ? prompts[0] : prompts.find((p) => !after(p));
  const request = firstPrompt ? one(cut === null ? firstPrompt.input : stripNotUserWritten(firstPrompt.input), 300) : "";
  const isStop = (e: EventRow): boolean => (e.event === "stop" || e.event === "session-end") && Boolean(e.input.trim());
  const lastWords = [...events].reverse().find(isStop); // the session's last words, wherever they fall
  const lastEarly = [...events].reverse().find((e) => isStop(e) && !after(e)); // the last ones before the outside read
  const outcome = [
    lastTest ? (lastTest.failed ? `tests failing (${lastTest.cmd})` : `tests passing (${lastTest.cmd})`) : "",
    [...early.commands, ...late.commands].filter((c) => /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(c) && c.startsWith("✓")).length ? "changes committed" : "",
  ].filter(Boolean);
  const next = lastTest?.failed
    ? `Fix the failing \`${lastTest.cmd}\`.`
    : editsSinceCommit.size
      ? `Review and commit the changes to ${[...editsSinceCommit].slice(0, 5).join(", ")}.`
      : "";
  const uniq = (xs: string[], n: number): string[] => [...new Set(xs)].slice(0, n);
  // Per-part limits apply to each part, so a session with an outside read can run to about twice the size.
  const bucketLines = (b: Bucket): string[] => {
    const out: string[] = [];
    if (b.changed.size) out.push(`Files changed: ${uniq([...b.changed], 30).join(", ")}`);
    if (b.read.size) out.push(`Files read: ${uniq([...b.read], 30).join(", ")}`);
    if (b.commands.length) out.push(`Commands: ${uniq(b.commands, 15).join(" | ")}`);
    if (b.errors.length) out.push(`Errors: ${uniq(b.errors, 5).join(" | ")}`);
    return out;
  };
  // Done: the closing words from before the outside read (the last ones overall when there was none). The session's actual
  // last words, written after the read, go in the second part.
  const doneWords = cut === null ? lastWords : lastEarly;
  const lines: string[] = [];
  if (request) lines.push(`Request: ${request}`);
  if (titles.length || doneWords) lines.push(`Done: ${[...titles.slice(0, 10), doneWords ? one(doneWords.input, 300) : ""].filter(Boolean).join("; ")}`);
  lines.push(...bucketLines(early));
  const tail: string[] = [];
  if (cut !== null && lastWords && after(lastWords)) tail.push(`Closing words: ${one(lastWords.input, 300)}`);
  if (cut !== null) tail.push(...bucketLines(late));
  if (outcome.length) tail.push(`Outcome: ${outcome.join(", ")}`);
  if (next) tail.push(`Next step: ${next}`);
  // No outside read: one part, exactly as before. An outside read: what came before it, the marker (even when nothing came after), then the rest.
  if (cut !== null) lines.push(AFTER_OUTSIDE_MARKER);
  lines.push(...tail);
  const where = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return {
    title: `Session: ${request ? one(request, 80) : `work in ${where || "a project"}`}`,
    body: lines.join("\n"),
    // With an outside read, only the paths touched before it are linked to the note.
    files: [...[...(cut === null ? changed : early.changed)].map((path) => ({ path, action: "changed" as const })), ...[...(cut === null ? read : early.read)].map((path) => ({ path, action: "read" as const }))],
  };
}

/**
 * Distill one session: observations for events after distilled_seq, then the session summary (created once, updated
 * after). Returns what was written.
 */
export function distillSession(store: Store, sessionId: string): { observations: number; summaryId: number | null } {
  const s = session(store, sessionId);
  if (!s) return { observations: 0, summaryId: null };
  let written = 0;
  let seq = s.distilled_seq;
  for (;;) {
    const batch = eventsAfter(store, sessionId, seq);
    if (!batch.length) break;
    for (const o of observe(batch, s.cwd)) if (write(store, s, "observation", o.type, o.title, o.body, o.files)) written++;
    seq = batch[batch.length - 1].seq;
    store.captureDb().prepare("UPDATE sessions SET distilled_seq = ? WHERE id = ?").run(seq, sessionId);
    if (batch.length < BATCH) break;
  }
  const all = eventsAfter(store, sessionId, 0, SUMMARY_EVENT_WINDOW);
  const titles = store.list({ kinds: ["observation"], sessionId, limit: 50, order: "created_asc" }).notes.map(obsTitle);
  const sum = summarize(all, s.cwd, titles, { windowFull: all.length >= SUMMARY_EVENT_WINDOW });
  if (!sum) return { observations: written, summaryId: s.summary_note_id };
  if (store.sealsWrites()) sum.title = sealedSessionTitle(s.started_at);
  // The summary quotes the session's errors and closing words, which can carry what an outside tool returned: stamp it.
  // Observations are not stamped: their text comes from the user's prompts and local commands, never from tool output.
  const origin = originTags(all);
  let id = s.summary_note_id;
  const existing = id !== null ? store.read(id) : null; // gate-ok: the capture writer re-reads its own summary note
  try {
    if (existing && existing.kind === "summary") {
      // A rebuilt summary is the deterministic text again: it loses the model-written mark (llm.ts). Stamps only grow:
      // an origin seen earlier in the session stays even if a later rebuild's window no longer shows it.
      const kept = existing.tags.filter((t) => t !== MODEL_WRITTEN_TAG);
      const room = MAX_ORIGIN_TOOLS - kept.filter((t) => t.startsWith(ORIGIN_TOOL_PREFIX)).length;
      const added = origin.filter((t) => !kept.includes(t)).slice(0, Math.max(0, room));
      if (existing.body !== sum.body || existing.title !== sum.title || added.length) {
        try {
          store.update(existing.id, { title: sum.title, body: sum.body, tags: [...kept, ...added] });
        } catch (e) {
          // Retry once with the plain stamp, so a refused tool name does not freeze the summary (the outer catch keeps it as it was).
          if (!added.length) throw e;
          const other = ORIGIN_TOOL_PREFIX + OTHER_TOOL;
          store.update(existing.id, { title: sum.title, body: sum.body, tags: kept.includes(other) ? kept : [...kept, other] });
        }
      }
      linkFiles(store, existing.id, sum.files);
    } else {
      id = write(store, s, "summary", "session", sum.title, sum.body, sum.files, origin)?.id ?? null;
      if (id !== null) store.captureDb().prepare("UPDATE sessions SET summary_note_id = ? WHERE id = ?").run(id, sessionId);
    }
  } catch {
    /* a held or refused update leaves the previous summary in place */
  }
  return { observations: written, summaryId: id };
}

/** Sessions that never got a session-end (a crash, a closed window): distill them and mark them ended. */
export function distillStaleSessions(store: Store, exceptId: string, now = Date.now(), max = 5): number {
  const cutoff = new Date(now - STALE_SESSION_MS).toISOString();
  const rows = store
    .captureDb()
    .prepare(
      `SELECT s.id, (SELECT MAX(at) FROM capture_events e WHERE e.session_id = s.id) AS last FROM sessions s
       WHERE s.ended_at IS NULL AND s.id <> ? AND COALESCE((SELECT MAX(at) FROM capture_events e WHERE e.session_id = s.id), s.started_at) < ?
       LIMIT ?`
    )
    .all(exceptId, cutoff, max) as Array<{ id: string; last: string | null }>;
  for (const r of rows) {
    distillSession(store, r.id);
    store.captureDb().prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(r.last ?? cutoff, r.id);
  }
  return rows.length;
}
