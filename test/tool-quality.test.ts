// Tool-definition quality: the grader in scripts/grade-tools.mjs scores every tool a real stdio server lists (default, all,
// admin). A tool below the floor, a duplicate name, or a malformed initialize / non-JSON HTTP body fails here.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT } from "../src/config.js";
import { Store } from "../src/store.js";
import { createMcpHttpServer } from "../src/mcp-http.js";
import { initializeProblem, parseErrorBody } from "../src/mcp/rpc-errors.js";

const GRADER = pathToFileURL(join(PROJECT_ROOT, "scripts", "grade-tools.mjs")).href;
const FLOOR = 95; // every tool, every profile (today all score 100)
const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
type Graded = { tools: { name: string; score: number; issues: string[] }[]; list: string[]; mean: number };

describe("tool definitions score above the floor", () => {
  test("every tool in every profile, and the list as a whole", async () => {
    const grader = (await import(GRADER)) as { gradeAll: (cli: string) => Promise<Record<string, Graded>> };
    const res = await grader.gradeAll(CLI);
    assert.deepEqual(Object.keys(res), ["default", "all", "admin"]);
    for (const [profile, r] of Object.entries(res)) {
      assert.deepEqual(r.list, [], `${profile}: ${r.list.join("; ")}`);
      for (const g of r.tools) assert.ok(g.score >= FLOOR, `${profile}/${g.name} scored ${g.score}: ${g.issues.join("; ")}`);
    }
    assert.equal(res.default.tools.length, 7);
  });

  test("the grader catches a bad tool", async () => {
    const { gradeTool } = (await import(GRADER)) as { gradeTool: (t: unknown) => { score: number; issues: string[] } };
    const bad = gradeTool({ name: "query", description: "x", inputSchema: { type: "object", properties: { a: { type: "string" } } } });
    assert.ok(bad.score < 60 && bad.issues.length >= 4, JSON.stringify(bad));
  });
});

describe("malformed requests get JSON-RPC errors", () => {
  test("initialize: a non-text protocolVersion is a one-sentence invalid-params problem", () => {
    assert.match(initializeProblem({ protocolVersion: 123, capabilities: {}, clientInfo: {} }) ?? "", /protocolVersion as text/);
    assert.match(initializeProblem(undefined) ?? "", /needs params/);
    assert.equal(initializeProblem({ protocolVersion: "2025-06-18" }), null);
  });
  test("an HTTP body that is not JSON is -32700 with id null", () => {
    const b = parseErrorBody();
    assert.equal(b.error.code, -32700);
    assert.equal(b.id, null);
  });

  describe("over HTTP", () => {
    let store: Store;
    let server: ReturnType<typeof createMcpHttpServer>;
    let base: string;
    before(async () => {
      store = new Store(":memory:");
      server = createMcpHttpServer(store, "tq-token");
      await new Promise<void>((r) => server.listen(0, r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    });
    const post = (body: string) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer tq-token" }, body });

    test("malformed JSON: 400 with a -32700 envelope", async () => {
      const res = await post("{bad");
      assert.equal(res.status, 400);
      const j = (await res.json()) as { error: { code: number } };
      assert.equal(j.error.code, -32700);
    });
    test("initialize with protocolVersion 123: -32602, short message, no validator dump", async () => {
      const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 123, capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
      const text = await res.text();
      const m = /\{.*\}/s.exec(text);
      const j = JSON.parse(m![0]) as { error: { code: number; message: string } };
      assert.equal(j.error.code, -32602);
      assert.ok(j.error.message.length < 200 && !/invalid_type|zod/i.test(j.error.message), j.error.message);
    });
  });
});
