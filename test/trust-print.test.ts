// 1.5.0 (R1-18): trust state is shown wherever the CLI prints a note: show, ls, why and ls --archived.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, QuarantinedError } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
function run(dir: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "t.db") },
    encoding: "utf8",
  });
}
function hold(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof QuarantinedError) return e.quarantineId;
    throw e;
  }
  assert.fail("the write was not held");
}

/** unconfirmed (#web), expired (#old), approved held create (#ok), kept-as-history (#kept, replaced by #fix). */
function fixtures(dir: string) {
  const s = new Store(join(dir, "t.db"));
  try {
    setProcessWriter("cli");
    const web = s.create({ namespace: "work", title: "Pasted from a web page", body: "vendor says 99", outside: true });
    const old = s.create({ namespace: "work", title: "Old deploy guide", body: "run the pipeline" });
    s.captureDb().prepare("UPDATE notes SET updated_at = ?, created_at = ?, content_at = ? WHERE id = ?").run(ago(40), ago(40), ago(40), old.id);
    s.create({ namespace: "p", title: "seed" });
    s.setApproveFirst("p", true);
    setProcessWriter("stdio:agent-a");
    const q1 = hold(() => s.create({ namespace: "p", title: "Approved price note", body: "45" }));
    const q2 = hold(() => s.create({ namespace: "p", title: "Superseded price note", body: "50" }));
    setProcessWriter("cli");
    const ok = s.approveQuarantine(q1);
    const fix = s.create({ namespace: "p", title: "Corrected price note", body: "40" });
    const kept = s.keepQuarantineAsHistory(q2, fix.id).note;
    s.confirm(web.id, { source: "operator: test" });
    s.update(web.id, { body: "vendor says 98" }); // the confirm was for the old version: unconfirmed again
    return { web: web.id, old: old.id, ok: ok.id, kept: kept.id, fix: fix.id };
  } finally {
    setProcessWriter("");
    s.close();
  }
}

describe("R1-18 trust state wherever a note is printed", () => {
  test("show: flags, a plain origin line, no raw obs.origin tag, and 'replaced by' for a superseded note", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-trustprint-"));
    try {
      const f = fixtures(dir);
      const web = run(dir, ["show", String(f.web)]);
      assert.equal(web.status, 0, web.stderr);
      assert.match(web.stdout, /\[unconfirmed/i);
      assert.match(web.stdout, /^origin: .*declared .*outside content/im);
      assert.doesNotMatch(web.stdout, /obs\.origin:/);
      assert.match(run(dir, ["show", String(f.old)]).stdout, /\[expired - not re-confirmed in 30 days\]/);
      const kept = run(dir, ["show", String(f.kept)]);
      assert.equal(kept.status, 0, kept.stderr);
      assert.match(kept.stdout, new RegExp(`replaced by #${f.fix}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ls: flags on each line; ls --archived includes kept-as-history notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-trustprint-"));
    try {
      const f = fixtures(dir);
      const ls = run(dir, ["ls", "--limit", "50"]).stdout;
      assert.match(ls, new RegExp(`#${f.web} .*\\[unconfirmed`, "i"));
      assert.match(ls, new RegExp(`#${f.old} .*\\[expired`));
      const arch = run(dir, ["ls", "--archived"]).stdout;
      assert.match(arch, new RegExp(`#${f.kept} .*replaced by #${f.fix}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("why: confirmations (counted or not) and who approved a held write; the stale 'not recorded: approval' line is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-trustprint-"));
    try {
      const f = fixtures(dir);
      const web = run(dir, ["why", String(f.web)]);
      assert.equal(web.status, 0, web.stderr);
      assert.match(web.stdout, /^Confirmations:/m);
      assert.match(web.stdout, /version 1 .*operator: test/);
      const ok = run(dir, ["why", String(f.ok)]);
      assert.match(ok.stdout, /approved by cli/i);
      assert.doesNotMatch(ok.stdout, /approval of a held write/);
      const json = JSON.parse(run(dir, ["why", String(f.web), "--json"]).stdout);
      assert.ok(Array.isArray(json.confirmations) && json.confirmations.length === 1, JSON.stringify(json.confirmations));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
