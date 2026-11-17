// The trust layer (1.5.0 store split, moved out of store.ts): writer ids, the distrust list and its log, the trust view, the
// distrusted marks, and sensitivity labels for new and relabelled notes. Free functions over the Store; Store keeps a
// one-line delegate for each and every cache. Imports `type { Store }` only.

import type { NoteRecord, Store } from "../store.js";
import { actorStore, currentActor, currentCeiling, currentWriter } from "../actor.js";
import { ValidationError } from "../errors.js";
import { DEFAULT_SENSITIVITY, SENSITIVITY_HELP, levelsAtOrBelow, parseSensitivity, sensitivityRank, sensitivityVisible, type Sensitivity } from "../sensitivity.js";
import { ALL_NAMESPACES, MAX_DISTRUST_RULES, MAX_DISTRUST_RULES_PER_NAMESPACE, MAX_TRUST_LOG_ROWS, MAX_TRUST_LOG_ROWS_GLOBAL, NOTE_COLUMNS, canonicalRuleWriter, distrustSql, makeWriterId, matchesDistrust, type DistrustRule, type WriterFacts } from "../trust.js";
import { clampInt } from "./rows.js";

export function serverId(s: Store): string {
  return s.serverIdValue || (s.serverIdValue = s.storeId());
}

export function writerId(s: Store, label: string): string {
  return makeWriterId(s.serverId(), label);
}

/** Who is changing the trust configuration right now, for the log. */
export function trustActor(s: Store): string {
  return currentWriter() || currentActor() || "unknown";
}

export function logTrust(s: Store, action: string, namespace: string, subject: string): void {
  const actor = s.trustActor();
  s.db
    .prepare("INSERT INTO trust_log (at, actor, action, namespace, subject) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), actor, action, namespace, subject);
  s.pruneTrustLog(namespace);
  s.audit({ op: `trust.${action}`, namespace, label: actor, kind: "trust", detail: subject.slice(0, 200) });
}

/**
 * Bounded per namespace: each namespace keeps its own newest MAX_TRUST_LOG_ROWS rows (the server-wide lines, namespace `*`,
 * their own bucket of MAX_TRUST_LOG_ROWS_GLOBAL), so a pinned admin flooding its own namespace can only push out its own lines,
 * never another admin's or the attester / key-rotation lines. The audit log keeps the full trail.
 */
export function pruneTrustLog(s: Store, namespace: string): void {
  const keep = namespace === ALL_NAMESPACES ? MAX_TRUST_LOG_ROWS_GLOBAL : MAX_TRUST_LOG_ROWS;
  s.db
    .prepare("DELETE FROM trust_log WHERE namespace = ? AND seq NOT IN (SELECT seq FROM trust_log WHERE namespace = ? ORDER BY seq DESC LIMIT ?)")
    .run(namespace, namespace, keep);
}

export function distrustRules(s: Store): DistrustRule[] {
  return s.db
    .prepare("SELECT namespace, writer, added_at, added_by FROM trust_distrust ORDER BY namespace, writer")
    .all() as unknown as DistrustRule[];
}

export function distrustAdd(s: Store, namespace: string, writer: string): DistrustRule {
  const ns = typeof namespace === "string" ? namespace.trim() : "";
  if (!ns) throw new ValidationError('namespace is required (use "*" for every namespace)');
  if (ns.length > 200) throw new ValidationError("namespace is too long");
  const parsed = canonicalRuleWriter(writer);
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const canonical = parsed.writer;
  const addedBy = s.trustActor();
  const at = new Date().toISOString();
  s.transaction(() => {
    const have = s.db.prepare("SELECT 1 FROM trust_distrust WHERE namespace = ? AND writer = ?").get(ns, canonical);
    if (have) return;
    const perNs = Number((s.db.prepare("SELECT COUNT(*) AS c FROM trust_distrust WHERE namespace = ?").get(ns) as { c: number }).c);
    if (perNs >= MAX_DISTRUST_RULES_PER_NAMESPACE) {
      throw new ValidationError(`the distrust list for ${ns === "*" ? "the * bucket" : `namespace ${ns}`} is full (${MAX_DISTRUST_RULES_PER_NAMESPACE} entries); remove one first`);
    }
    const n = Number((s.db.prepare("SELECT COUNT(*) AS c FROM trust_distrust").get() as { c: number }).c);
    if (n >= MAX_DISTRUST_RULES) throw new ValidationError(`the distrust list is full (${MAX_DISTRUST_RULES} entries); remove one first`);
    // Namespace-specific rules may not use the room reserved for the `*` bucket, so ten namespaces
    // (or ten pinned admins) cannot lock the server-wide admin out of adding a `*` rule.
    if (ns !== ALL_NAMESPACES && n >= MAX_DISTRUST_RULES - MAX_DISTRUST_RULES_PER_NAMESPACE) {
      throw new ValidationError(`the distrust list is full for namespace-specific entries (${MAX_DISTRUST_RULES - MAX_DISTRUST_RULES_PER_NAMESPACE}; the rest is kept for "*" entries); remove one first`);
    }
    s.db.prepare("INSERT INTO trust_distrust (namespace, writer, added_at, added_by) VALUES (?, ?, ?, ?)").run(ns, canonical, at, addedBy);
    s.logTrust("distrust", ns, canonical);
  });
  return (s.db.prepare("SELECT namespace, writer, added_at, added_by FROM trust_distrust WHERE namespace = ? AND writer = ?").get(ns, canonical) as unknown) as DistrustRule;
}

export function distrustMatchCount(s: Store, namespace: string, writer: string): number {
  const parsed = canonicalRuleWriter(writer);
  if (!parsed.ok) return 0;
  const rule: DistrustRule = { namespace, writer: parsed.writer, added_at: "", added_by: "" };
  const d = distrustSql([rule], s.serverId(), NOTE_COLUMNS);
  if (!d.sql) return 0;
  const nsSql = namespace === ALL_NAMESPACES ? "" : " AND notes.namespace = ?";
  const nsParams = namespace === ALL_NAMESPACES ? [] : [namespace];
  const all = Number((s.db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE 1 = 1${nsSql}${s.ceilingSql("notes.sensitivity")}`).get(...nsParams) as { c: number }).c);
  const visible = Number((s.db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE 1 = 1${nsSql}${d.sql}${s.ceilingSql("notes.sensitivity")}`).get(...nsParams, ...d.params) as { c: number }).c);
  return all - visible;
}

export function distrustRemove(s: Store, namespace: string, writer: string): boolean {
  const ns = typeof namespace === "string" ? namespace.trim() : "";
  const parsed = canonicalRuleWriter(writer);
  if (!ns || !parsed.ok) throw new ValidationError("namespace and writer are required");
  const canonical = parsed.writer;
  let removed = false;
  s.transaction(() => {
    removed = Number(s.db.prepare("DELETE FROM trust_distrust WHERE namespace = ? AND writer = ?").run(ns, canonical).changes) > 0;
    if (removed) s.logTrust("undistrust", ns, canonical);
  });
  return removed;
}

export function trustLog(s: Store, limit = 20, pinnedNamespace?: string): Array<{ at: string; actor: string; action: string; namespace: string; subject: string }> {
  const n = clampInt(limit, 20, 1, 200);
  return (
    pinnedNamespace === undefined
      ? s.db.prepare("SELECT at, actor, action, namespace, subject FROM trust_log ORDER BY seq DESC LIMIT ?").all(n)
      : s.db
          .prepare(
            `SELECT at, actor, action, namespace, subject FROM trust_log
             WHERE (namespace = ? OR namespace = '*') AND action NOT LIKE 'attester-%' AND action <> 'key-rotate' ORDER BY seq DESC LIMIT ?`
          )
          .all(pinnedNamespace, n)
  ) as unknown as Array<{ at: string; actor: string; action: string; namespace: string; subject: string }>;
}

export function trustView(s: Store, pinnedNamespace?: string): {
    distrust: DistrustRule[];
    attesters: ReturnType<Store["attesterList"]>;
    revoked: ReturnType<Store["revocationList"]>;
    log: ReturnType<Store["trustLog"]>;
  } {
  const pinned = pinnedNamespace !== undefined;
  return {
    distrust: s.distrustRules().filter((r) => !pinned || r.namespace === pinnedNamespace || r.namespace === ALL_NAMESPACES),
    attesters: pinned ? [] : s.attesterList(),
    revoked: pinned ? [] : s.revocationList(),
    log: s.trustLog(20, pinnedNamespace),
  };
}

export function isDistrusted(s: Store, n: WriterFacts): boolean {
  return matchesDistrust(s.distrustRules(), n, s.serverId());
}

export function isDistrustedWith(s: Store, rules: readonly DistrustRule[], serverId: string, n: WriterFacts): boolean {
  return matchesDistrust(rules, n, serverId);
}

export function markDistrusted<T extends NoteRecord>(s: Store, notes: T[]): T[] {
  const rules = s.distrustRules();
  if (rules.length === 0) return notes;
  const id = s.serverId();
  return notes.map((n) => (matchesDistrust(rules, n, id) ? { ...n, distrusted: true as const } : n));
}

export function labelledAboveDefault(s: Store): number {
  return Number((s.db.prepare("SELECT COUNT(*) AS c FROM notes WHERE sensitivity <> ?").get(DEFAULT_SENSITIVITY) as { c: number }).c);
}

export function hasPrivateNotes(s: Store): boolean {
  return !!s.db.prepare("SELECT 1 FROM notes WHERE sensitivity = 'private' LIMIT 1").get();
}

export function hiddenFromCaller(s: Store, id: number): boolean {
  if (currentCeiling() === undefined) return false;
  const row = s.db.prepare("SELECT sensitivity FROM notes WHERE id = ?").get(id) as { sensitivity: string } | undefined;
  return !!row && s.hiddenByCeiling(row);
}

/** By-id guard for the write/move paths that touch a row without reading it first: true when the caller may not see note `id`. */
export function idHidden(s: Store, id: number): boolean {
  if (currentCeiling() === undefined) return false;
  const row = s.db.prepare("SELECT sensitivity FROM notes WHERE id = ?").get(id) as { sensitivity: string } | undefined;
  return !row || s.hiddenByCeiling(row);
}

/** The label a new note gets: the one asked for (checked against the ceiling), else "internal" -- or the ceiling itself when that is lower. */
export function labelForNew(s: Store, raw: unknown): Sensitivity {
  const max = currentCeiling();
  if (raw === undefined || raw === null) {
    if (max === undefined) return DEFAULT_SENSITIVITY;
    const levels = levelsAtOrBelow(max);
    if (levels.length === 0) throw new ValidationError("this token's sensitivity ceiling is not a valid label, so it cannot write");
    return levels.includes(DEFAULT_SENSITIVITY) ? DEFAULT_SENSITIVITY : levels[levels.length - 1];
  }
  const label = parseSensitivity(raw);
  if (!label) throw new ValidationError(`sensitivity must be ${SENSITIVITY_HELP}`);
  if (!sensitivityVisible(label, max)) {
    throw new ValidationError(`this token cannot write a "${label}" note: its sensitivity ceiling is "${String(max)}"`);
  }
  return label;
}

/** A relabel of an existing note: undefined when nothing changes; otherwise the new label, after the ceiling and declassify checks. */
export function labelForRelabel(s: Store, raw: unknown, current: string | undefined): Sensitivity | undefined {
  const label = parseSensitivity(raw);
  if (!label) throw new ValidationError(`sensitivity must be ${SENSITIVITY_HELP}`);
  const max = currentCeiling();
  if (!sensitivityVisible(label, max)) {
    throw new ValidationError(`this token cannot label a note "${label}": its sensitivity ceiling is "${String(max)}"`);
  }
  const now = current ?? DEFAULT_SENSITIVITY;
  if (label === now) return undefined;
  if (sensitivityRank(label) < sensitivityRank(now) && actorStore.getStore()?.canDeclassify === false) {
    throw new ValidationError("lowering a note's sensitivity label needs an admin key (raising it does not)");
  }
  return label;
}
