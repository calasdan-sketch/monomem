// C18 project-first session start: a note written from inside this project's git root (notes.writer_cwd) ranks ahead of an
// equally recent note from another project; another project's note with no keyword or file match is down-ranked; a note with
// no recorded folder (REST, token, CLI at a terminal, old notes) stays neutral.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { rankContext, gitSignals, insideFolder } from "../src/context-inject.js";

const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

describe("project-first session start (C18)", () => {
  test("insideFolder is one-way: a home-folder writer is not 'inside' the project", () => {
    assert.equal(insideFolder("/work/app/src", "/work/app"), true);
    assert.equal(insideFolder("/work/app", "/work/app"), true);
    assert.equal(insideFolder("/work", "/work/app"), false);
    assert.equal(insideFolder("/work/app2", "/work/app"), false);
    assert.equal(insideFolder(null, "/work/app"), false);
  });

  test("same-project notes rank first; other-project notes without a match go last; unknown folders stay neutral", async () => {
    const s = new Store(":memory:");
    const mk = (title: string, d: number, cwd: string | null): number => {
      const id = s.create({ title, body: title }, { updatedAt: daysAgo(d) }).id;
      s.captureDb().prepare("UPDATE notes SET writer_cwd = ?, created_at = ? WHERE id = ?").run(cwd, daysAgo(d), id);
      return id;
    };
    const other = mk("other project note", 1, "/work/other");
    const neutral = mk("rest note", 2, null);
    const here = mk("this project note", 3, "/work/app/packages/web");
    const { ranked } = await rankContext(s, { signals: { branch: "", diffFiles: [], root: "/work/app" } });
    const order = ranked.map((n) => n.id);
    assert.ok(order.indexOf(here) < order.indexOf(other), `${order}`);
    assert.ok(order.indexOf(neutral) < order.indexOf(other), `${order}`);
    // Without a root nothing changes: recency leads.
    const plain = await rankContext(s, { signals: { branch: "", diffFiles: [] } });
    assert.equal(plain.ranked[0].id, other);
    s.close();
  });

  test("insideFolder compares real paths: a folder reached through a link is inside the real root (macOS /var -> /private/var)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-link-"));
    try {
      mkdirSync(join(dir, "real", "sub"), { recursive: true });
      symlinkSync(join(dir, "real"), join(dir, "link"), "junction");
      assert.equal(insideFolder(join(dir, "link", "sub"), realpathSync.native(join(dir, "real"))), true);
      assert.equal(insideFolder(join(dir, "real", "sub"), join(dir, "link")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gitSignals reports the repository's top folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-root-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      mkdirSync(join(dir, "sub"));
      const sig = await gitSignals(join(dir, "sub"));
      assert.ok(sig.root && insideFolder(join(dir, "sub"), sig.root) && insideFolder(sig.root, dir), `${sig.root}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writer project from MCP roots (C18)", () => {
  test("a stdio client that offers roots: its workspace folder is recorded as the writer folder, not the launch folder", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
    const dir = mkdtempSync(join(tmpdir(), "mm-roots-"));
    const launch = join(dir, "launch");
    const work = join(dir, "work");
    mkdirSync(launch);
    mkdirSync(work);
    const db = join(dir, "state.db");
    try {
      const client = new Client({ name: "roots-test", version: "1" }, { capabilities: { roots: {} } });
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(work).href, name: "work" }] }));
      const env = { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), MONOMEM_HOME: join(dir, "om"), MONOMEM_DB_PATH: db, MONOMEM_CLIENT: "cursor" };
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, cwd: launch, stderr: "ignore" }));
      try {
        // The server asks for roots right after initialize; give it a moment to hear back before writing.
        let cwd: string | null = null;
        // Bounded by time, not tries: on a loaded runner each write took ~2 s. 35 s covers the server's 30 s roots wait.
        const until = Date.now() + 35_000;
        for (let i = 0; Date.now() < until && !(cwd && insideFolder(cwd, work)); i++) {
          await client.callTool({ name: "state_write", arguments: { title: `probe ${i}`, body: "x" } });
          const s = new Store(db);
          try {
            cwd = (s.captureDb().prepare("SELECT writer_cwd FROM notes ORDER BY id DESC LIMIT 1").get() as { writer_cwd: string | null }).writer_cwd;
          } finally {
            s.close();
          }
          if (!(cwd && insideFolder(cwd, work))) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(cwd && insideFolder(cwd, work), `writer_cwd ${cwd}`);
      } finally {
        await client.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trust: a client with several roots keeps the launch folder (picking one could miss a tainted session in another)", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
    const dir = mkdtempSync(join(tmpdir(), "mm-roots2-"));
    const launch = join(dir, "launch");
    mkdirSync(launch);
    const db = join(dir, "state.db");
    try {
      let asked!: () => void;
      const answered = new Promise<void>((r) => (asked = r));
      const client = new Client({ name: "roots-test", version: "1" }, { capabilities: { roots: {} } });
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        setImmediate(asked);
        return { roots: [{ uri: pathToFileURL(join(dir, "a")).href }, { uri: pathToFileURL(join(dir, "b")).href }] };
      });
      const env = { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), MONOMEM_HOME: join(dir, "om"), MONOMEM_DB_PATH: db, MONOMEM_CLIENT: "cursor" };
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, cwd: launch, stderr: "ignore" }));
      try {
        await answered; // the server has its answer before this write reaches it (one ordered stream)
        await client.callTool({ name: "state_write", arguments: { title: "probe", body: "x" } });
        const s = new Store(db);
        try {
          const cwd = (s.captureDb().prepare("SELECT writer_cwd FROM notes ORDER BY id DESC LIMIT 1").get() as { writer_cwd: string | null }).writer_cwd;
          assert.ok(cwd && insideFolder(cwd, launch), `writer_cwd ${cwd}`);
        } finally {
          s.close();
        }
      } finally {
        await client.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
