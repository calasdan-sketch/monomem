import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round fixes 2: sync merge base after approval, one held create per origin note, quoted MONOMEM_HOME in setup.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";

const roots: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};
afterEach(() => {
  setProcessWriter("");
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const actions = (r: { entries: Array<{ action: string; detail?: string }> }) => r.entries.map((x) => x.action);

describe("approved foreign sync writes record the merge base", () => {
  test("an origin edit after an approved create updates the note", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-f2-c-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      const n = a.create({ title: "Alpha note", body: "v1 alpha" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      await importMarkdown(b, dir);
      const local = b.approveQuarantine(b.listQuarantine()[0].id);
      b.setApproveFirstAll(false);
      a.update(n.id, { body: "v2 alpha edit" });
      exportMarkdown(a, dir);
      const r = await importMarkdown(b, dir);
      assert.deepEqual(actions(r), ["updated"], JSON.stringify(r.entries));
      assert.equal(b.read(local.id)?.body, "v2 alpha edit");
    } finally {
      a.close();
      b.close();
    }
  });
  test("an origin edit after an approved update is not a false conflict", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-f2-u-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      const n = a.create({ title: "Shared note", body: "v1" });
      exportMarkdown(a, dir);
      await importMarkdown(b, dir);
      const local = b.search("Shared")[0];
      a.update(n.id, { body: "v2" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      await importMarkdown(b, dir);
      b.approveQuarantine(b.listQuarantine()[0].id);
      b.setApproveFirstAll(false);
      a.update(n.id, { body: "v3" });
      exportMarkdown(a, dir);
      const r = await importMarkdown(b, dir);
      assert.deepEqual(actions(r), ["updated"], JSON.stringify(r.entries));
      assert.equal(b.read(local.id)?.body, "v3");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("a held foreign create edited again before approval", () => {
  test("replaces the held copy, so approving makes one note with the newest text", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-f2-d-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      const n = a.create({ title: "Beta note", body: "v1 beta" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      await importMarkdown(b, dir);
      a.update(n.id, { body: "v2 beta" });
      exportMarkdown(a, dir);
      await importMarkdown(b, dir);
      const held = b.listQuarantine();
      assert.equal(held.length, 1, "held rows");
      assert.equal(held[0].body, "v2 beta");
      b.approveQuarantine(held[0].id);
      assert.equal(b.list({}).total, 1, "notes after approving all");
      const r = await importMarkdown(b, dir);
      assert.deepEqual(actions(r), ["unchanged"], JSON.stringify(r.entries));
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("setup dataHome", () => {
  test("removes one pair of quotes, like the run time", async () => {
    const { dataHome } = await import("../src/setup.js");
    const root = tmp("om-f2-home-");
    const e = { home: root, platform: process.platform, env: { MONOMEM_HOME: `"${join(root, "od")}"` }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: "x", version: "1.3.0", now: () => new Date() };
    assert.equal(dataHome(e as Parameters<typeof dataHome>[0]), resolve(join(root, "od")));
    assert.equal(dataHome({ ...e, env: { MONOMEM_HOME: `'${join(root, "sq")}'` } } as Parameters<typeof dataHome>[0]), resolve(join(root, "sq")));
  });
});
