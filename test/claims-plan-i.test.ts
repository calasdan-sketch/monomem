// PLAN I: claim checks and hashed line citations. A note carries checks against the files of its git repository (contains,
// dependency, exists) and line citations (hashed). A check that stops holding labels the note on read and at session start
// and lists it in `monomem review code`; nothing is run, paths stay inside the repository, symlinks out are never read,
// files over the size cap are not read.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { injectContext } from "../src/context-inject.js";
import { claimsReview, keepClaims, MAX_BYTES, CLAIMS_REFUSED, CLAIMS_LOCAL_ONLY } from "../src/claims.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const NO_GIT = { signals: { branch: "", diffFiles: [] } };
let root = "";
let repo = "";
let outside = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
const at = <T>(cwd: string, fn: () => T): T => actorStore.run({ label: "stdio:claude", cwd }, fn);
const put = (p: string, text: string) => writeFileSync(join(repo, p), text);

before(() => {
  root = mkdtempSync(join(tmpdir(), "om-claims-"));
  repo = join(root, "repo");
  outside = join(root, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "port: 8443\n");
  git("init", "-q");
  put("src/config.ts", "export const port = 8443;\nexport const host = 'localhost';\n");
  put("package.json", JSON.stringify({ name: "x", dependencies: { zod: "^3" }, devDependencies: { tsx: "^4" } }));
  put("src/auth.ts", "line1\nline2\nline3\r\nline4\nline5\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("PLAN I claim checks", () => {
  test("a port claim: true now is stored; changing the port labels the note, session start shows the label", async () => {
    const s = new Store(":memory:");
    const n = at(repo, () =>
      s.create({ title: "api port is 8443", body: "port" }, { claims: [{ file: "src/config.ts", contains: "port = 8443" }, { file: "package.json", dependency: "zod" }, { file: "src/config.ts", exists: true }] })
    );
    assert.equal(s.read(n.id)!.claims_failed, undefined, "all claims hold");
    assert.deepEqual(claimsReview(s), { failed: [], holding: 1 });
    put("src/config.ts", "export const port = 9443;\nexport const host = 'localhost';\n");
    const r = s.read(n.id)!;
    assert.equal(r.claims_failed!.length, 1);
    assert.equal(r.claims_failed![0].why, "text not found");
    assert.equal(r.claims_label, "[no longer true in code: claim 1 on src/config.ts]");
    assert.doesNotMatch(r.claims_label!, /8443/, "the claim's own text never goes into the label");
    const ctx = await injectContext(s, NO_GIT);
    assert.match(ctx, /api port is 8443.*\[no longer true in code: claim 1 on src\/config\.ts\]/);
    assert.deepEqual(claimsReview(s).failed.map((x) => x.id), [n.id]);
    // A person keeps it: the failing check is dropped, the others stay.
    assert.equal(keepClaims(s, n.id), 1);
    assert.equal(s.read(n.id)!.claims_failed, undefined);
    assert.deepEqual(claimsReview(s), { failed: [], holding: 1 });
    put("src/config.ts", "export const port = 8443;\nexport const host = 'localhost';\n");
    s.close();
  });

  test("dependency and exists claims fail when the dependency or file goes", () => {
    const s = new Store(":memory:");
    put("src/tmp.ts", "x\n");
    git("add", "src/tmp.ts");
    const n = at(repo, () => s.create({ title: "uses tsx", body: "b" }, { claims: [{ file: "package.json", dependency: "tsx" }, { file: "src/tmp.ts", exists: true }] }));
    put("package.json", JSON.stringify({ name: "x", dependencies: { zod: "^3" } }));
    rmSync(join(repo, "src/tmp.ts"));
    const r = s.read(n.id)!;
    assert.deepEqual(r.claims_failed!.map((f) => f.why), ["dependency not listed", "file gone"]);
    put("package.json", JSON.stringify({ name: "x", dependencies: { zod: "^3" }, devDependencies: { tsx: "^4" } }));
    s.close();
  });

  test("a claim that is not true when written is refused, and nothing is written", () => {
    const s = new Store(":memory:");
    assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { claims: [{ file: "src/config.ts", contains: "port = 1" }] })), { message: CLAIMS_REFUSED });
    assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { claims: ["src/auth.ts:4-99"] })), { message: CLAIMS_REFUSED });
    assert.equal(s.list({ limit: 10 }).total, 0);
    s.close();
  });
});

describe("PLAN I hashed line citations", () => {
  test("cited lines: an edit elsewhere keeps 'still matches'; an edit inside the span labels 'cited code changed'", () => {
    const s = new Store(":memory:");
    const n = at(repo, () => s.create({ title: "auth flow", body: "see auth" }, { claims: ["src/auth.ts:2-3", { file: "src/auth.ts", lines: "5" }] }));
    assert.equal(s.read(n.id)!.claims_failed, undefined);
    put("src/auth.ts", "line1\nline2\nline3\nline4\nline5\n"); // CRLF -> LF only: the same code
    assert.equal(s.read(n.id)!.claims_failed, undefined, "line endings are not a change");
    put("src/auth.ts", "line1 edited elsewhere\nline2\nline3\nline4\nline5\n");
    assert.equal(s.read(n.id)!.claims_failed, undefined, "an edit outside the cited lines keeps it matching");
    put("src/auth.ts", "line1\nline2 CHANGED\nline3\nline4\nline5\n");
    const r = s.read(n.id)!;
    assert.equal(r.claims_label, "[cited code changed: src/auth.ts:2-3]");
    assert.equal(r.claims_failed![0].why, "cited code changed");
    // A person keeps it: the citation is re-hashed to the lines as they are now.
    assert.equal(keepClaims(s, n.id), 1);
    assert.equal(s.read(n.id)!.claims_failed, undefined);
    put("src/auth.ts", "line1\nline2\n");
    assert.equal(s.read(n.id)!.claims_label, "[cited code changed: src/auth.ts:2-3, src/auth.ts:5]");
    assert.deepEqual(s.read(n.id)!.claims_failed!.map((f) => f.why), ["lines gone", "lines gone"]);
    put("src/auth.ts", "line1\nline2\nline3\r\nline4\nline5\n");
    s.delete(n.id);
    assert.equal((s.db.prepare("SELECT count(*) AS c FROM code_claims WHERE note_id = ?").get(n.id) as { c: number }).c, 0, "deleting the note removes its claims");
    s.close();
  });
});

describe("PLAN I file safety", () => {
  test("paths outside the root, '..', folders, bad shapes and no repository are refused", () => {
    const s = new Store(":memory:");
    const bad: Array<[unknown, RegExp]> = [
      [[{ file: "../outside/secret.txt", contains: "8443" }], /'\.\.'/],
      [[{ file: join(outside, "secret.txt"), contains: "8443" }], /claims: refused\./],
      [[`${join(outside, "secret.txt")}:1`], /claims: refused\./],
      [[{ file: "src", exists: true }], /claims: refused\./],
      [[{ file: "src/config.ts", contains: "a", exists: true }], /exactly one of/],
      [[{ file: "src/config.ts", run: "rm -rf /" }], /exactly one of/],
      [[{ file: "src/config.ts", contains: "x".repeat(201) }], /1-200/],
      [["just text"], /line citation/],
      [["src/auth.ts:5-1"], /start-end/],
      [["src/auth.ts:1-500"], /at most 200 lines/],
      [Array.from({ length: 21 }, () => "src/auth.ts:1"), /at most 20/],
    ];
    for (const [claims, why] of bad) assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { claims })), why, JSON.stringify(claims));
    assert.throws(() => at(outside, () => s.create({ title: "t", body: "b" }, { claims: [{ file: "secret.txt", contains: "8443" }] })), /git repository/);
    assert.equal(s.list({ limit: 10 }).total, 0, "nothing was written");
    s.close();
  });

  test("a symlink out of the root is refused at write and never read later", () => {
    const s = new Store(":memory:");
    let linked = false;
    try {
      symlinkSync(outside, join(repo, "escape"), "junction");
      linked = true;
    } catch {
      /* no symlink rights: the absolute-path case covers the root check */
    }
    if (!linked) return;
    assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { claims: [{ file: "escape/secret.txt", contains: "8443" }] })), /claims: refused\./);
    // A claim written on an in-root file that later becomes a link out is not read through the link.
    mkdirSync(join(repo, "later"));
    writeFileSync(join(repo, "later", "secret.txt"), "port: 8443\n");
    git("add", "later/secret.txt");
    const n = at(repo, () => s.create({ title: "later", body: "b" }, { claims: [{ file: "later/secret.txt", contains: "8443" }] }));
    rmSync(join(repo, "later"), { recursive: true, force: true });
    symlinkSync(outside, join(repo, "later"), "junction");
    assert.equal(s.read(n.id)!.claims_failed![0].why, "path leads outside the repository");
    rmSync(join(repo, "later"), { recursive: true, force: true });
    rmSync(join(repo, "escape"), { recursive: true, force: true });
    s.close();
  });

  test("a file over the size cap is not read", () => {
    const s = new Store(":memory:");
    put("big.txt", "needle\n");
    git("add", "big.txt");
    const n = at(repo, () => s.create({ title: "big", body: "b" }, { claims: [{ file: "big.txt", contains: "needle" }] }));
    put("big.txt", "needle\n" + "x".repeat(MAX_BYTES));
    assert.match(s.read(n.id)!.claims_failed![0].why, /over 1 MB, not read/);
    rmSync(join(repo, "big.txt"));
    s.close();
  });

  test("monomem review code --json lists failing claims and counts the ones that still match", async () => {
    const { DB_PATH, PROJECT_ROOT } = await import("../src/config.js");
    put("src/cli-claim.ts", "const mode = 'fast';\n");
    git("add", "src/cli-claim.ts");
    const s = new Store(DB_PATH);
    const bad = at(repo, () => s.create({ title: "mode is fast", body: "b" }, { claims: [{ file: "src/cli-claim.ts", contains: "'fast'" }] }));
    at(repo, () => s.create({ title: "uses zod", body: "b" }, { claims: [{ file: "package.json", dependency: "zod" }] }));
    s.close();
    put("src/cli-claim.ts", "const mode = 'slow';\n");
    const cli = join(PROJECT_ROOT, "dist", "src", "cli.js");
    const out = JSON.parse(execFileSync(process.execPath, [cli, "review", "code", "--json"], { encoding: "utf8" })) as { claims_failed: Array<{ id: number }>; claims_holding: number };
    assert.deepEqual(out.claims_failed.map((x) => x.id), [bad.id]);
    assert.equal(out.claims_holding, 1);
    const text = execFileSync(process.execPath, [cli, "review", "code"], { encoding: "utf8" });
    assert.match(text, /1 note has a claim no longer true in code/);
    assert.match(text, /src\/cli-claim\.ts contains "'fast'": text not found/);
    assert.match(text, /1 note's claims and cited code still match the files/);
  });

  test("memory_save takes claims when creating; an update with claims is refused", async () => {
    // A local (stdio) connection: its folder is the repository.
    const s = new Store(":memory:");
    const server = createMcpServer(s, "admin", {}, { local: true, cwd: repo });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join(" ");
    const ok = await client.callTool({ name: "memory_save", arguments: { title: "port", body: "8443", claims: [{ file: "src/config.ts", contains: "8443" }, "src/auth.ts:1-2"] } });
    assert.ok(!ok.isError, text(ok));
    const id = s.list({ limit: 5 }).notes[0].id;
    assert.equal((s.db.prepare("SELECT count(*) AS c FROM code_claims WHERE note_id = ?").get(id) as { c: number }).c, 2);
    const bad = await client.callTool({ name: "memory_save", arguments: { title: "port", body: "x", claims: [{ file: "src/config.ts", contains: "nope" }] } });
    assert.ok(bad.isError && text(bad).includes(CLAIMS_REFUSED), text(bad));
    const upd = await client.callTool({ name: "memory_save", arguments: { id, body: "y", claims: ["src/auth.ts:1"] } });
    assert.ok(upd.isError && /claims applies to creating/.test(text(upd)), text(upd));
    await client.close();
    s.close();
  });

  test("r4 S1: claims are not a file-content oracle (claimoracle.mjs): untracked files and remote connections are refused alike", async () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), "API_KEY=sk-live-7Q\n");
    const s = new Store(":memory:");
    // Local: a gitignored file gets the same refusal whether the guess is right or wrong, and the same as a false claim.
    const refusal = (contains: string, file = ".env"): string => {
      try {
        at(repo, () => s.create({ title: "p", body: "x" }, { claims: [{ file, contains }] }));
        return "stored";
      } catch (e) {
        return (e as Error).message;
      }
    };
    assert.equal(refusal("API_KEY=sk"), CLAIMS_REFUSED, "a right guess on an untracked file");
    assert.equal(refusal("API_KEY=zz"), CLAIMS_REFUSED, "a wrong guess on an untracked file");
    assert.equal(refusal("nope", "src/config.ts"), CLAIMS_REFUSED, "a false claim on a tracked file");
    assert.equal(refusal("x", "no/such/file.ts"), CLAIMS_REFUSED, "a missing file");
    // An app key (HTTP / REST / OAuth: no folder of its own) cannot use claims at all.
    assert.throws(() => actorStore.run({ label: "remotebot", authed: true }, () => s.create({ title: "p", body: "x" }, { claims: [{ file: "src/config.ts", exists: true }] })), { message: CLAIMS_LOCAL_ONLY });
    assert.equal(s.list({ limit: 10 }).total, 0, "nothing was written");
    // The seat's brute force over MCP, from a server launched in the repository, recovers nothing.
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const server = createMcpServer(s, "write", {}, { label: "remotebot", authed: true });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "t", version: "1" });
      await Promise.all([c.connect(ct), server.connect(st)]);
      let known = "API_KEY=";
      for (let i = 0; i < 3; i++) {
        let hit = false;
        for (const ch of "skabcdefghijklmnopqrstuvwxyz-_0123456789") {
          const r = await c.callTool({ name: "memory_save", arguments: { title: "probe", body: "x", claims: [{ file: ".env", contains: known + ch }] } });
          if (!r.isError) {
            known += ch;
            hit = true;
            break;
          }
        }
        if (!hit) break;
      }
      assert.equal(known, "API_KEY=", "nothing recovered");
      await c.close();
    } finally {
      process.chdir(cwd);
      s.close();
    }
  });
});
