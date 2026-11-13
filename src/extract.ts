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
import { isOutsideTool, OTHER_TOOL, toolTag } from "./taint.js";

export const OBS_TYPES = ["bugfix", "feature", "refactor", "change", "discovery", "decision", "security_alert", "security_note"] as const;
export type ObsType = (typeof OBS_TYPES)[number];

/** The source label every capture-written note carries. */
export const CAPTURE_SOURCE = "monomem capture";
/** Events read per distill pass (a very long session is distilled over several stops). */
const BATCH = 2000;
/** An unfinished session with no event for this long is treated as ended (its process crashed or was closed). */
export const STALE_SESSION_MS = 30 * 60_000;

interface EventRow {
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
  for (const e of events) if ((e.event === "post-tool" || e.event === "post-tool-failure") && e.output && isOutsideTool(e.tool)) seen.add(toolTag(e.tool));
  return [...seen].sort().slice(0, MAX_ORIGIN_TOOLS);
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
  return (store.captureDb().prepare("SELECT id, namespace, cwd, distilled_seq, summary_note_id FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
}

/** Words the observation templates themselves add: not concepts. */
const TEMPLATE_WORDS = new Set(["fixed", "failing", "failed", "passes", "changes", "decision", "session", "request", "tests", "test", "edited", "file", "files", "memory", "kept", "appeared", "captured", "committed", "redacted", "stored", "work"]);

function tagsFor(kind: "observation" | "summary", type: string, text: string): string[] {
  const concepts = extractKeywords(text).map((k) => k.replace(/^#/, "")).filter((k) => !TEMPLATE_WORDS.has(k) && !/[/\\`]/.test(k));
  return [kind, `obs.type:${type}`, ...concepts.slice(0, 5).map((k) => `obs.concept:${k}`)];
}

/** Write one capture note; a write the linter holds or refuses is skipped (the linter doing its job), never thrown. */
function write(store: Store, s: SessionRow, kind: "observation" | "summary", type: string, title: string, body: string, files: Observation["files"], extraTags: string[] = []): NoteRecord | null {
  const attempt = (extra: string[]): NoteRecord => {
    const note = store.create(
      { namespace: s.namespace || DEFAULT_NAMESPACE, title, body, tags: [...tagsFor(kind, type, `${title} ${body}`), ...extra], source: CAPTURE_SOURCE },
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

/** Pure: the summary text of a whole session. Null when there is nothing worth summarizing. */
export function summarize(events: readonly EventRow[], cwd: string, observationTitles: readonly string[]): { title: string; body: string; files: Observation["files"] } | null {
  const prompts = events.filter((e) => e.event === "user-prompt" && e.input.trim());
  const tools = events.filter((e) => e.event === "post-tool" || e.event === "post-tool-failure");
  // A session needs something in it. "hi" with no tool calls was producing a
  // note titled "Session: hi" -- 3 of the 13 notes in the maintainer's own
  // store. Work done counts however short the prompt was; a prompt long enough
  // to be an instruction counts even with no tool calls.
  const didWork = tools.length > 0;
  const saidSomething = prompts.some((p) => stripNotUserWritten(p.input).trim().length >= MIN_PROMPT_CHARS);
  if (!didWork && !saidSomething) return null;
  const changed = new Set<string>();
  const read = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  let lastTest: { cmd: string; failed: boolean } | null = null;
  let editsSinceCommit = new Set<string>();
  for (const e of tools) {
    const p = field(e.input, "file_path") || field(e.input, "notebook_path") || (READ_TOOLS.has(e.tool) ? field(e.input, "path") : "");
    if (p && EDIT_TOOLS.has(e.tool) && e.ok) {
      changed.add(normPath(p, cwd));
      editsSinceCommit.add(normPath(p, cwd));
    } else if (p && READ_TOOLS.has(e.tool)) read.add(normPath(p, cwd));
    if (!e.ok) errors.push(`${e.tool}: ${one(e.output.split("\n").find((l) => l.trim()) ?? "", 160)}`);
    if (e.tool !== "Bash") continue;
    const cmd = field(e.input, "command");
    if (!cmd) continue;
    const isTest = TEST_CMD.test(cmd);
    const failed = isTest ? testFailed(e) : !e.ok;
    commands.push(`${failed ? "✗" : "✓"} ${one(cmd, 120)}`);
    if (isTest) lastTest = { cmd: one(cmd, 120), failed };
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) && e.ok) editsSinceCommit = new Set();
  }
  const request = prompts.length ? one(prompts[0].input, 300) : "";
  const lastWords = [...events].reverse().find((e) => (e.event === "stop" || e.event === "session-end") && e.input.trim());
  const outcome = [
    lastTest ? (lastTest.failed ? `tests failing (${lastTest.cmd})` : `tests passing (${lastTest.cmd})`) : "",
    commands.filter((c) => /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(c) && c.startsWith("✓")).length ? "changes committed" : "",
  ].filter(Boolean);
  const next = lastTest?.failed
    ? `Fix the failing \`${lastTest.cmd}\`.`
    : editsSinceCommit.size
      ? `Review and commit the changes to ${[...editsSinceCommit].slice(0, 5).join(", ")}.`
      : "";
  const uniq = (xs: string[], n: number): string[] => [...new Set(xs)].slice(0, n);
  const lines = [
    request && `Request: ${request}`,
    (observationTitles.length || lastWords) && `Done: ${[...observationTitles.slice(0, 10), lastWords ? one(lastWords.input, 300) : ""].filter(Boolean).join("; ")}`,
    changed.size && `Files changed: ${uniq([...changed], 30).join(", ")}`,
    read.size && `Files read: ${uniq([...read], 30).join(", ")}`,
    commands.length && `Commands: ${uniq(commands, 15).join(" | ")}`,
    errors.length && `Errors: ${uniq(errors, 5).join(" | ")}`,
    outcome.length && `Outcome: ${outcome.join(", ")}`,
    next && `Next step: ${next}`,
  ].filter(Boolean) as string[];
  const where = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return {
    title: `Session: ${request ? one(request, 80) : `work in ${where || "a project"}`}`,
    body: lines.join("\n"),
    files: [...[...changed].map((path) => ({ path, action: "changed" as const })), ...[...read].map((path) => ({ path, action: "read" as const }))],
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
  const all = eventsAfter(store, sessionId, 0, 20_000);
  const titles = store.list({ kinds: ["observation"], sessionId, limit: 50, order: "created_asc" }).notes.map((n) => n.title);
  const sum = summarize(all, s.cwd, titles);
  if (!sum) return { observations: written, summaryId: s.summary_note_id };
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
