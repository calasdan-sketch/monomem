// `monomem verify-lossless`, `monomem integrity seal|reseal` and `monomem audit verify --db`: what the seals and the ledger say
// about this database (store/integrity.ts). Read-only except `integrity seal` (finish sealing pre-upgrade notes) and
// `integrity reseal --yes` (the operator accepts the notes as they are now).

import type { Store } from "../store.js";
import type { IntegrityReport } from "../store/integrity.js";

const LIMIT =
  "This catches edits made by anything that cannot read the signing key (another user, a sync tool, a bad restore, a hand-typed UPDATE).\n" +
  "It does NOT stop a program that runs as you and reads .attest-key: that program can seal a forged note. Only a checkpoint or a\n" +
  "receipt kept somewhere else shows that afterwards (monomem audit checkpoint --out <file>).";

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function open(write: boolean): Promise<Store> {
  const { DB_PATH } = await import("../config.js");
  const { Store, SCHEMA_VERSION } = await import("../store.js");
  const v = Store.peekSchemaVersion(DB_PATH);
  if (v === null) die(`No database at ${DB_PATH}.`);
  if (v < SCHEMA_VERSION) die(`The database is at schema v${v}; notes are sealed from v${SCHEMA_VERSION}. It is upgraded the next time Monomem opens it (monomem start).`);
  return new Store(DB_PATH, { noMigrate: !write });
}

export function printReport(r: IntegrityReport, log: (m: string) => void = console.log): void {
  log(`${r.notes} note(s), ${r.sealed} verified, ${r.ledgerEntries} ledger entries, checked in ${r.ms} ms.`);
  for (const i of r.issues) log(`  [${i.severity === "fail" ? "FAIL" : "warn"}] ${i.message}${i.ids ? ` (ids ${i.ids.join(", ")}${i.ids.length >= 50 ? ", ..." : ""})` : ""}`);
  log(`Invariants that hold: ${r.held.join(" ") || "none"}.`);
}

export async function verifyDbCmd(args: string[]): Promise<void> {
  const s = await open(false);
  try {
    const r = (await import("../store/integrity.js")).verifyAll(s, { signatures: args.includes("--full") || args.includes("--all-signatures") });
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      printReport(r);
      console.log(LIMIT);
    }
    if (r.issues.some((i) => i.severity === "fail")) process.exitCode = 1;
  } finally {
    s.close();
  }
}

export async function integrityCmd(cmd: string, args: string[]): Promise<void> {
  if (cmd === "verify-lossless") return verifyDbCmd(args);
  const sub = args[0];
  if (sub === "seal") {
    const s = await open(true);
    try {
      const { backfillBatch } = await import("../store/ledger.js");
      let n = 0;
      for (;;) {
        const r = backfillBatch(s);
        n += r.sealed;
        if (r.done) break;
      }
      console.log(`Sealed ${n} note(s) that existed before the upgrade. They are trusted as they were at that moment (the seal says nothing about earlier edits).`);
    } finally {
      s.close();
    }
    return;
  }
  if (sub === "reseal") {
    if (!args.includes("--yes")) die("This re-seals EVERY note as it is now, including any note doctor flagged: you accept that content. Run `monomem verify-lossless` first, then: monomem integrity reseal --yes", 2);
    const s = await open(true);
    try {
      const n = (await import("../store/ledger.js")).resealAll(s, "operator reseal (accepted as is)");
      console.log(`Re-sealed ${n} note(s) and recorded it in the ledger.`);
    } finally {
      s.close();
    }
    return;
  }
  die("Usage: monomem integrity seal   |   monomem integrity reseal --yes   |   monomem verify-lossless [--full] [--json]", 2);
}
