// `monomem import --from engram|agentmemory|ai-memory`: the rivals' own data, read-only and untrusted.
//   * engram       (github.com/Gentleman-Programming/engram): its SQLite file ($ENGRAM_DATA_DIR or ~/.engram/engram.db), or the
//                  JSON `engram export` writes ({ version, sessions, observations: [...], prompts }). Columns as in
//                  internal/store/store.go (observations: sync_id, type, title, content, project, scope, topic_key, created_at,
//                  deleted_at, superseded_by_sync_id). Deleted and superseded rows and the prompts are left out.
//   * agentmemory  (github.com/rohitg00/agentmemory): the JSON of GET /agentmemory/export ({ version, exportedAt, sessions,
//                  observations: { <sessionId>: [...] }, memories: [...], summaries: [...] }, src/types.ts ExportData).
//                  Old versions of a memory (isLatest false) are left out. Image fields and file paths are never read.
//   * ai-memory    (github.com/alphaonedev/ai-memory-mcp): the JSON of `ai-memory export` ({ memories: [...], links, count },
//                  src/models/memory.rs Memory). Its signed/governance rows are not in that export, so nothing here is "verified".
// Each reader returns plain Items. The writer the other tool names (agent id, ...) is kept only as a `claimed-writer:` tag: a
// claim, not an identity. Notes are written unconfirmed by runForeignImport, like every other foreign import.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Item } from "../foreign-import.js";

export const MAX_RIVAL_BYTES = 256 * 1024 * 1024;
export const MAX_RIVAL_ITEMS = 1_000_000;

/** What a read left out, for the dry-run summary. */
export interface RivalStats {
  /** Deleted, superseded or older-version rows. */
  skipped: number;
  /** The same title and text a second time (under another id). */
  duplicates: number;
}
export const newRivalStats = (): RivalStats => ({ skipped: 0, duplicates: 0 });

// NUL and other control characters (not tab, newline) are dropped: they are never text a person wrote.
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(CTRL, "").trim();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
const h = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const iso = (v: unknown): string | undefined => {
  const t = Date.parse(clean(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};
const claim = (who: unknown): string[] => (clean(who) ? [`claimed-writer:${clean(who).slice(0, 60)}`] : []);

function readJson(path: string, maxBytes: number): unknown {
  if (statSync(path).size > maxBytes) throw new Error(`larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

/** Drops empty items, repeated ids and repeated title+text; the second copy is counted, not imported. */
function finish(items: Item[], stats: RivalStats): Item[] {
  if (items.length > MAX_RIVAL_ITEMS) throw new Error(`more than ${MAX_RIVAL_ITEMS} items`);
  const ids = new Set<string>();
  const texts = new Set<string>();
  const out: Item[] = [];
  for (const it of items) {
    if (!it.title && !it.body) continue;
    const t = h(`${it.title}\u0000${it.body}`);
    if (ids.has(it.id) || texts.has(t)) {
      stats.duplicates++;
      continue;
    }
    ids.add(it.id);
    texts.add(t);
    out.push(it);
  }
  return out;
}

const firstLine = (s: string): string => s.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 200);

// ---- Engram ----------------------------------------------------------------------------------------------------------------

const toEngramItem = (r: Record<string, unknown>, i: number, stats: RivalStats): Item | null => {
  if (clean(r.deleted_at) || clean(r.superseded_by_sync_id)) {
    stats.skipped++;
    return null;
  }
  const body = clean(r.content);
  const title = clean(r.title) || firstLine(body);
  const topic = clean(r.topic_key);
  return {
    id: `obs:${clean(r.sync_id) || clean(r.id) || `h${h(title + body)}:${i}`}`,
    group: clean(r.project) || "engram",
    title,
    body,
    tags: [...(clean(r.type) ? [`engram-type:${clean(r.type)}`] : []), ...(clean(r.scope) ? [`engram-scope:${clean(r.scope)}`] : []), ...(topic ? [`topic:${topic}`] : [])],
    createdAt: iso(r.created_at),
  };
};

export function readEngram(path: string, stats: RivalStats = newRivalStats(), maxBytes = MAX_RIVAL_BYTES): Item[] {
  if (statSync(path).size > maxBytes) throw new Error(`larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
  let rows: Array<Record<string, unknown>>;
  if (isSqlite(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const cols = new Set((db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has("sync_id") || !cols.has("content")) throw new Error("this is not an Engram database (no observations table with sync_id and content)");
      const sel = ["id", "sync_id", "type", "title", "content", "project", "scope", "topic_key", "created_at", "deleted_at", "superseded_by_sync_id"].map((c) => (cols.has(c) ? c : `NULL AS ${c}`));
      rows = db.prepare(`SELECT ${sel.join(", ")} FROM observations ORDER BY id LIMIT ${MAX_RIVAL_ITEMS + 1}`).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } else {
    const j = readJson(path, maxBytes);
    if (!isObj(j) || !Array.isArray(j.observations)) throw new Error("this is not an Engram export (no \"observations\" list)");
    rows = j.observations.filter(isObj);
  }
  return finish(rows.map((r, i) => toEngramItem(r, i, stats)).filter((x): x is Item => !!x), stats);
}

// ---- agentmemory -----------------------------------------------------------------------------------------------------------

export function readAgentMemory(path: string, stats: RivalStats = newRivalStats(), maxBytes = MAX_RIVAL_BYTES): Item[] {
  const j = readJson(path, maxBytes);
  if (!isObj(j) || !(Array.isArray(j.memories) || isObj(j.observations) || Array.isArray(j.summaries))) throw new Error("this is not an agentmemory export (no memories, observations or summaries)");
  const items: Item[] = [];
  for (const [i, m] of (Array.isArray(j.memories) ? j.memories : []).entries()) {
    if (!isObj(m)) continue;
    if (m.isLatest === false) {
      stats.skipped++;
      continue;
    }
    const body = clean(m.content);
    items.push({
      id: `mem:${clean(m.id) || `h${h(body)}:${i}`}`,
      group: "memories",
      title: clean(m.title) || firstLine(body),
      body,
      tags: [...(clean(m.type) ? [`agentmemory-type:${clean(m.type)}`] : []), ...(clean(m.project) ? [`project:${clean(m.project)}`] : []), ...list(m.concepts).slice(0, 10).map((c) => `concept:${c}`), ...claim(m.agentId)],
      createdAt: iso(m.createdAt),
    });
  }
  if (isObj(j.observations)) {
    for (const [sid, obs] of Object.entries(j.observations)) {
      for (const [i, o] of (Array.isArray(obs) ? obs : []).entries()) {
        if (!isObj(o)) continue;
        const facts = list(o.facts).map((f) => `- ${f}`).join("\n");
        const body = [clean(o.subtitle), clean(o.narrative), facts].filter(Boolean).join("\n\n");
        items.push({
          id: `obs:${clean(o.id) || `${h(sid)}:${i}`}`,
          group: "observations",
          title: clean(o.title) || firstLine(body),
          body,
          tags: [...(clean(o.type) ? [`agentmemory-type:${clean(o.type)}`] : []), ...list(o.concepts).slice(0, 10).map((c) => `concept:${c}`), ...claim(o.agentId)],
          createdAt: iso(o.timestamp),
        });
      }
    }
  }
  for (const [i, s] of (Array.isArray(j.summaries) ? j.summaries : []).entries()) {
    if (!isObj(s)) continue;
    const dec = list(s.keyDecisions).map((d) => `- ${d}`).join("\n");
    const body = [clean(s.narrative), dec ? `Key decisions:\n${dec}` : ""].filter(Boolean).join("\n\n");
    items.push({ id: `sum:${clean(s.sessionId) || `h${h(body)}:${i}`}`, group: "summaries", title: clean(s.title) || firstLine(body), body, tags: clean(s.project) ? [`project:${clean(s.project)}`] : [], createdAt: iso(s.createdAt) });
  }
  return finish(items, stats);
}

// ---- ai-memory -------------------------------------------------------------------------------------------------------------

export function readAiMemory(path: string, stats: RivalStats = newRivalStats(), maxBytes = MAX_RIVAL_BYTES): Item[] {
  const j = readJson(path, maxBytes);
  const rows = isObj(j) ? j.memories : Array.isArray(j) ? j : undefined;
  if (!Array.isArray(rows)) throw new Error("this is not an ai-memory export (no \"memories\" list; make one with `ai-memory export > file.json`)");
  const now = Date.now();
  const items: Item[] = [];
  for (const [i, m] of rows.entries()) {
    if (!isObj(m)) continue;
    const exp = Date.parse(clean(m.expires_at));
    if (!Number.isNaN(exp) && exp < now) {
      stats.skipped++;
      continue;
    }
    const body = clean(m.content);
    const meta = isObj(m.metadata) ? m.metadata : {};
    items.push({
      id: clean(m.id) || `h${h(body)}:${i}`,
      group: clean(m.namespace) || "ai-memory",
      title: clean(m.title) || firstLine(body),
      body,
      tags: [...list(m.tags).slice(0, 20), ...(clean(m.tier) ? [`tier:${clean(m.tier)}`] : []), ...claim(meta.agent_id)],
      createdAt: iso(m.created_at),
    });
  }
  return finish(items, stats);
}

// ---- sniffing (import --auto) ----------------------------------------------------------------------------------------------

export function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(16);
    return readSync(fd, b, 0, 16, 0) === 16 && b.toString("latin1") === "SQLite format 3\u0000";
  } finally {
    closeSync(fd);
  }
}

export interface Sniffed {
  from: "engram" | "agentmemory" | "ai-memory" | "mem0" | "mcp-memory" | "claude-mem";
  why: string;
}

/** What a single FILE is, by its content (never its name). null when it is none of the known formats. */
export function sniffFile(path: string, maxBytes = MAX_RIVAL_BYTES): Sniffed | null {
  if (statSync(path).size > maxBytes) throw new Error(`larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
  if (isSqlite(path)) return sniffSqlite(path);
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return sniffJsonl(text);
  }
  if (Array.isArray(j)) return j.some((m) => isObj(m) && (typeof m.memory === "string" || typeof m.text === "string")) ? { from: "mem0", why: "a JSON list of memories with a memory/text field" } : null;
  if (!isObj(j)) return null;
  if (Array.isArray(j.entities) || Array.isArray(j.relations)) return { from: "mcp-memory", why: "an entities/relations graph" };
  const obs = j.observations;
  if (isObj(obs)) return { from: "agentmemory", why: "observations keyed by session id (agentmemory export)" };
  if (Array.isArray(obs) && obs.some((o) => isObj(o) && "sync_id" in o)) return { from: "engram", why: "observations with sync_id (Engram export)" };
  const mem = Array.isArray(j.memories) ? j.memories : Array.isArray(j.results) ? j.results : null;
  if (mem?.some((m) => isObj(m) && "tier" in m && "namespace" in m)) return { from: "ai-memory", why: "memories with tier and namespace (ai-memory export)" };
  if (mem?.some((m) => isObj(m) && (typeof m.memory === "string" || typeof m.text === "string"))) return { from: "mem0", why: "a memories/results list with a memory field (mem0 export)" };
  if (Array.isArray(j.memories) && j.memories.some((m) => isObj(m) && "isLatest" in m)) return { from: "agentmemory", why: "memories with isLatest (agentmemory export)" };
  return null;
}

function sniffJsonl(text: string): Sniffed | null {
  for (const line of text.split(/\r?\n/).slice(0, 50)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (isObj(o) && (o.type === "entity" || o.type === "relation")) return { from: "mcp-memory", why: "JSON lines of entity/relation records" };
    } catch {
      /* not a line of JSON */
    }
  }
  return null;
}

function sniffSqlite(path: string): Sniffed | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const cols = (t: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
    const o = cols("observations");
    if (o.has("sync_id") && o.has("content")) return { from: "engram", why: "SQLite file with an observations table (sync_id, content)" };
    if (o.has("memory_session_id") || cols("session_summaries").size) return { from: "claude-mem", why: "SQLite file with claude-mem's observations/session_summaries" };
    return null;
  } finally {
    db.close();
  }
}
