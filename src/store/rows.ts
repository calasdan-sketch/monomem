// Pure row helpers shared by store.ts and the src/store/* modules (1.5.0 store split). Imports only the pure actor.ts,
// taint.ts and crypto.ts, and types, so every user stays out of import cycles.

import type { LintMode, NoteRecord } from "../store.js";
import { currentWriter } from "../actor.js";
import { isTainted } from "../taint.js";
import { encryptV3, decryptV3, decryptIfEncrypted, ENC_PREFIX_V3 } from "../crypto.js";

/** A hooked session with no event for this long no longer counts as open (same as extract.ts STALE_SESSION_MS). */
export const SESSION_IDLE_MS = 30 * 60_000;

export function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  // Store as a JSON array so tags can contain commas/spaces; dedupe + trim.
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

export function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    } catch {
      /* fall through to legacy comma parse */
    }
  }
  return raw.split(",").map((t) => t.trim()).filter(Boolean); // legacy rows
}

/** Strength of a confirm kind: a weaker confirm never overwrites a stronger one for the same rev. */
export const CONFIRM_RANK: Record<string, number> = { corroborated: 1, admin: 2, human: 3 };

/** CONFIRM_RANK as SQL, for the kind stored in column `col`. */
export const rankSql = (col: string): string => `CASE ${col} WHEN 'human' THEN 3 WHEN 'admin' THEN 2 WHEN 'corroborated' THEN 1 ELSE 0 END`;

/** The times a note's re-confirmation clock may start from (the v20 columns). */
export interface DueRow {
  updated_at: string;
  content_at?: string | null;
  confirmed_at?: string | null;
  confirmed_kind?: string | null;
  confirmed_rev?: number | null;
  rev: number;
  grandfathered_at?: string | null;
}

/**
 * When a note's re-confirmation clock started (ms): the latest of its last CONTENT change (title/body), a person's or an
 * admin's confirm of its current rev (a corroboration releases the session-start hold but never restarts the clock), the
 * upgrade (grandfathered) and the mode switch. Due = this + days. The ONE formula for labels and counts. 0 = no usable time:
 * the caller treats that as not due.
 */
export function dueBase(r: DueRow, c: { set_at?: string }): number {
  const confirmed =
    r.confirmed_at && Number(r.confirmed_rev) === Number(r.rev) && (r.confirmed_kind === "human" || r.confirmed_kind === "admin") ? r.confirmed_at : null;
  const times = [r.content_at ?? r.updated_at, confirmed, r.grandfathered_at, c.set_at ?? null].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : 0;
}

/**
 * A tainted note whose current rev has no HUMAN confirm: it may not be pinned or used as a replacement. Grandfathered notes
 * (from before the 1.4.0 upgrade) are included: they are exempt from the session-start hold only, so a 1.3.5 summary that
 * read the web shows as before but is not promoted without a person.
 */
export function needsHumanConfirm(n: Pick<NoteRecord, "tags" | "rev" | "confirmed_kind" | "confirmed_rev">): boolean {
  return isTainted(n.tags) && !(n.confirmed_kind === "human" && n.confirmed_rev === n.rev);
}

/** AAD binding a sealed quarantine column to its column name and namespace (v2, rows sealed before 1.5.0). */
export function quarantineAad(col: string, namespace: string): string {
  return `quarantine|${col}|${namespace}`;
}

/**
 * 1.5.0 S-05: a held write is sealed as v3, bound to its row id too, so one held body moved into another held row (same
 * namespace) does not open and cannot be approved under that row's writer. v2 rows are still read.
 */
export function sealQuarantineCol(v: string, key: Buffer, col: string, namespace: string, id: number): string {
  return encryptV3(v, key, `${quarantineAad(col, namespace)}|${id}`);
}

export function openQuarantineCol(v: string, key: Buffer | null, col: string, namespace: string, id: number): string {
  return v.startsWith(ENC_PREFIX_V3) ? decryptV3(v, key, `${quarantineAad(col, namespace)}|${id}`) : decryptIfEncrypted(v, key, quarantineAad(col, namespace));
}

/**
 * Normalize a caller-supplied timestamp to canonical ISO-8601 (UTC, ms), or
 * null when it is missing, not a string, or doesn't parse. Canonical form
 * matters: created_at/updated_at are compared and sorted as strings.
 */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Coerce a possibly-NaN/undefined value to a bounded integer with a default. */
export function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
}

/** Env knob: a non-negative number, or `dflt` when unset, empty or unusable. */
export function envCount(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Writes one writer may make in a rolling hour before it is paused (MONOMEM_FLOOD_WRITES_PER_HOUR, default 500; 0 = off). */
export const floodWritesPerHour = (): number => Math.floor(envCount("MONOMEM_FLOOD_WRITES_PER_HOUR", 500));

/**
 * Approve-first namespaces hold every write that is not the operator's. The operator is the local
 * `monomem` CLI (writer marker `cli`, no token behind the call) plus the internal lint modes: "none"
 * is an approved quarantine replay, "trusted" is consolidation re-writing stored notes. Everything
 * else counts as an agent: MCP over stdio or HTTP, every REST call (an admin token included -- REST
 * has no separate operator login), the server's own jobs, the runner, capture hooks, library callers.
 */
export function isOperatorWrite(mode: LintMode): boolean {
  return mode !== "full" || currentWriter() === "cli";
}

/** A3 shape checks for trust settings kept as JSON in _meta. */
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
