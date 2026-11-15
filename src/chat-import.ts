// `monomem import --from claude-code-chats`: past Claude Code conversations become searchable notes.
//
// Reads ~/.claude/projects/<project>/<session>.jsonl on THIS machine only (read only; nothing is sent anywhere). Keeps
// what you typed and what Claude answered in plain text. Leaves out tool calls, tool results, thinking, meta lines,
// subagent (sidechain) turns, slash commands and <system-reminder> blocks.
//
// One note per message. Each note also carries the message it replied to, cut to REPLY_CONTEXT_CHARS, because the
// question and its answer are usually in two different messages ("which port?" ... "9443"): a search for the question's
// words then finds the answer too. Measured on LoCoMo-10 by turn (docs/BENCHMARK.md): the retrieval benchmark builds its
// notes with this same chatNotes(), so the benchmark scores exactly what this import stores. The message AFTER was
// tried too and made results worse, so it is not added.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MODEL_WRITTEN_TAG } from "./reserved-tags.js";
import type { Item } from "./foreign-import.js";

/**
 * Every imported chat message carries it (the import's own tag, so a note someone tagged plain "chat" is not affected);
 * session start leaves these notes out (context-inject.ts), search finds them. Equals foreign-import's tagFor(source).
 */
export const CHAT_TAG = "imported:claude-code-chats";
/** How much of the replied-to message a note carries. */
export const REPLY_CONTEXT_CHARS = 400;
const TITLE_CHARS = 120;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_SESSIONS = 20_000;

export interface ChatMessage {
  id: string;
  speaker: string;
  text: string;
  at?: string;
}

export interface ChatNote {
  id: string;
  title: string;
  body: string;
  at?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One note per non-empty message: its own text, then "(replying to <speaker>: <their text>)". */
export function chatNotes(messages: readonly ChatMessage[]): ChatNote[] {
  const kept = messages.map((m) => ({ ...m, text: m.text.trim() })).filter((m) => m.text);
  return kept.map((m, i) => {
    const prev = kept[i - 1];
    const firstLine = m.text.split("\n").find((l) => l.trim()) ?? "";
    const title = clip(oneLine(`${m.speaker}: ${firstLine}`), TITLE_CHARS - 1);
    const body = prev ? `${m.text}\n\n(replying to ${prev.speaker}: ${clip(oneLine(prev.text), REPLY_CONTEXT_CHARS)})` : m.text;
    return { id: m.id, title, body, ...(m.at ? { at: m.at } : {}) };
  });
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The plain text of a message's content (a string, or the "text" parts of a list). Tool results and calls give "". */
function textOf(content: unknown): string {
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => (p as Rec)?.type === "text").map((p) => str((p as Rec).text)).join("\n") : "";
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

/** One session file: what you typed and Claude's replies (an answer split over several records is joined). */
export function readChatSession(path: string, stats?: ChatStats): ChatMessage[] {
  if (statSync(path).size > MAX_SESSION_BYTES) {
    if (stats) stats.tooBig++;
    return [];
  }
  const out: ChatMessage[] = [];
  let lastRequest = "";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r: Rec;
    try {
      r = JSON.parse(line) as Rec;
    } catch {
      if (stats) stats.badLines++; // a damaged line (a crash mid-write): skip it
      continue;
    }
    if ((r.type !== "user" && r.type !== "assistant") || r.isMeta || r.isSidechain) continue;
    const text = textOf((r.message as Rec | undefined)?.content);
    if (!text) continue;
    const uuid = str(r.uuid);
    const at = str(r.timestamp) || undefined;
    if (r.type === "assistant") {
      const req = str(r.requestId);
      const last = out[out.length - 1];
      if (req && req === lastRequest && last?.speaker === "Claude") {
        last.text += `\n${text}`;
        continue;
      }
      lastRequest = req;
      out.push({ id: uuid || `n${out.length}`, speaker: "Claude", text, at });
    } else {
      lastRequest = "";
      out.push({ id: uuid || `n${out.length}`, speaker: "You", text, at });
    }
  }
  return out;
}

/** Every session under `root` (~/.claude/projects): one Item per message, grouped by project folder. */
/** What a dry run reports beside the counts: files skipped for size, lines that could not be read. */
export interface ChatStats {
  sessions: number;
  tooBig: number;
  badLines: number;
}

export function readClaudeCodeChats(root: string, stats: ChatStats = { sessions: 0, tooBig: 0, badLines: 0 }): Item[] {
  const items: Item[] = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      if (++stats.sessions > MAX_SESSIONS) throw new Error(`more than ${MAX_SESSIONS} session files`);
      const session = basename(f.name, ".jsonl");
      const messages = readChatSession(join(dir, f.name), stats);
      const speakerOf = new Map(messages.map((m) => [m.id, m.speaker]));
      for (const n of chatNotes(messages)) {
        const byModel = speakerOf.get(n.id) === "Claude";
        items.push({
          id: `${session}:${n.id}`,
          group: project.name,
          title: n.title,
          body: n.body,
          tags: [CHAT_TAG, `chat.session:${session}`, ...(byModel ? [MODEL_WRITTEN_TAG] : [])],
          createdAt: n.at,
        });
      }
    }
  }
  return items;
}
