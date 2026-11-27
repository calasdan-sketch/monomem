// `monomem import --from claude-mem|mem0|basic-memory|mcp-memory|codex|notion|engram|agentmemory|ai-memory`: bring another memory tool's notes into Monomem.
//
//   * claude-mem   (github.com/thedotmack/claude-mem): its SQLite database, ~/.claude-mem/claude-mem.db by default
//                  ($CLAUDE_MEM_DATA_DIR/claude-mem.db when set). Opened READ-ONLY. `observations` become rows of kind
//                  'observation' (obs_type = its type: bugfix, feature, decision, discovery, change, ...), with the files
//                  they read or changed; `session_summaries` become rows of kind 'summary'. Schema as created by its
//                  src/services/sqlite/SessionStore.ts; the columns added by later versions are read only when present.
//   * mem0         a JSON export: a list of memories, or { "results": [...] } / { "memories": [...] } as get_all returns,
//                  each with id, memory (or text), created_at, metadata (categories), user_id.
//   * basic-memory (github.com/basicmachines-co/basic-memory): a folder of Markdown files with front matter (title, type,
//                  permalink, tags) and Observations / Relations sections. One file = one note; the permalink is its id.
//   * mcp-memory   the official MCP memory server (@modelcontextprotocol/server-memory): its memory.jsonl knowledge graph,
//                  one JSON object per line, {"type":"entity","name","entityType","observations":[...]} or
//                  {"type":"relation","from","to","relationType"}. One entity = one note (observations as a list, its
//                  relations underneath); the entity name is its id. Its default file sits inside the npx cache (lost
//                  when that cache is cleaned), so without MEMORY_FILE_PATH or --path the npx caches are searched.
//   * codex        Codex's local memories (importers/codex.ts).   * notion   a Notion Markdown export (importers/notion.ts).
//
// Same rules as `import --claude` (claude-import.ts): local only, a dry run first, anything that looks like a secret is
// skipped and never shown, every write goes through Store.create (memory linter, quarantine), and the stable id of each item
// is kept in `source`, so running it again adds only what is new. Everything read is untrusted: claude-mem's rows were written
// by a model, so they also carry the model-written label (MODEL_WRITTEN_TAG). Every note is written held (outside: true):
// it waits, unconfirmed and out of session start, until a person confirms it (r3 security L6).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MODEL_WRITTEN_TAG } from "./reserved-tags.js";
import { chunkBody, looksLikeCredential, replyContextIsClean, MAX_FILE_BYTES, parseFrontmatter, readHeld, writeHeld } from "./claude-import.js";
import { lintContent } from "./lint.js";
import { readClaudeCodeChats, sealedChatNote, type ChatStats } from "./chat-import.js";
import { LIMITS, printable } from "./security.js";
import type { SetupEnv, SetupIO } from "./setup.js";
import { codexHome, readCodexMemories } from "./importers/codex.js";
import { readNotion } from "./importers/notion.js";
import { newRivalStats, readAgentMemory, readAiMemory, readEngram } from "./importers/rivals.js";
import { previewSample } from "./importers/preview.js";

export const FOREIGN_SOURCES = ["claude-mem", "mem0", "basic-memory", "mcp-memory", "claude-code-chats", "codex", "notion", "engram", "agentmemory", "ai-memory"] as const;
export type ForeignSource = (typeof FOREIGN_SOURCES)[number];

const MAX_JSON_BYTES = 256 * 1024 * 1024;
/** Imported conversations go here unless --namespace says otherwise, so they never crowd the notes your agents start with. */
export const CHATS_NAMESPACE = "chats";
const MAX_MD_FILES = 100_000;

export interface Item {
  /** Stable id of the item in the other tool: kept in `source` as `import:<tool>:<id>`. */
  id: string;
  /** Row label in the summary (project, user, folder). */
  group: string;
  title: string;
  body: string;
  tags: string[];
  createdAt?: string;
  kind?: "observation" | "summary";
  obsType?: string;
  sessionId?: string;
  files?: Array<{ path: string; action: "read" | "changed" }>;
}

const h = (s: string, n = 16): string => createHash("sha256").update(s).digest("hex").slice(0, n);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const tag = (t: string): string => t.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LIMITS.tagLen);
const firstLine = (s: string): string => s.trim().split("\n")[0].replace(/^#+\s*/, "").trim();
export const writerFor = (from: ForeignSource): string => `import:${from}`;
export const tagFor = (from: ForeignSource): string => `imported:${from}`;
/** A source key short enough for the held file (claude-import keeps keys under 100 chars). */
export function sourceFor(from: ForeignSource, id: string): string {
  const s = `import:${from}:${id}`;
  return s.length <= 90 && !/[\s\u0000-\u001f]/.test(s) ? s : `import:${from}:h${h(id)}`;
}

function isoFrom(epochMs: unknown, text: unknown): string | undefined {
  if (typeof epochMs === "number" && Number.isFinite(epochMs) && epochMs > 0) return new Date(epochMs).toISOString();
  const t = Date.parse(str(text));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function jsonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    return jsonList(JSON.parse(v));
  } catch {
    return [v.trim()];
  }
}

// ---- claude-mem ----------------------------------------------------------------------------------------------------------

export function defaultPath(from: ForeignSource, e: Pick<SetupEnv, "home" | "env">): string {
  if (from === "claude-mem") return join(e.env.CLAUDE_MEM_DATA_DIR || join(e.home, ".claude-mem"), "claude-mem.db");
  if (from === "basic-memory") return join(e.home, "basic-memory");
  if (from === "claude-code-chats") return join(e.env.CLAUDE_CONFIG_DIR || join(e.home, ".claude"), "projects");
  if (from === "codex") return codexHome(e);
  if (from === "engram") return join(e.env.ENGRAM_DATA_DIR?.trim() || join(e.home, ".engram"), "engram.db");
  if (from === "mcp-memory") {
    if (e.env.MEMORY_FILE_PATH) return resolve(e.env.MEMORY_FILE_PATH.replace(/^~(?=$|[\\/])/, e.home));
    const found = findMcpMemoryFiles(e);
    return found.length === 1 ? found[0] : "";
  }
  return "";
}

/** memory.jsonl (or the legacy memory.json) files of server-memory installs in the npx caches. */
export function findMcpMemoryFiles(e: Pick<SetupEnv, "home" | "env">): string[] {
  // npm's cache folder: npm_config_cache when set, else LOCALAPPDATA/npm-cache (Windows) or ~/.npm (macOS, Linux).
  const roots = [...(e.env.npm_config_cache ? [join(e.env.npm_config_cache, "_npx")] : []), join(e.env.LOCALAPPDATA || join(e.home, "AppData", "Local"), "npm-cache", "_npx"), join(e.home, ".npm", "_npx")];
  const out: string[] = [];
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      continue; // no npx cache here
    }
    for (const d of dirs.slice(0, 5000)) {
      for (const f of ["memory.jsonl", "memory.json"]) {
        const p = join(root, d, "node_modules", "@modelcontextprotocol", "server-memory", "dist", f);
        if (existsSync(p) && statSync(p).size > 0) out.push(p);
      }
    }
  }
  return out;
}

export function readClaudeMem(path: string): Item[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const cols = (t: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
    const pick = (have: Set<string>, want: string[]): string => want.map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(", ");
    const oc = cols("observations");
    const sc = cols("session_summaries");
    if (!oc.size && !sc.size) throw new Error("this is not a claude-mem database (no observations or session_summaries table)");
    const items: Item[] = [];
    const files = (read: unknown, changed: unknown): Item["files"] => [
      ...jsonList(changed).map((p) => ({ path: p, action: "changed" as const })),
      ...jsonList(read).map((p) => ({ path: p, action: "read" as const })),
    ];
    if (oc.size) {
      const sel = pick(oc, ["id", "memory_session_id", "project", "text", "type", "title", "subtitle", "facts", "narrative", "concepts", "files_read", "files_modified", "created_at", "created_at_epoch"]);
      for (const r of db.prepare(`SELECT ${sel} FROM observations ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
        const facts = jsonList(r.facts);
        const body = [str(r.subtitle), str(r.narrative), str(r.text), facts.length ? facts.map((f) => `- ${f}`).join("\n") : ""].map((s) => s.trim()).filter(Boolean).join("\n\n");
        const title = str(r.title).trim() || firstLine(body);
        if (!title && !body) continue;
        const type = str(r.type).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 40);
        const project = str(r.project) || "unknown";
        items.push({
          id: `obs:${str(r.id)}`,
          group: project,
          title: title.slice(0, 200),
          body,
          tags: ["observation", MODEL_WRITTEN_TAG, ...(type ? [`obs.type:${type}`] : []), `project:${project}`, ...jsonList(r.concepts).slice(0, 10).map((c) => `obs.concept:${c}`)],
          createdAt: isoFrom(r.created_at_epoch, r.created_at),
          kind: "observation",
          obsType: /^[a-z_]{1,40}$/.test(type) ? type : "",
          sessionId: r.memory_session_id ? `claude-mem:${str(r.memory_session_id)}`.slice(0, 200) : undefined,
          files: files(r.files_read, r.files_modified),
        });
      }
    }
    if (sc.size) {
      const sel = pick(sc, ["id", "memory_session_id", "project", "request", "investigated", "learned", "completed", "next_steps", "notes", "files_read", "files_edited", "created_at", "created_at_epoch"]);
      for (const r of db.prepare(`SELECT ${sel} FROM session_summaries ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
        const parts: Array<[string, unknown]> = [["Request", r.request], ["Investigated", r.investigated], ["Learned", r.learned], ["Completed", r.completed], ["Next steps", r.next_steps], ["Notes", r.notes]];
        const body = parts.filter(([, v]) => str(v).trim()).map(([k, v]) => `## ${k}\n${str(v).trim()}`).join("\n\n");
        if (!body) continue;
        const project = str(r.project) || "unknown";
        items.push({
          id: `sum:${str(r.id)}`,
          group: project,
          title: `Session summary: ${firstLine(str(r.request)) || project}`.slice(0, 200),
          body,
          tags: ["summary", MODEL_WRITTEN_TAG, "obs.type:session", `project:${project}`],
          createdAt: isoFrom(r.created_at_epoch, r.created_at),
          kind: "summary",
          sessionId: r.memory_session_id ? `claude-mem:${str(r.memory_session_id)}`.slice(0, 200) : undefined,
          files: files(r.files_read, r.files_edited),
        });
      }
    }
    return items;
  } finally {
    db.close();
  }
}

// ---- mem0 ----------------------------------------------------------------------------------------------------------------

export function readMem0(path: string): Item[] {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`larger than ${MAX_JSON_BYTES / 1024 / 1024} MiB`);
  const j = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  const o = j as { results?: unknown; memories?: unknown };
  const list = Array.isArray(j) ? j : Array.isArray(o?.results) ? o.results : Array.isArray(o?.memories) ? o.memories : null;
  if (!list) throw new Error("expected a JSON list of memories (or { \"results\": [...] })");
  const items: Item[] = [];
  list.forEach((m: Record<string, unknown>, i) => {
    if (!m || typeof m !== "object") return;
    const data = (m.data ?? {}) as Record<string, unknown>;
    const text = (str(m.memory) || str(m.text) || str(data.memory)).trim();
    if (!text) return;
    const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
    const user = str(m.user_id) || str(m.agent_id) || "mem0";
    const cats = [...jsonList(meta.categories), ...jsonList(m.categories)];
    items.push({
      id: str(m.id) || `h${h(text)}:${i}`,
      group: user,
      title: firstLine(text).slice(0, 200),
      body: text,
      tags: [...new Set(cats)].slice(0, 20).map((c) => `category:${c}`).concat(`mem0-user:${user}`),
      createdAt: isoFrom(undefined, m.created_at),
    });
  });
  return items;
}

// ---- basic-memory --------------------------------------------------------------------------------------------------------

/** `tags: [a, b]`, `tags: a, b` or a YAML list under `tags:`. */
function fmTags(text: string, inline: string | undefined): string[] {
  if (inline && inline.trim()) return inline.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const m = /^tags:[ \t]*\n((?:[ \t]*-[ \t]+.+\n?){1,100})/m.exec(text.replace(/\r\n?/g, "\n").split("\n---")[0]);
  return m ? m[1].split("\n").map((l) => l.replace(/^[ \t]*-[ \t]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
}

export function readBasicMemory(root: string): Item[] {
  const items: Item[] = [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || files.length >= MAX_MD_FILES) continue;
      const p = join(dir, name);
      const st = lstatSync(p); // links are not followed: the folder is read as it is
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && /\.md$/i.test(name) && st.size <= MAX_FILE_BYTES) files.push(p);
    }
  };
  walk(root);
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    const { fm, body } = parseFrontmatter(text);
    const clean = body.trim();
    if (!clean) continue;
    const rel = relative(root, p).split("\\").join("/");
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "(top)";
    const title = (fm.title || /^#{1,6}[ \t]+(.+)$/m.exec(clean)?.[1]?.trim() || basename(p).replace(/\.md$/i, "")).slice(0, 200);
    items.push({
      id: fm.permalink || rel.replace(/\.md$/i, ""),
      group: folder,
      title,
      body: clean,
      tags: [...fmTags(text, fm.tags), ...(fm.type ? [`bm-type:${fm.type}`] : [])],
      createdAt: isoFrom(undefined, fm.created) ?? statSync(p).mtime.toISOString(),
    });
  }
  return items;
}

// ---- mcp-memory (official MCP memory server) -----------------------------------------------------------------------------

const MAX_JSONL_LINES = 1_000_000;

/** Counts a dry run reports: relation lines read, and lines that could not be read (skipped). */
export interface McpStats {
  relations: number;
  badLines: number;
}

export function readMcpMemory(path: string, stats?: McpStats): Item[] {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`larger than ${MAX_JSON_BYTES / 1024 / 1024} MiB`);
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  type Rec = Record<string, unknown>;
  const entities: Rec[] = [];
  const relations: Rec[] = [];
  const take = (r: unknown): void => {
    if (!r || typeof r !== "object") return;
    const o = r as Rec;
    if (o.type === "relation") relations.push(o);
    else if (o.type === "entity") entities.push(o);
  };
  let whole: unknown = undefined;
  try {
    whole = JSON.parse(text); // an old export: { entities: [...], relations: [...] }
  } catch {
    /* JSONL: one object per line */
  }
  const w = whole as { entities?: unknown; relations?: unknown } | undefined;
  if (w && typeof w === "object" && (Array.isArray(w.entities) || Array.isArray(w.relations))) {
    for (const r of Array.isArray(w.entities) ? w.entities : []) take({ ...(r as Rec), type: "entity" });
    for (const r of Array.isArray(w.relations) ? w.relations : []) take({ ...(r as Rec), type: "relation" });
  } else {
    const lines = text.split(/\r?\n/);
    if (lines.length > MAX_JSONL_LINES) throw new Error(`more than ${MAX_JSONL_LINES} lines`);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        take(JSON.parse(line));
      } catch {
        /* a damaged line (the server keeps unreadable lines too): skip it */
        if (stats) stats.badLines++;
      }
    }
    if (!entities.length && !relations.length) throw new Error("this is not an MCP memory file (no entity or relation lines)");
  }
  if (stats) stats.relations = relations.length;
  const rels = new Map<string, string[]>();
  for (const r of relations) {
    const from = str(r.from).trim();
    const to = str(r.to).trim();
    const type = str(r.relationType).trim();
    if (!from || !to || !type) continue;
    rels.set(from, [...(rels.get(from) ?? []), `- ${type} ${to}`]);
    rels.set(to, [...(rels.get(to) ?? []), `- ${from} ${type} (this)`]);
  }
  const items: Item[] = [];
  for (const e of entities) {
    const name = str(e.name).trim();
    if (!name) continue;
    const obs = jsonList(e.observations).map((o) => `- ${o.trim()}`);
    const rl = rels.get(name) ?? [];
    const body = [obs.join("\n"), rl.length ? `Relations:\n${rl.join("\n")}` : ""].filter(Boolean).join("\n\n");
    if (!body) continue;
    const type = str(e.entityType).trim();
    items.push({
      id: `entity:${name}`,
      group: type || "entity",
      title: name.slice(0, 200),
      body,
      // The graph is written by AI agents through MCP tools: label it like other model-written imports.
      tags: [MODEL_WRITTEN_TAG, ...(type ? [`entity-type:${type}`] : [])],
    });
  }
  return items;
}

// ---- the command ---------------------------------------------------------------------------------------------------------

export interface ForeignImportOptions {
  from: ForeignSource;
  path?: string;
  dryRun: boolean;
  yes: boolean;
  namespace?: string;
  dbPath: string;
  /** import --auto: show sample titles and what the linter may hold, then write only with `yes`. */
  preview?: boolean;
}

interface Candidate {
  item: Item;
  title: string;
  body: string;
  tags: string[];
  source: string;
  secret: boolean;
  /** Lint categories other than secrets (injection, pii, ...): the linter may hold this note. */
  flags: string[];
}

function candidates(from: ForeignSource, items: Item[]): Candidate[] {
  const out: Candidate[] = [];
  for (const it of items) {
    const parts = chunkBody(it.body);
    parts.forEach((part, i) => {
      const title = (parts.length > 1 ? `${it.title} (part ${i + 1} of ${parts.length})` : it.title || "Untitled").slice(0, LIMITS.title);
      const tags = [...new Set([tagFor(from), ...it.tags.map(tag).filter(Boolean)])].slice(0, LIMITS.tagCount);
      const finds = lintContent({ title, body: part, tags });
      const secret = finds.some((f) => f.category === "secret" || f.category === "entropy") || looksLikeCredential(title + "\n" + part);
      out.push({ item: it, title, body: part, tags, source: sourceFor(from, parts.length > 1 ? `${it.id}#${i + 1}` : it.id), secret, flags: [...new Set(finds.filter((f) => f.category !== "secret" && f.category !== "entropy").map((f) => f.category))] });
    });
  }
  return out;
}

export async function runForeignImport(e: Pick<SetupEnv, "home" | "env" | "cwd">, io: SetupIO, opts: ForeignImportOptions): Promise<number> {
  const { from } = opts;
  const path = opts.path ? resolve(e.cwd, opts.path) : defaultPath(from, e);
  if (!path) {
    if (from === "mcp-memory") {
      const found = findMcpMemoryFiles(e);
      io.err(
        found.length
          ? `I found ${found.length} MCP memory files. Pick one with --path:\n${found.map((f) => `  ${f}`).join("\n")}`
          : "I found no MCP memory file in the npm cache folders (npm_config_cache, LOCALAPPDATA/npm-cache, ~/.npm). Set MEMORY_FILE_PATH or point --path at your memory.jsonl."
      );
      return 1;
    }
    io.err(from === "notion" ? "Name the Notion export (the .zip, or the folder you unzipped it to): monomem import --from notion --path <export.zip>" : `Name the ${from} export file: monomem import --from ${from} --path <file>`);
    return 1;
  }
  if (!existsSync(path)) {
    io.err(`I found nothing at ${path}. Use --path to point at the ${from === "basic-memory" ? "folder" : "file"}.`);
    return 1;
  }
  io.out(`Reading ${from} data from ${path} (read only; nothing leaves this computer):`);
  let items: Item[];
  const mcpStats: McpStats = { relations: 0, badLines: 0 };
  const chatStats: ChatStats = { sessions: 0, tooBig: 0, badLines: 0 };
  const zipStats = { skipped: 0 };
  const rivalStats = newRivalStats();
  try {
    items =
      from === "claude-mem" ? readClaudeMem(path) : from === "mem0" ? readMem0(path) : from === "mcp-memory" ? readMcpMemory(path, mcpStats) : from === "claude-code-chats" ? readClaudeCodeChats(path, chatStats, replyContextIsClean) : from === "engram" ? readEngram(path, rivalStats) : from === "agentmemory" ? readAgentMemory(path, rivalStats) : from === "ai-memory" ? readAiMemory(path, rivalStats) : from === "codex" ? readCodexMemories(path, MAX_FILE_BYTES, zipStats) : from === "notion" ? readNotion(path, MAX_FILE_BYTES, zipStats) : readBasicMemory(path);
  } catch (err) {
    io.err(`Could not read ${path}: ${(err as Error).message}`);
    return 1;
  }
  const cands = candidates(from, items);
  const { Store, SCHEMA_VERSION } = await import("./store.js");
  // Same as import --claude: look only at a current database; a missing or older one cannot hold an earlier import.
  const store = Store.peekSchemaVersion(opts.dbPath) === SCHEMA_VERSION ? new Store(opts.dbPath) : null;
  let writer: InstanceType<typeof Store> | null = store;
  try {
    const known = new Set<string>();
    for (let offset = 0; store; offset += 500) {
      const page = store.list({ withTags: [tagFor(from)], kinds: ["note", "observation", "summary"], limit: 500, offset, includeArchived: true, includeSuperseded: true });
      for (const n of page.notes) known.add(n.source);
      if (page.notes.length < 500) break;
    }
    const heldBefore = readHeld(opts.dbPath);
    const groups = new Map<string, { n: number; create: number; same: number; secrets: number }>();
    const todo: Candidate[] = [];
    let heldSkipped = 0;
    for (const c of cands) {
      const g = groups.get(c.item.group) ?? { n: 0, create: 0, same: 0, secrets: 0 };
      groups.set(c.item.group, g);
      g.n++;
      if (c.secret) g.secrets++;
      else if (known.has(c.source)) g.same++;
      else if (heldBefore.has(c.source)) heldSkipped++;
      else {
        g.create++;
        todo.push(c);
      }
    }
    io.out("");
    for (const [name, g] of groups) io.out(`  ${printable(name, 60).padEnd(30)} ${g.n} item(s): ${g.create} new, ${g.same} already imported, ${g.secrets} skipped (secret)`);
    const t = [...groups.values()].reduce((a, g) => ({ n: a.n + g.n, c: a.c + g.create, s: a.s + g.same, x: a.x + g.secrets }), { n: 0, c: 0, s: 0, x: 0 });
    io.out(`\n${t.n} item(s): ${t.c} new, ${t.s} already imported, ${t.x} skipped because they look like a secret.`);
    if (t.x && from === "claude-code-chats") io.out("  These messages contain a secret and were left out (not stored, not shown). The messages around them are kept.");
    else if (t.x) io.out("  Skipped items are not stored and not shown. Take the secret out at the source (or keep it in a password manager) and run again.");
    if (heldSkipped) io.out(`  ${heldSkipped} item(s) were held by the memory linter on an earlier run and are not queued again (see \`monomem review held\`).`);
    if (zipStats.skipped && from === "codex") io.out(`  ${zipStats.skipped} Codex memory file(s) skipped: larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB, or not a plain file.`);
    else if (zipStats.skipped) io.out(`  ${zipStats.skipped} Markdown file(s) skipped: larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB, encrypted, or packed in a way this reader does not know.`);
    if ((opts.dryRun || opts.preview) && from === "mcp-memory") previewMcp(io, todo, mcpStats);
    else previewSample(io, todo, rivalStats, opts.dryRun || !!opts.preview);
    if (from === "claude-code-chats") {
      io.out(`  Read ${chatStats.sessions} conversation file(s).${chatStats.tooBig ? ` ${chatStats.tooBig} skipped: larger than 256 MB.` : ""}${chatStats.badLines ? ` ${chatStats.badLines} damaged line(s) skipped.` : ""}`);
      io.out("  These notes go into the \"chats\" namespace (unless --namespace) and are never shown at session start; search finds them.");
    }
    if (opts.dryRun) {
      io.out("\nDry run: nothing was written.");
      return 0;
    }
    if (todo.length === 0) {
      io.out("\nNothing to import.");
      return 0;
    }
    if (!opts.yes && !io.interactive) {
      io.err("Not an interactive terminal, so I cannot ask: nothing was written. Re-run with --yes to import, or --dry-run to only look.");
      return 1;
    }
    if (!opts.yes) {
      const a = (await io.ask(`\nImport ${todo.length} note(s) into ${opts.dbPath}? Type y to continue: `)).trim().toLowerCase();
      if (a !== "y" && a !== "yes") {
        io.out("Cancelled. Nothing was written.");
        return 0;
      }
    }
    writer = writer ?? new Store(opts.dbPath);
    let created = 0;
    let held = 0;
    let failed = 0;
    const sealChats = from === "claude-code-chats" && writer.sealsWrites();
    for (const raw of todo) {
      const c = sealChats ? sealedChatNote(raw) : raw;
      const it = c.item;
      try {
        // ponytail: one write per item, no batching transaction; fine for tens of thousands of rows.
        const note = writer.create(
          { namespace: opts.namespace || (from === "claude-code-chats" ? CHATS_NAMESPACE : undefined), title: c.title, body: c.body, tags: c.tags, source: c.source, created_at: it.createdAt, outside: true },
          { writtenBy: writerFor(from), skipEdges: !!it.kind, ...(it.kind ? { kind: it.kind, sessionId: it.sessionId, obsType: it.obsType ?? "" } : {}) }
        );
        if (it.kind) writer.restoreCaptureLinks(note, it.files);
        created++;
      } catch (err) {
        if ((err as Error).constructor.name === "QuarantinedError") {
          held++;
          heldBefore.add(c.source);
        } else failed++;
      }
    }
    if (held) writeHeld(opts.dbPath, heldBefore);
    io.out(`\nImported ${created} new note(s). They are tagged "${tagFor(from)}" and written by "${writerFor(from)}".`);
    if (created) io.out("They are unconfirmed (from outside) until you confirm them; reading them does not confirm them. `monomem review` lists them, `monomem confirm <id>` confirms one.");
    if (held) io.out(`${held} item(s) were held by the memory linter (it saw something that reads like an instruction to an AI): see \`monomem review held\`.`);
    if (failed) {
      io.err(`${failed} item(s) could not be stored.`);
      return 1;
    }
    return 0;
  } finally {
    writer?.close();
    if (store && store !== writer) store.close();
  }
}

// Untrusted text: control characters and bidi marks neutralised before it reaches the terminal.
const clip = (t: string, n: number): string => printable(t, n);
const PREVIEW_ENTITIES = 10;

/** Dry run of an MCP memory file: what each entity would become (name and first observation), what was dropped, what the linter may hold. */
function previewMcp(io: SetupIO, todo: Candidate[], stats: McpStats): void {
  io.out(`\nPreview (first ${Math.min(PREVIEW_ENTITIES, todo.length)} of ${todo.length} new note(s)):`);
  for (const c of todo.slice(0, PREVIEW_ENTITIES)) {
    const first = c.body.split("\n").find((l) => l.startsWith("- "))?.slice(2) ?? "";
    io.out(`  ${clip(c.title, 40)}: ${clip(first, 60)}`);
  }
  io.out(`\n${stats.relations} relation line(s) read; ${stats.badLines} line(s) could not be read and are dropped.`);
  const flagged = todo.filter((c) => c.flags.length);
  if (flagged.length) {
    io.out(`${flagged.length} new note(s) would probably be held by the memory linter for your review:`);
    for (const c of flagged.slice(0, PREVIEW_ENTITIES)) io.out(`  ${clip(c.title, 40)}: ${printable(c.flags.join(", "))}`);
  }
}
