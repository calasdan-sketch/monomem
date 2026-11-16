// doctor: open the database (without upgrading it), count notes, encryption state, rules and held writes.

import type { Doctor } from "./report.js";

/** The database opens and is sound; also notes the facts later checks use (dbProblem, sealedNotes ...). */
export async function databaseCheck(dr: Doctor): Promise<void> {
  const { ok, warn, fail } = dr;
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  // 1.5.0 (infra HIGH-3): doctor only looks. An older database is not upgraded here (apps that still have it open would keep
  // writing in the old shape); a missing one is created as before.
  const { SchemaMismatchError, SCHEMA_VERSION: BUILD_SCHEMA } = await import("../store.js");
  try {
    const s = new Store(DB_PATH, { noMigrate: Store.peekSchemaVersion(DB_PATH) !== null });
    dr.storeIdForProbe = s.serverIdValue;
    // The same count `monomem health` shows: every namespace and every kind. list() counts only hand-written notes
    // (kind "note"), so a store full of captured observations and session summaries read as a handful of notes.
    const total = s.countAll();
    const damaged = s.integrityProblem();
    if (damaged) {
      s.close();
      throw new Error(damaged);
    }
    const edges = s.edgeCount();
    const sample = edges === 0 && total >= 2 ? s.list({ limit: 60 }).notes : [];
    dr.hasLabelled = s.labelledAboveDefault() > 0;
    dr.hasPrivate = s.hasPrivateNotes();
    // 1.5.0 (S-03): say plainly when sealed notes have no key, or a key sits next to readable bodies.
    {
      const { keyPath } = await import("../crypto.js");
      const { dirname } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const kp = keyPath(dirname(DB_PATH));
      const sealed = s.encryptedCount();
      dr.sealedNotes = sealed;
      if (sealed > 0 && !existsSync(kp)) {
        fail(`${sealed} note${sealed === 1 ? " is" : "s are"} encrypted, but the key is missing at ${kp}`, `Restore the key file ${kp} from your backup (or copy it from the computer it came from). Without it those notes cannot be read; a database backup alone will not help, it is sealed with the same key.`);
      } else if (existsSync(kp)) {
        const plain = s.plaintextBodyCount();
        if (plain > 0) warn(`${plain} note bod${plain === 1 ? "y is" : "ies are"} not encrypted although a key file exists (new notes are sealed; these older ones are still plain text)`, "Seal them: monomem encrypt enable");
        else ok(`encryption on: ${sealed} note bod${sealed === 1 ? "y is" : "ies are"} sealed with the key at ${kp} (titles and tags stay readable; back the key up, losing it loses the bodies)`);
      }
    }
    dr.distrustCount = s.distrustRules().length;
    const { meterStats, meterLine } = await import("../meter.js");
    const footprint = meterLine(meterStats(s));
    const ruleLines = s.confirmRuleLines();
    // A held write is waiting on a person: "all good" must not hide it (it is not a fault, so an info line).
    const heldCount = s.listQuarantine({ limit: 500 }).length;
    s.close();
    ok(`database OK at ${DB_PATH} (${total} notes)`);
    ok(footprint);
    // 1.4.0: one line per confirm rule, so "why isn't my note in session start?" has an answer here.
    for (const l of ruleLines) console.log("  [info] " + l);
    if (heldCount) console.log(`  [info] ${heldCount >= 500 ? "500 or more writes are" : heldCount === 1 ? "1 write is" : `${heldCount} writes are`} held and waiting for your decision (not saved yet): monomem quarantine`);
    // Migration v4 adds the similarity-edge table but does not score
    // existing notes: a store upgraded from 1.0.0 has notes and no edges
    // until a one-time rebuild.
    // A new store of unrelated notes also has no edges, so warn only when two notes ARE similar enough
    // to have been linked. ponytail: looks at the 60 newest notes only; widen if old stores slip through.
    const { cosineSimilarity } = await import("../consolidate.js");
    const { EDGE_SIMILARITY_THRESHOLD } = await import("../store.js");
    const similarPair = sample.some((a, i) =>
      sample.slice(i + 1).some((b) => a.namespace === b.namespace && cosineSimilarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`) >= EDGE_SIMILARITY_THRESHOLD)
    );
    if (similarPair) {
      warn(
        "notes but no similarity edges (a store created before 1.1, or notes brought in with import or restore, which skip linking to stay fast)",
        "run `monomem rebuild-edges` once to link existing notes"
      );
    }
  } catch (e) {
    if (e instanceof SchemaMismatchError && e.found < BUILD_SCHEMA) {
      dr.oldSchema = true;
      warn(
        `the database at ${DB_PATH} is at schema v${e.found}; this build uses v${BUILD_SCHEMA}. doctor did not upgrade it.`,
        "Close every app that uses Monomem (Claude Code, Claude Desktop, Cursor, the server), then run `monomem ls` once: that upgrades it (one way, after a safety copy)."
      );
    } else {
      dr.dbProblem = true;
      const d = (await import("../db-problem.js")).describeDbFailure(DB_PATH, e);
      fail(d.problem, d.fix);
    }
  }
}
