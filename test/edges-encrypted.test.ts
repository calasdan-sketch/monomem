// 1.5.0 (round 2, P6): in an encrypted store, similar-note links are built from the real text after a restart too.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";

const BODY = "postgres connection pool exhausted under load raise max connections pgbouncer transaction mode fixes timeouts";

for (const enc of [false, true]) {
  test(`P6 neighbours after a restart match a plain store (${enc ? "encrypted" : "plain"})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "om-p6-"));
    let s: Store | null = null;
    try {
      if (enc) ensureKey(dir);
      const path = join(dir, "state.db");
      s = new Store(path);
      s.create({ namespace: "p", title: "alpha", body: BODY });
      s.create({ namespace: "p", title: "beta", body: BODY });
      s.close();
      s = new Store(path);
      const c = s.create({ namespace: "p", title: "gamma", body: BODY });
      assert.equal(s.listNeighbors(c.id).length, 2, "both earlier notes are neighbours of the new one");
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
