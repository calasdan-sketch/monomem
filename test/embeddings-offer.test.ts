// C22: setup offers meaning search only when a local Ollama has nomic-embed-text; the entry gets auto mode, never "on", and
// the hooks never get it.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localEmbeddingsAvailable } from "../src/embeddings-offer.js";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

describe("local embeddings probe", () => {
  test("true only when Ollama lists nomic-embed-text", async () => {
    assert.equal(await localEmbeddingsAvailable({}, answer({ models: [{ name: "nomic-embed-text:latest" }] })), true);
    assert.equal(await localEmbeddingsAvailable({}, answer({ models: [{ name: "gpt-oss:20b" }] })), false);
    assert.equal(await localEmbeddingsAvailable({}, answer({}, false)), false);
    assert.equal(await localEmbeddingsAvailable({}, async () => { throw new Error("ECONNREFUSED"); }), false);
  });
  test("never probes when the person already chose, or in the test suite", async () => {
    let called = 0;
    const f = async () => { called++; return { ok: true, json: async () => ({ models: [{ name: "nomic-embed-text" }] }) }; };
    assert.equal(await localEmbeddingsAvailable({ MONOMEM_EMBEDDINGS: "off" }, f), false);
    assert.equal(await localEmbeddingsAvailable({ MONOMEM_EMBED_URL: "http://elsewhere/v1/embeddings" }, f), false);
    assert.equal(await localEmbeddingsAvailable({ MONOMEM_NO_SERVER_PROBE: "1" }, f), false);
    assert.equal(called, 0);
  });
});

describe("setup with embeddings found", () => {
  async function run(embeddings: boolean): Promise<{ entry: { env?: Record<string, string> }; out: string; settings: string }> {
    const root = mkdtempSync(join(tmpdir(), "om-embed-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}\n");
    const e: SetupEnv = { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: "/usr/local/bin/node", cliPath: CLI, version: "1.7.0", now: () => new Date("2026-11-16T12:00:00Z") };
    const lines: string[] = [];
    const io: SetupIO = { interactive: true, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "y" };
    const code = await runSetup(e, io, { ...DEFAULT_OPTIONS, yes: true, hook: "yes", capture: "no", noTestNote: true, noDoctor: true, only: ["claude-code"], embeddings });
    assert.equal(code, 0, lines.join("\n"));
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    let settings = "";
    try {
      settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    } catch {
      /* no hooks file */
    }
    return { entry: cfg.mcpServers.monomem, out: lines.join("\n"), settings };
  }

  test("the new entry gets MONOMEM_EMBEDDINGS=auto and the plan says so; the hooks do not", async () => {
    const r = await run(true);
    assert.equal(r.entry.env?.MONOMEM_EMBEDDINGS, "auto");
    assert.match(r.out, /Found Ollama with nomic-embed-text/);
    assert.match(r.settings, /recall/, "the hook was written");
    assert.doesNotMatch(r.settings, /MONOMEM_EMBEDDINGS/);
  });

  test("without it nothing changes", async () => {
    const r = await run(false);
    assert.equal(r.entry.env?.MONOMEM_EMBEDDINGS, undefined);
    assert.doesNotMatch(r.out, /Ollama/);
  });
});
