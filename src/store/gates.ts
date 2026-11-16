// Write gates (1.5.0 store split, moved out of store.ts): the flood guard (paused writers), approve-first namespaces, pinned
// notes, and the fail-closed reader for trust settings kept in _meta (metaJson / damagedTrustSettings). Free functions over the
// Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import type { LintMode, Store } from "../store.js";
import { cleanWriter, currentWriter } from "../actor.js";
import { ValidationError, WriterPausedError } from "../errors.js";
import { CONFIRM_MODES } from "../taint.js";
import { floodWritesPerHour, isOperatorWrite, isPlainObject, isStringArray } from "./rows.js";

export function pausedWriters(s: Store): string[] {
  return [...(s.metaJson("flood_paused", isStringArray).v ?? [])].sort();
}

/** A3: a damaged pause list pauses every writer the flood guard counts (the operator is never counted). */
export function isPaused(s: Store, w: string): boolean {
  const p = s.metaJson("flood_paused", isStringArray);
  return p.damaged || (p.v ?? []).includes(w);
}

export function resumeWriter(s: Store, label: string): boolean {
  const w = cleanWriter(label);
  if (!w) throw new ValidationError("writer label is required");
  // A3: a damaged list cannot say who else was paused: the operator's resume resets it (audited below).
  const damaged = s.metaJson("flood_paused", isStringArray).damaged;
  const all = s.pausedWriters();
  if (!damaged && !all.includes(w)) return false;
  s.transaction(() => {
    s.setMeta("flood_paused", JSON.stringify(damaged ? [] : all.filter((x) => x !== w)));
    // A fresh hour: otherwise its very next write would trip the guard again on the old count.
    s.db.prepare("DELETE FROM write_rate WHERE writer = ?").run(w);
  });
  s.audit({ op: "flood-resume", label: w });
  return true;
}

/** The identity the flood guard counts, or null for writes it leaves alone: see floodGate. */
export function floodSubject(s: Store, mode: LintMode): string | null {
  const w = currentWriter();
  return isOperatorWrite(mode) || w === "" || w === "server" ? null : w;
}

/** archive / restore: refused for a paused writer (they are not counted). */
export function refusePaused(s: Store): void {
  const w = s.floodSubject("full");
  if (w !== null && s.isPaused(w)) throw s.pausedError(w);
}

export function pausedError(s: Store, w: string): WriterPausedError {
  return new WriterPausedError(
    `writer "${w}" is paused by the flood guard (more than ${floodWritesPerHour()} writes in an hour). ` +
      `Its writes are refused until an operator runs: monomem resume ${w}`
  );
}

export function floodGate(s: Store, mode: LintMode, count = true): void {
  const w = s.floodSubject(mode);
  if (w === null) return;
  if (s.isPaused(w)) throw s.pausedError(w);
  const limit = floodWritesPerHour();
  if (limit === 0 || !count) return;
  const now = Date.now();
  // ponytail: count-then-insert is not atomic across processes; concurrent writers can overshoot by a few.
  const n = Number(
    (s.db.prepare("SELECT COUNT(*) AS n FROM write_rate WHERE writer = ? AND at >= ?").get(w, new Date(now - 3_600_000).toISOString()) as { n: number }).n
  );
  if (n >= limit) {
    // One statement, no transaction: a write can run inside a caller's transaction (which this throw rolls back, pause
    // included; the count stays, so the next write pauses it again).
    s.setMeta("flood_paused", JSON.stringify([...new Set([...s.pausedWriters(), w])].sort()));
    s.audit({ op: "flood-pause", label: w, detail: `${n} writes in the last hour (limit ${limit})` });
    console.error(`[monomem] flood guard: paused writer "${w}" after ${n} writes in an hour. Resume with: monomem resume ${w}`);
    throw s.pausedError(w);
  }
  s.db.prepare("INSERT INTO write_rate (writer, at) VALUES (?, ?)").run(w, new Date(now).toISOString());
  s.bookkeepingChanges += 1;
}

export function approveFirstNamespaces(s: Store): string[] {
  return [...(s.metaJson("approve_first", isStringArray).v ?? [])].sort();
}

export function approveFirstAll(s: Store): boolean {
  // A3: a damaged list cannot say which namespaces were approve-first: all of them are. Said here, so status, doctor and
  // GET /approve-first show what is enforced (release-gate S5), not "off".
  return s.getMeta("approve_first_all") === "1" || s.metaJson("approve_first", isStringArray).damaged;
}

export function isApproveFirst(s: Store, namespace: string): boolean {
  return s.approveFirstAll() || s.approveFirstNamespaces().includes(namespace);
}

export function setApproveFirstAll(s: Store, on: boolean): void {
  s.setMeta("approve_first_all", on ? "1" : "0");
  s.audit({ op: on ? "approve-first-all-on" : "approve-first-all-off" });
}

export function setApproveFirst(s: Store, namespace: string, on: boolean): void {
  const ns = typeof namespace === "string" ? namespace.trim() : "";
  if (!ns) throw new ValidationError("namespace is required");
  s.transaction(() => {
    const rest = s.approveFirstNamespaces().filter((n) => n !== ns);
    s.setMeta("approve_first", JSON.stringify(on ? [...rest, ns].sort() : rest));
  });
  s.audit({ op: on ? "approve-first-on" : "approve-first-off", namespace: ns });
}

export function refuseAgentOnPinned(s: Store, id: number, what: string): void {
  if (currentWriter() === "cli") return;
  const r = s.db.prepare("SELECT pinned FROM notes WHERE id = ?").get(id) as { pinned: number } | undefined;
  if (r && Number(r.pinned) === 1) {
    throw new ValidationError(`note ${id} is pinned by the operator: ${what} is done by the operator (monomem CLI), not by an agent. It can still be read.`);
  }
}

export function setPinned(s: Store, id: number, on: boolean, namespaces?: string[]): boolean {
  if (namespaces && namespaces.length === 0) return false;
  // One transaction: the operator's pass recorded as the human confirm and the pin land together or not at all.
  const ok = s.transaction(() => {
    if (on) {
      const ns = (s.db.prepare("SELECT namespace FROM notes WHERE id = ?").get(id) as { namespace: string } | undefined)?.namespace;
      if (ns === undefined || (namespaces && !namespaces.includes(ns))) return false; // a note outside the caller's namespaces reads as missing
      s.requireHumanConfirm(id, "pin");
    }
    const where = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
    const res = s.db.prepare(`UPDATE notes SET pinned = ? WHERE id = ?${where}`).run(on ? 1 : 0, id, ...(namespaces ?? []));
    return Number(res.changes) > 0;
  });
  if (ok) s.audit({ op: on ? "pin" : "unpin", id });
  return ok;
}

export function pinnedNotes(s: Store, namespaces?: string[]): Array<{ id: number; namespace: string; title: string }> {
  if (namespaces && namespaces.length === 0) return [];
  const where = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
  // Round 4: the partial index (v22) holds the pinned rows only; named, as the planner would walk the namespace instead.
  const from = s.hasIndex("idx_notes_pinned") ? "notes INDEXED BY idx_notes_pinned" : "notes";
  return s.db.prepare(`SELECT id, namespace, title FROM ${from} WHERE pinned = 1${where}${s.ceilingSql()} ORDER BY id`).all(...(namespaces ?? [])) as unknown as Array<{
    id: number;
    namespace: string;
    title: string;
  }>;
}

/**
 * 1.5.0 (A3): a trust setting stored as JSON. `damaged` = present but unparsable or the wrong shape: the readers then fail
 * CLOSED (approve-first everywhere, every agent paused, every attester key revoked), never open. Missing = not damaged.
 */
export function metaJson<T>(s: Store, key: string, ok: (v: unknown) => v is T): { v: T | null; damaged: boolean } {
  const raw = s.getMeta(key);
  if (raw === null) return { v: null, damaged: false };
  try {
    const v = JSON.parse(raw) as unknown;
    return ok(v) ? { v, damaged: false } : { v: null, damaged: true };
  } catch {
    return { v: null, damaged: true };
  }
}

export function damagedTrustSettings(s: Store): string[] {
  const out: string[] = [];
  if (s.metaJson("approve_first", isStringArray).damaged) out.push("approve_first");
  if (s.metaJson("flood_paused", isStringArray).damaged) out.push("flood_paused");
  if (s.metaJson("revoked_attester_keys", isPlainObject).damaged) out.push("revoked_attester_keys");
  const m = s.getMeta("confirm_mode");
  if (m !== null && !(CONFIRM_MODES as readonly string[]).includes(m)) out.push("confirm_mode");
  return out;
}
