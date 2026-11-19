// First-run race: several programs (every connected app starts its own Monomem server) write the first audit line of a
// brand-new store at the same moment. Each used to write "line 1", and `monomem check` then reported broken audit lines for good.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyAuditChain } from "../src/security.js";

const GENESIS = "0".repeat(64);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function runChildren(log: string, count: number, lines: number): Promise<number[]> {
  const security = pathToFileURL(join(import.meta.dirname, "..", "src", "security.js")).href;
  const start = Date.now() + 1500; // every child waits for the same moment, so they all see an empty log
  const code = `
    const { audit } = await import(${JSON.stringify(security)});
    while (Date.now() < ${start}) { /* spin until the shared start time */ }
    for (let i = 0; i < ${lines}; i++) audit({ op: "race-test", detail: String(process.pid) });
  `;
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, MONOMEM_AUDIT_LOG: log }, stdio: "ignore" });
        child.on("exit", (c) => resolve(c ?? -1));
      })
    )
  );
}

describe("the first audit line of a new store", () => {
  test("8 programs starting at once leave an intact chain (no breaks)", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), "monomem-genesis-"));
      const log = join(dir, "audit.log");
      const codes = await runChildren(log, 8, 3);
      assert.deepEqual(codes, Array(8).fill(0));
      const r = verifyAuditChain(log);
      assert.equal(r.lines, 24, "every line was written");
      assert.equal(r.breaks, 0, `round ${round}: no broken lines`);
      assert.equal(r.ok, true);
      const firsts = readFileSync(log, "utf8").split("\n").filter(Boolean).filter((l) => (JSON.parse(l) as { seq: number }).seq === 1);
      assert.equal(firsts.length, 1, "exactly one line numbered 1");
      assert.equal(existsSync(`${log}.genesis.lock`), false, "the lock folder is gone");
    }
  });

  test("a log that already has two line 1s from the same writer (an older version's race) reads as a harmless overlap, not a break", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-genesis-"));
    const log = join(dir, "audit.log");
    const l1 = JSON.stringify({ ts: "2026-11-01T00:00:00Z", prev: GENESIS, seq: 1, op: "a" });
    const l2 = JSON.stringify({ ts: "2026-11-01T00:00:01Z", prev: sha(l1), seq: 2, op: "a" });
    const l3 = JSON.stringify({ ts: "2026-11-01T00:00:01Z", prev: GENESIS, seq: 1, op: "b" });
    const l4 = JSON.stringify({ ts: "2026-11-01T00:00:02Z", prev: sha(l3), seq: 2, op: "b" });
    const l5 = JSON.stringify({ ts: "2026-11-01T00:00:03Z", prev: sha(l4), seq: 3, op: "c" });
    writeLog(log, [l1, l2, l3, l4, l5]);
    const r = verifyAuditChain(log);
    assert.equal(r.breaks, 0);
    assert.ok(r.forks >= 1);
    assert.equal(r.ok, true);
  });

  test("a line that claims to start the log but sits later in it is still a break", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-genesis-"));
    const log = join(dir, "audit.log");
    const lines: string[] = [];
    let prev = GENESIS;
    for (let i = 1; i <= 30; i++) {
      const l = JSON.stringify({ ts: "2026-11-01T00:00:00Z", prev, seq: i, op: "a" });
      lines.push(l);
      prev = sha(l);
    }
    lines.push(JSON.stringify({ ts: "2026-11-01T00:01:00Z", prev: GENESIS, seq: 1, op: "evil" }));
    writeLog(log, lines);
    assert.equal(verifyAuditChain(log).breaks, 1);
  });
});

import { writeFileSync } from "node:fs";
function writeLog(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
}
