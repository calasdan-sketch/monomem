// doctor: are the notes still as Monomem sealed them? (seals + ledger, store/integrity.ts). Read-only; fast mode (no signature checks).

import type { Doctor } from "./report.js";

export async function integrityCheck(dr: Doctor): Promise<void> {
  if (dr.dbProblem || dr.oldSchema) return;
  const { DB_PATH } = await import("../config.js");
  const { existsSync } = await import("node:fs");
  const { Store, SCHEMA_VERSION } = await import("../store.js");
  if (DB_PATH === ":memory:" || !existsSync(DB_PATH) || Store.peekSchemaVersion(DB_PATH) !== SCHEMA_VERSION) return;
  let s: InstanceType<typeof Store> | undefined;
  try {
    s = new Store(DB_PATH, { noMigrate: true });
    const r = (await import("../store/integrity.js")).verifyAll(s);
    const fails = r.issues.filter((i) => i.severity === "fail");
    for (const i of r.issues) {
      const where = i.ids ? ` (note ids ${i.ids.slice(0, 10).join(", ")}${i.ids.length > 10 ? ", ..." : ""})` : "";
      if (i.severity === "fail") dr.fail(i.message + where, "Look at them with: monomem verify-lossless. If you made the change yourself, accept it: monomem integrity reseal --yes");
      else dr.warn(i.message + where);
    }
    if (!fails.length) dr.ok(`seals and ledger OK: ${r.notes} note(s) verified against ${r.ledgerEntries} ledger entries in ${r.ms} ms. Edits by programs that cannot read .attest-key are caught; one that can is not (see SECURITY.md).`);
  } catch (e) {
    dr.warn(`could not check the seals: ${(e as Error).message}`);
  } finally {
    s?.close();
  }
}
