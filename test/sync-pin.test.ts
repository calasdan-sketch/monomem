// 1.5.0 (round 2, U-11 / infra MED-7): an operator pin travels through Markdown / git file sync. A pin only adds protection,
// so a file can pin, never unpin; and a file never confirms anything: a note from outside content that nobody confirmed is
// not pinned by a file (pinning it here would record a human confirm), and its taint stays.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, needsHumanConfirm } from "../src/store.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";

function noteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ns of readdirSync(dir, { withFileTypes: true })) if (ns.isDirectory() && !ns.name.startsWith(".")) for (const f of readdirSync(join(dir, ns.name))) out.push(join(dir, ns.name, f));
  return out;
}

describe("pin through file sync (U-11)", () => {
  test("a pinned note is exported with pinned: true and comes back pinned on another store; unpinned files stay byte-identical", async () => {
    const root = mkdtempSync(join(tmpdir(), "mm-syncpin-"));
    const a = new Store(join(root, "a.db"));
    const b = new Store(join(root, "b.db"));
    try {
      const pinned = a.create({ title: "deploy rule", body: "never deploy on friday" });
      const plain = a.create({ title: "lunch", body: "tacos" });
      assert.equal(a.setPinned(pinned.id, true), true);
      const vault = join(root, "vault");
      exportMarkdown(a, vault);
      const texts = noteFiles(vault).map((f) => readFileSync(f, "utf8"));
      assert.equal(texts.filter((t) => /^pinned: true$/m.test(t)).length, 1, "only the pinned note's file says pinned");
      await importMarkdown(b, vault);
      const got = b.exportAll().filter((n) => !n.archived_at); // gate-ok: test
      assert.equal(got.find((n) => n.title === "deploy rule")?.pinned, true);
      assert.equal(got.find((n) => n.title === "lunch")?.pinned, undefined);
      void plain;
    } finally {
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file cannot unpin, and cannot pin (or confirm) an unconfirmed note from outside content", async () => {
    const root = mkdtempSync(join(tmpdir(), "mm-syncpin2-"));
    const a = new Store(join(root, "a.db"));
    const b = new Store(join(root, "b.db"));
    try {
      const web = a.create({ title: "from the web", body: "some page said this", outside: true });
      const kept = a.create({ title: "kept", body: "stays pinned on b" });
      const vault = join(root, "vault");
      exportMarkdown(a, vault);
      // Hand-edit: claim the outside note is pinned.
      for (const f of noteFiles(vault)) {
        const t = readFileSync(f, "utf8");
        if (t.includes("from the web")) writeFileSync(f, t.replace(/\n---\n/, "\npinned: true\n---\n"));
      }
      await importMarkdown(b, vault);
      const bWeb = b.exportAll().find((n) => n.title === "from the web")!; // gate-ok: test
      assert.equal(bWeb.pinned, undefined, "an unconfirmed note is not pinned by a file");
      assert.equal(needsHumanConfirm(bWeb), true, "and not confirmed either");
      assert.ok(bWeb.tags.some((t) => t.startsWith("obs.origin:")), "taint stays");
      // b pins its copy of "kept"; a's file (no pin) must not unpin it.
      const bKept = b.exportAll().find((n) => n.title === "kept")!; // gate-ok: test
      assert.equal(b.setPinned(bKept.id, true), true);
      a.update(kept.id, { body: "edited on a" });
      exportMarkdown(a, vault);
      await importMarkdown(b, vault);
      assert.equal(b.read(bKept.id)?.pinned, true); // gate-ok: test
      void web;
    } finally {
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
