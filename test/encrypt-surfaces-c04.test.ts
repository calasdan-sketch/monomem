import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// C-04: `monomem encrypt status --surfaces` lists every place note content can exist and whether it is encrypted on this
// store right now, from real counts, and says the same thing docs/encryption-retention.md says (each surface is named there).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { normalizeHookInput, recordEvent, spoolEvent, SPOOL_FILE } from "../src/capture.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
type Row = { surface: string; encrypted: string; sealed?: number; plain?: number; detail: string };
const by = (rows: Row[], name: string): Row => {
  const r = rows.find((x) => x.surface === name);
  assert.ok(r, `surface "${name}" listed`);
  return r;
};

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "om-c04-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("C-04 encrypt status --surfaces", () => {
  test("no key: bodies and everything else plain; never-sealed and not-checked surfaces say so", () =>
    withDir((dir) => {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "t1", body: "plain body", tags: ["x"] });
      const rows = s.encryptionSurfaces({ dataDir: dir, dbPath: db }) as Row[];
      s.close();
      assert.equal(by(rows, "note bodies").encrypted, "no");
      assert.equal(by(rows, "note bodies").plain, 1);
      assert.equal(by(rows, "note titles").encrypted, "no");
      assert.equal(by(rows, "embeddings").encrypted, "nothing stored");
      assert.equal(by(rows, "audit log").encrypted, "no note text");
      assert.equal(by(rows, "exports").encrypted, "no");
      assert.equal(by(rows, "backups").encrypted, "not checked");
      assert.equal(by(rows, "sync files").encrypted, "not checked");
      // Final security panel item 5: two more places decrypted note text lands.
      assert.equal(by(rows, "sync conflicts").encrypted, "nothing stored");
      assert.equal(by(rows, "project rules files").encrypted, "no");
      assert.match(by(rows, "project rules files").detail, /AGENTS\.md/);
    }));

  test("key added after some writes: bodies, history, capture and spool are counted sealed vs plain", () =>
    withDir((dir) => {
      const db = join(dir, "state.db");
      let s = new Store(db);
      const old = s.create({ title: "before key", body: "written in the clear" });
      s.close();
      appendFileSync(join(dir, SPOOL_FILE), JSON.stringify({ spool_id: "a", session_id: "s0", event: "stop" }) + "\n"); // a pre-1.5.0 plain line
      const key = ensureKey(dir);
      s = new Store(db);
      s.create({ title: "after key", body: "sealed body" });
      s.update(old.id, { body: "new text" }); // the old version goes to history, sealed now
      recordEvent(s, normalizeHookInput("user-prompt", { session_id: "s1", cwd: "/w", prompt: "secret plans" }), "default");
      spoolEvent(dir, { ...normalizeHookInput("stop", { session_id: "s1", cwd: "/w" }), namespace: "default" }, key);
      const rows = s.encryptionSurfaces({ dataDir: dir, dbPath: db }) as Row[];
      s.close();
      const bodies = by(rows, "note bodies");
      assert.equal(bodies.sealed, 2, "the update sealed the old note's body too");
      assert.equal(bodies.encrypted, "yes");
      assert.equal(by(rows, "old versions").encrypted, "yes");
      assert.equal(by(rows, "captured prompts and tool output").encrypted, "yes");
      const spool = by(rows, "capture spool");
      assert.deepEqual([spool.sealed, spool.plain, spool.encrypted], [1, 1, "partly"]);
      assert.equal(by(rows, "note titles").encrypted, "no");
      assert.equal(by(rows, "search index").encrypted, "no");
      assert.match(by(rows, "search index").detail, /sealed bodies are not indexed on disk/);
      // C-06: the body search index lives in memory only; the row says so, and names the swap / dump caveat and the switch.
      const mem = by(rows, "body search index");
      assert.equal(mem.encrypted, "not on disk");
      assert.match(mem.detail, /swap/);
      assert.match(mem.detail, /MONOMEM_BODY_INDEX=off/);
    }));

  test("the CLI prints every surface; each one is named in docs/encryption-retention.md", () =>
    withDir((dir) => {
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db") };
      const human = spawnSync(process.execPath, [CLI, "encrypt", "status", "--surfaces"], { encoding: "utf8", env });
      assert.equal(human.status, 0, human.stderr);
      const json = spawnSync(process.execPath, [CLI, "encrypt", "status", "--surfaces", "--json"], { encoding: "utf8", env });
      assert.equal(json.status, 0, json.stderr);
      const rows = JSON.parse(json.stdout).surfaces as Row[];
      assert.ok(rows.length >= 15);
      const doc = readFileSync(join(PROJECT_ROOT, "docs", "encryption-retention.md"), "utf8");
      for (const r of rows) {
        assert.ok(human.stdout.includes(r.surface), `printed: ${r.surface}`);
        assert.ok(doc.toLowerCase().includes(`**${r.surface}**`), `docs/encryption-retention.md names **${r.surface}**`);
      }
    }));
});
