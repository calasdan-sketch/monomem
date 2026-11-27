import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexLine, toIndex } from "../src/mcp/index-mode.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/instructions.js";

const CLI = join(process.cwd(), "dist", "src", "cli.js");
const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;
const json = (r: unknown): Record<string, unknown> => JSON.parse(text(r).slice(text(r).indexOf("{")));

describe("index mode lines", () => {
  test("indexLine has five | parts, clips the title and removes | and newlines", () => {
    const line = indexLine({ id: 7, title: "a|b\n" + "x".repeat(200), written_by: "claude", when: "2026-11-20, 5 days ago", stale: true });
    const parts = line.split("|");
    assert.equal(parts.length, 5);
    assert.equal(parts[0], "7");
    assert.ok(parts[1].length <= 60);
    assert.equal(parts[3], "5 days ago");
    assert.equal(parts[4], "stale");
  });

  test("toIndex keeps other fields, maps results and notes, and leaves other payloads alone", () => {
    const a = toIndex({ results: [{ id: 1, title: "t" }], more: true });
    assert.deepEqual(a.hits, ["1|t|||"]);
    assert.equal(a.more, true);
    assert.equal("results" in a, false);
    assert.equal((toIndex({ notes: [{ id: 2, title: "u" }] }).hits as string[])[0], "2|u|||");
    const other = { saved: 1 };
    assert.equal(toIndex(other), other);
  });

  test("the instructions teach the loop", () => {
    assert.match(SERVER_INSTRUCTIONS, /memory_search.*detail=index.*memory_read.*memory_save.*memory_replace.*conflicts/s);
  });
});

describe("index mode over stdio", () => {
  test("search and list return index lines, far smaller than compact, and memory_read gets the full note", async () => {
    const home = mkdtempSync(join(tmpdir(), "monomem-idx-"));
    const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home } as Record<string, string>;
    const c = new Client({ name: "idx", version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "ignore" }));
    try {
      for (let i = 0; i < 8; i++) await c.callTool({ name: "memory_save", arguments: { title: `Deploy ${i}`, body: `deploy pipeline note ${i} `.repeat(40) } });
      const compact = text(await c.callTool({ name: "memory_search", arguments: { query: "deploy pipeline" } }));
      const idxRes = await c.callTool({ name: "memory_search", arguments: { query: "deploy pipeline", detail: "index" } });
      const hits = json(idxRes).hits as string[];
      assert.equal(hits.length, 8);
      assert.match(hits[0], /^\d+\|Deploy \d\|/);
      assert.ok(text(idxRes).length * 3 < compact.length, "index reply should be under a third of compact");
      const listed = json(await c.callTool({ name: "memory_list", arguments: { detail: "index" } }));
      assert.equal((listed.hits as string[]).length, 8);
      const id = Number(hits[0].split("|")[0]);
      const read = text(await c.callTool({ name: "memory_read", arguments: { id } }));
      assert.ok(read.includes("deploy pipeline note"));
      const bad = await c.callTool({ name: "memory_save", arguments: { title: "x", body: "y", detail: "index" } });
      assert.equal((bad as { isError?: boolean }).isError, true, "save does not take index");
    } finally {
      await c.close();
    }
  });
});
