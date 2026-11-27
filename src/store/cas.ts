// Compare-and-swap for notes: the ONE helper every rev-bumping `UPDATE notes SET` goes through.
//
// The statement carries the rev it was computed from (`WHERE id = ? AND rev = ?`) and the row count is checked, so a writer
// that read an older row can never overwrite a newer one, whatever process it runs in. test/cas-lint.test.ts fails on any
// `UPDATE notes SET` in src/ that is neither in this file nor on its short, reasoned allowlist.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StaleWriteError } from "../errors.js";

export interface CasOpts {
  /** Extra WHERE conditions (with their own `?` params in `whereParams`), ANDed after `id` and `rev`. */
  where?: string;
  whereParams?: SQLInputValue[];
  /** Return false on a stale rev instead of throwing StaleWriteError. */
  soft?: boolean;
  /** Message for the StaleWriteError. */
  stale?: string;
}

/**
 * `UPDATE notes SET <set>, rev = rev + 1 WHERE id = ? AND rev = ?`. `set` is the column list (`archived_at = ?, ...`), `params`
 * its values. Throws StaleWriteError (or returns false with `soft`) when the row moved past `baseRev` or is gone.
 */
export function casUpdate(db: DatabaseSync, id: number, baseRev: number, set: string, params: SQLInputValue[], o: CasOpts = {}): boolean {
  const sql = `UPDATE notes SET ${set}, rev = rev + 1 WHERE id = ? AND rev = ?${o.where ? ` AND ${o.where}` : ""}`;
  const res = db.prepare(sql).run(...params, id, baseRev, ...(o.whereParams ?? []));
  if (Number(res.changes) === 1) return true;
  if (o.soft) return false;
  throw new StaleWriteError(o.stale ?? `note ${id} changed (or was removed) since it was read at rev ${baseRev}; nothing was changed`);
}
