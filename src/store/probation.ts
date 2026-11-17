// Writer probation (PLAN D, 1.6). A writer Monomem has not seen before (a new app key label, or a new `stdio:<app>` name)
// starts on probation: its notes show at once, labelled `[new writer]`, and they are not a second source: its confirm of
// someone else's note does not count, and `monomem facts` does not count it as a writer agreeing. It leaves probation when
// it has `probation-notes` notes that stayed for `probation-hours` without being replaced, archived or flagged, or when a
// person runs `monomem trust confirm-writer <name>`. Label only: nothing is held or hidden because of it.
// Writers that already had notes when this table was first made (the upgrade) are grandfathered. The person (cli), the
// owner's main key ("primary", as for the flood guard) and plain markers (stdio, server, ...) are never on probation. Nor is
// an app the person connected with `monomem setup` / `connect`: `stdio:<app>` where <app> is the MONOMEM_CLIENT name setup
// wrote, read from setup-history.json in the store's folder (undone sessions do not count). That name is declared by the
// app's config file, not verified; probation is for writers nobody set up: unknown app names and new app keys.
// Only notes a writer CREATED and kept count toward leaving probation (editing other writers' notes does not).
// Storage: its own side table `writer_probation`, made on the first write after upgrade (no schema bump).
// Free functions over the Store. Imports `type { Store }` only.

import type { NoteRecord, NoteRow, Store } from "../store.js";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { actorStore } from "../actor.js";
import { DATA_DIR } from "../config.js";
import { ValidationError } from "../errors.js";

export const DEFAULT_PROBATION_NOTES = 5;
export const DEFAULT_PROBATION_HOURS = 24;
const MAX_PROBATION_NOTES = 1000;
const MAX_PROBATION_HOURS = 24 * 90;
export const NEW_WRITER_LABEL = "[new writer]";

const TABLE = `CREATE TABLE IF NOT EXISTS writer_probation (
  writer TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  state TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
)`;

export interface ProbationSettings { notes: number; hours: number }
export interface ProbationRow { writer: string; first_seen_at: string; state: "probation" | "grandfathered" | "confirmed"; kept: number; on_probation: boolean; decided_by?: string }

const cache = new WeakMap<Store, { at: number; set: Set<string> }>();
const tableSeen = new WeakMap<Store, boolean>();

function hasTable(s: Store): boolean {
  if (tableSeen.get(s)) return true;
  const yes = s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'writer_probation'").get() !== undefined;
  // Remembered only outside a transaction: a table made inside one is gone again if it rolls back.
  if (yes && !s.db.isTransaction) tableSeen.set(s, true);
  return yes;
}

const connected = new Map<string, { key: string; apps: Set<string> }>();

/**
 * The `stdio:<app>` writers the person connected with setup / connect: setup-history.json in the store's folder (the
 * data folder for an in-memory store), the client of each change in a session not undone. A folder's .mcp.json ("project")
 * is Claude Code's, as setup labels it. Re-read when the file changes.
 */
function connectedApps(s: Store): Set<string> {
  const main = (s.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find((d) => d.name === "main")?.file;
  const f = join(main ? dirname(main) : DATA_DIR, "setup-history.json");
  let key: string;
  try {
    const st = statSync(f);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return new Set();
  }
  const c = connected.get(f);
  if (c?.key === key) return c.apps;
  const apps = new Set<string>();
  try {
    const all = JSON.parse(readFileSync(f, "utf8")) as Array<{ undone?: boolean; changes?: Array<{ client?: unknown }> }>;
    for (const sess of Array.isArray(all) ? all : []) {
      if (sess?.undone) continue;
      for (const ch of Array.isArray(sess?.changes) ? sess.changes : []) {
        if (typeof ch?.client !== "string" || ch.client === "shortcut" || ch.client === "git-hook") continue;
        apps.add(`stdio:${ch.client === "project" ? "claude-code" : ch.client}`);
      }
    }
  } catch (e) {
    process.stderr.write(`monomem: could not read ${f} (${(e as Error).message}); apps connected by setup start on probation
`);
  }
  connected.set(f, { key, apps });
  return apps;
}

export function probationSettings(s: Store): ProbationSettings {
  const n = Number(s.getMeta("probation_notes"));
  const h = Number(s.getMeta("probation_hours"));
  return {
    notes: s.getMeta("probation_notes") !== null && Number.isInteger(n) && n >= 0 && n <= MAX_PROBATION_NOTES ? n : DEFAULT_PROBATION_NOTES,
    hours: Number.isInteger(h) && h >= 1 && h <= MAX_PROBATION_HOURS ? h : DEFAULT_PROBATION_HOURS,
  };
}

export function setProbationSettings(s: Store, next: { notes?: number; hours?: number }): ProbationSettings {
  if (next.notes !== undefined && !(Number.isInteger(next.notes) && next.notes >= 0 && next.notes <= MAX_PROBATION_NOTES)) {
    throw new ValidationError(`probation-notes must be a whole number from 0 (off) to ${MAX_PROBATION_NOTES}`);
  }
  if (next.hours !== undefined && !(Number.isInteger(next.hours) && next.hours >= 1 && next.hours <= MAX_PROBATION_HOURS)) {
    throw new ValidationError(`probation-hours must be a whole number from 1 to ${MAX_PROBATION_HOURS}`);
  }
  if (next.notes !== undefined) s.setMeta("probation_notes", String(next.notes));
  if (next.hours !== undefined) s.setMeta("probation_hours", String(next.hours));
  cache.delete(s);
  const after = probationSettings(s);
  s.audit({ op: "probation-settings", detail: `notes ${after.notes}, hours ${after.hours}` });
  return after;
}

/** True when this write's writer is one probation can apply to: an app key (not the owner's main key) or a named stdio app. */
function candidate(writer: string): boolean {
  const a = actorStore.getStore();
  if (a?.authed === true) return a.label !== "primary";
  return writer.startsWith("stdio:");
}

/** A candidate the person did not connect with setup (see connectedApps). */
function probationApplies(s: Store, writer: string): boolean {
  return !(writer.startsWith("stdio:") && connectedApps(s).has(writer));
}

/**
 * Called by create() inside its write transaction, BEFORE the note row is inserted. The first call on a store makes the table
 * and grandfathers every writer that already has notes (so the upgrade puts nobody on probation), then records this writer.
 */
export function noteWriterSeen(s: Store, writer: string, at: string): void {
  if (!writer || !candidate(writer) || !probationApplies(s, writer)) return;
  if (!hasTable(s)) {
    s.db.exec(TABLE);
    s.db
      .prepare(
        `INSERT OR IGNORE INTO writer_probation (writer, first_seen_at, state)
         SELECT w, ?, 'grandfathered' FROM (SELECT written_by AS w FROM notes UNION SELECT created_by FROM notes) WHERE w <> ''`
      )
      .run(at);
  }
  const r = s.db.prepare("INSERT OR IGNORE INTO writer_probation (writer, first_seen_at, state) VALUES (?, ?, 'probation')").run(writer, at);
  if (Number(r.changes) > 0) cache.delete(s);
}

/** Notes this writer created that stayed `hours` without being replaced, archived or flagged (editing others' notes does not count). */
function keptNotes(s: Store, writer: string, hours: number): number {
  const before = new Date(Date.now() - hours * 3_600_000).toISOString();
  return Number(
    (
      s.db
        .prepare(
          `SELECT COUNT(*) AS c FROM notes n WHERE n.created_by = ? AND n.created_at <= ? AND n.archived_at IS NULL AND n.superseded_by IS NULL
             AND NOT EXISTS (SELECT 1 FROM note_flags f WHERE f.note_id = n.id AND f.cleared_at IS NULL)`
        )
        .get(writer, before) as { c: number }
    ).c
  );
}

/** Writers on probation right now. Re-read at most once a second (graduation by kept notes is time-based). */
export function probationSet(s: Store): Set<string> {
  const c = cache.get(s);
  if (c && Date.now() - c.at < 1000) return c.set;
  const set = new Set<string>();
  const cfg = probationSettings(s);
  if (cfg.notes > 0 && hasTable(s)) {
    const rows = s.db.prepare("SELECT writer FROM writer_probation WHERE state = 'probation'").all() as Array<{ writer: string }>;
    for (const r of rows) if (probationApplies(s, r.writer) && keptNotes(s, r.writer, cfg.hours) < cfg.notes) set.add(r.writer);
  }
  cache.set(s, { at: Date.now(), set });
  return set;
}

export function onProbation(s: Store, writer: string): boolean {
  return !!writer && probationSet(s).has(writer);
}

/** rec(): `new_writer` and its label on a note whose writer is on probation; other notes keep their exact shape. */
export function annotateProbation(s: Store, row: NoteRow, out: NoteRecord): NoteRecord {
  if (row.archived_at || !onProbation(s, row.written_by ?? "")) return out;
  out.new_writer = true;
  out.new_writer_label = NEW_WRITER_LABEL;
  return out;
}

/** `monomem trust confirm-writer <name>`: a person ends a writer's probation. Null when Monomem has never seen that writer. */
export function confirmWriter(s: Store, writer: string, by: string): ProbationRow | null {
  if (!hasTable(s)) return null;
  const r = s.db.prepare("UPDATE writer_probation SET state = 'confirmed', decided_at = ?, decided_by = ? WHERE writer = ?").run(new Date().toISOString(), by, writer);
  if (!Number(r.changes)) return null;
  cache.delete(s);
  s.audit({ op: "confirm-writer", detail: writer });
  return probationList(s).find((x) => x.writer === writer) ?? null;
}

/** Every writer Monomem has recorded, with its state and kept-note count. */
export function probationList(s: Store): ProbationRow[] {
  if (!hasTable(s)) return [];
  const cfg = probationSettings(s);
  const on = probationSet(s);
  const rows = s.db.prepare("SELECT writer, first_seen_at, state, decided_by FROM writer_probation ORDER BY first_seen_at, writer").all() as Array<{ writer: string; first_seen_at: string; state: ProbationRow["state"]; decided_by: string | null }>;
  return rows.map((r) => ({
    writer: r.writer,
    first_seen_at: r.first_seen_at,
    state: r.state,
    kept: keptNotes(s, r.writer, cfg.hours),
    on_probation: on.has(r.writer),
    ...(r.decided_by ? { decided_by: r.decided_by } : {}),
  }));
}
