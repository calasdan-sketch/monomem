// Scope / forget MATRIX. Two identical stores: A holds the visible notes PLUS one hidden note per restriction (other
// namespace, above the sensitivity ceiling, distrusted writer, archived, replaced, held in quarantine); B holds the visible
// notes only. Every way to read or list a note (REST, MCP, store-level injection / why / export) is run as a restricted caller
// against BOTH stores. For a hidden note the answer must be the same bytes as for a note that never existed (no oracle), and the
// canary text, titles, ids and counts of hidden notes must appear in no reply (no leak). Data-driven: add a probe or a
// restriction to the tables and every cell is checked.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, QuarantinedError } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { injectContext } from "../src/context-inject.js";
import { exportMarkdown } from "../src/sync.js";
import { buildHandoffDigest } from "../src/handoff-digest.js";
import { blame, askTimeline } from "../src/blame.js";
import type { TokenEntry } from "../src/config.js";

const WORK_RW = "scope-matrix-work-rw-token-0000000000000001";
const WORK_ADMIN = "scope-matrix-work-admin-token-000000000002";
const TOKENS: TokenEntry[] = [
  { token: WORK_RW, scope: "write", label: "work-rw", namespace: "work", max_sensitivity: "internal" },
  { token: WORK_ADMIN, scope: "admin", label: "work-admin", namespace: "work", max_sensitivity: "internal" },
];

const VISIBLE = [
  { title: "Deploy port is 8080 for the api", body: "The api server listens on port 8080 behind the proxy. Deploy on fridays.", tags: ["ops"] },
  { title: "Zebra herd migration notes", body: "zebra giraffe antelope savanna migration herd watering hole", tags: ["animals"] },
  { title: "Password rotation policy", body: "Rotate the database password every ninety days and record the date." },
];

interface Hidden {
  restriction: string;
  canary: string;
  /** Management views (history, why) of an archived or replaced note are deliberate: they are how it is restored. */
  managed?: boolean;
}
const HIDDEN: Hidden[] = [
  { restriction: "other-namespace", canary: "ZQXNSPACE" },
  { restriction: "above-ceiling", canary: "ZQXPRIVATE" },
  { restriction: "distrusted-writer", canary: "ZQXEVIL" },
  { restriction: "archived", canary: "ZQXARCHIVED", managed: true },
  { restriction: "replaced", canary: "ZQXREPLACED", managed: true },
  { restriction: "held", canary: "ZQXHELD" },
];
const CJK = "机密项目代号"; // every hidden note carries this phrase so the CJK top-up path has something to find

const body = (c: string): string => `The api deploy port is 9090 now, not 8080. ${c} ${CJK} zebra herd secret ${c}`;
const as = <T>(label: string, max: "internal" | undefined, fn: () => T): T => actorStore.run({ label, authed: true, ...(max ? { maxSensitivity: max } : {}) }, fn);

function build(withHidden: boolean): { store: Store; hiddenIds: number[]; managedIds: number[]; distrustedIds: number[] } {
  const store = new Store(":memory:");
  const hiddenIds: number[] = [];
  const managedIds: number[] = [];
  const distrustedIds: number[] = [];
  as("good", undefined, () => VISIBLE.forEach((v) => store.create({ namespace: "work", ...v })));
  const nw = as("good", undefined, () => store.create({ namespace: "work", title: "Replacement of the retired note", body: "fresh text", tags: ["ops"] }));
  if (!withHidden) return { store, hiddenIds, managedIds, distrustedIds };
  const add = (c: string, extra: Record<string, unknown> = {}, writer = "good"): number => {
    const n = as(writer, undefined, () => store.create({ namespace: "work", title: `${c} deploy port is 9090`, body: body(c), tags: ["ops"], ...extra } as never));
    hiddenIds.push(n.id);
    return n.id;
  };
  const o = as("good", undefined, () => store.create({ namespace: "other", title: `ZQXNSPACE deploy port is 9090`, body: body("ZQXNSPACE"), tags: ["ops"] }));
  hiddenIds.push(o.id);
  add("ZQXPRIVATE", { sensitivity: "private" });
  distrustedIds.push(add("ZQXEVIL", {}, "evil"));
  store.distrustAdd("work", "evil");
  const arch = add("ZQXARCHIVED");
  store.archive(arch);
  managedIds.push(arch);
  const old = add("ZQXREPLACED");
  managedIds.push(old);
  const oldRev = store.read(old)!.rev;
  store.supersedeCommit({ oldIds: [old], oldRevs: [oldRev], newId: nw.id, actor: "good", nonce: "scope-matrix", expiresMs: Date.now() + 60_000 });
  store.setApproveFirst("other", true);
  try {
    as("agent", undefined, () => store.create({ namespace: "other", title: "ZQXHELD deploy port is 9090", body: body("ZQXHELD") }));
  } catch (e) {
    if (!(e instanceof QuarantinedError)) throw e;
  }
  store.setApproveFirst("other", false);
  return { store, hiddenIds, managedIds, distrustedIds };
}

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
const VOLATILE = /"(elapsed_ms|took_ms|duration_ms|uptime[a-z_]*|server_time|now|ms|latency_ms|tookMs)":\s*[\d.]+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g; // the server id differs per store
const norm = (s: string): string => s.replace(UUID, "<srv>").replace(TS, "<ts>").replace(VOLATILE, '"<v>":0');

interface Probe { name: string; method: string; path: string; body?: unknown; byId?: boolean }

const RESTPROBES = (ids: number[]): Probe[] => {
  const base: Probe[] = [
    { name: "list", method: "GET", path: "/notes" },
    { name: "list-limit", method: "GET", path: "/notes?limit=1000&include_archived=1" },
    { name: "search-port", method: "GET", path: "/search?q=deploy+port+9090" },
    { name: "search-canary-ns", method: "GET", path: "/search?q=ZQXNSPACE" },
    { name: "search-cjk", method: "GET", path: `/search?q=${encodeURIComponent(CJK)}` },
    { name: "search-cjk-sup", method: "GET", path: `/search?q=${encodeURIComponent(CJK)}&include_superseded=1` },
    { name: "search-sup", method: "GET", path: "/search?q=deploy+port&include_superseded=1&include_archived=1" },
    { name: "search-synonym", method: "GET", path: "/search?q=secret+confidential+zebra" },
    { name: "search-other-ns", method: "GET", path: "/search?q=port&namespace=other" },
    { name: "relevant", method: "POST", path: "/relevant", body: { query: "deploy port 9090 api" } },
    { name: "stats", method: "GET", path: "/stats" },
    { name: "export", method: "GET", path: "/export" },
    { name: "export-attest", method: "GET", path: "/export?attest=1" },
    { name: "changes", method: "GET", path: "/changes?since=2000-01-01T00:00:00Z&limit=500" },
    { name: "index", method: "GET", path: "/index?limit=500" },
    { name: "index-q", method: "GET", path: "/index?q=deploy+port&limit=500" },
    { name: "sessions", method: "GET", path: "/sessions" },
    { name: "quarantine", method: "GET", path: "/quarantine" },
    { name: "insights", method: "GET", path: "/insights" },
    { name: "audit", method: "GET", path: "/audit" },
    { name: "access", method: "GET", path: "/access" },
    { name: "digest", method: "GET", path: "/digest?since=2000-01-01T00:00:00Z" },
    { name: "digest-own", method: "GET", path: "/digest?since=2000-01-01T00:00:00Z&include_own=1" },
    { name: "quality", method: "GET", path: "/quality" },
    { name: "pinned", method: "GET", path: "/pinned" },
    { name: "ui-state", method: "GET", path: "/ui/state" },
    { name: "ui-needs", method: "GET", path: "/ui/needs-you" },
    { name: "ui-review", method: "GET", path: "/ui/review" },
    { name: "get-ids", method: "POST", path: "/get", body: { ids: ids } },
    // monomem blame / ask (REST): same read policy as /search. Replaced notes are an admin opt-in (include_ paths are lenient below).
    { name: "blame-port", method: "GET", path: "/blame?q=deploy+port+9090" },
    { name: "blame-canaries", method: "GET", path: "/blame?q=ZQXNSPACE+ZQXPRIVATE+ZQXEVIL+ZQXARCHIVED+ZQXREPLACED+ZQXHELD" },
    { name: "blame-cjk", method: "GET", path: `/blame?q=${encodeURIComponent(CJK)}` },
    { name: "blame-other-ns", method: "GET", path: "/blame?q=port&namespace=other" },
    { name: "blame-sup", method: "GET", path: "/blame?q=deploy+port&include_superseded=1" },
    { name: "ask-port", method: "GET", path: "/ask?q=deploy+port+9090" },
    { name: "ask-canaries", method: "GET", path: "/ask?q=ZQXNSPACE+ZQXPRIVATE+ZQXEVIL+ZQXARCHIVED+ZQXREPLACED+ZQXHELD" },
    { name: "ask-cjk", method: "GET", path: `/ask?q=${encodeURIComponent(CJK)}&since=7d` },
    { name: "ask-sup", method: "GET", path: "/ask?q=deploy+port&include_superseded=1" },
  ];
  const perId = (i: number): Probe[] =>
    [
      ["read", "GET", `/notes/${i}`],
      ["read-neighbors", "GET", `/notes/${i}?neighbors=true`],
      ["read-distrusted", "GET", `/notes/${i}?include_distrusted=1`],
      ["history", "GET", `/notes/${i}/history`],
      ["history-diff", "GET", `/notes/${i}/history?diff=1`],
      ["history-distrusted", "GET", `/notes/${i}/history?include_distrusted=1&diff=1`],
      ["touched", "GET", `/notes/${i}/touched`],
      ["readers", "GET", `/notes/${i}/readers`],
      ["timeline", "GET", `/timeline?anchor=${i}`],
    ].map(([n, m, p]) => ({ name: `${n}#${i}`, method: m, path: p, byId: true }));
  return [...base, ...ids.flatMap(perId), ...[1, 2, 3].flatMap(perId)];
};

const MCP_TOOLS = (ids: number[]): Array<[string, Record<string, unknown>]> => [
  ["memory_list", {}],
  ["memory_search", { query: "deploy port 9090" }],
  ["memory_search", { query: CJK }],
  ["memory_search", { query: "ZQXNSPACE ZQXPRIVATE ZQXEVIL ZQXARCHIVED ZQXREPLACED ZQXHELD" }],
  ["memory_catch_up", {}],
  ["memory_review", {}],
  ["memory_held", {}],
  ["memory_usage", {}],
  ["memory_sessions", {}],
  ["memory_trust", {}],
  ["memory_tidy", {}],
  ...ids.flatMap((i): Array<[string, Record<string, unknown>]> => [
    ["memory_read", { id: i }],
    ["memory_read", { id: i, neighbors: true }],
    ["memory_history", { id: i }],
    ["memory_replace", { action: "preview", old_ids: [i], title: "x", body: "y" }],
    ["memory_replace", { old_ids: [i], title: "x", body: "y" }],
    ["memory_archive", { id: i }],
    ["memory_receipt", { id: i }],
    ["memory_why", { id: i }],
    ["memory_since", { since: 0 }],
  ]),
];

async function startRest(store: Store): Promise<{ call: (t: string, p: Probe) => Promise<string>; close: () => Promise<void> }> {
  const server = createApiServer(store, TOKENS);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async (token, p) => {
      const r = await fetch(base + p.path, { method: p.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: p.body ? JSON.stringify(p.body) : undefined });
      return `${r.status} ${await r.text()}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function startMcp(store: Store): Promise<{ call: (n: string, a: Record<string, unknown>) => Promise<string>; read: (uri: string) => Promise<string>; prompt: (n: string, a: Record<string, string>) => Promise<string>; close: () => Promise<void> }> {
  const server = createMcpServer(store, "admin", { namespace: "work", tools: "all" }, { label: "work-admin", authed: true, maxSensitivity: "internal" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return {
    read: async (uri) => {
      try {
        return `ok ${JSON.stringify((await client.readResource({ uri })).contents)}`;
      } catch (e) {
        return `throw ${(e as Error).message}`;
      }
    },
    prompt: async (n, a) => {
      try {
        return `ok ${JSON.stringify((await client.getPrompt({ name: n, arguments: a })).messages)}`;
      } catch (e) {
        return `throw ${(e as Error).message}`;
      }
    },
    call: async (name, args) => {
      try {
        const r: any = await client.callTool({ name, arguments: args });
        return `${r.isError ? "error" : "ok"} ${(r.content ?? []).map((x: any) => x.text ?? "").join("\n")}`;
      } catch (e) {
        return `throw ${(e as Error).message}`;
      }
    },
    close: () => client.close(),
  };
}

const ALL_CANARIES = HIDDEN.map((h) => h.canary);
/** Feeds and counters an administrator reads: they show retired notes (blank title) and, for an admin, counts. */
const FEED_TOOLS = ["memory_catch_up", "memory_since", "memory_usage"];
const MANAGED = ["ZQXARCHIVED", "ZQXREPLACED"];
const leaks = (s: string, allow: string[] = []): string[] => [...ALL_CANARIES, "deploy port is 9090", CJK].filter((c) => s.includes(c) && !allow.includes(c));
/** Opt-in and backup surfaces show retired (archived, replaced) notes and a distrusted writer's notes on purpose. */
const LENIENT = /include_|[/]changes|[/]export|[/]stats/;
const lenientAllow = (path: string): string[] => (LENIENT.test(path) ? [...MANAGED, "ZQXEVIL", "deploy port is 9090", CJK] : []);

describe("scope matrix: restricted caller, store with hidden notes (A) vs store without (B)", () => {
  let A: ReturnType<typeof build>;
  let B: ReturnType<typeof build>;
  let restA: Awaited<ReturnType<typeof startRest>>;
  let restB: Awaited<ReturnType<typeof startRest>>;
  let mcpA: Awaited<ReturnType<typeof startMcp>>;
  let mcpB: Awaited<ReturnType<typeof startMcp>>;
  let ids: number[];
  // An admin may open the history of a distrusted writer's note to review it (history.test.ts pins this); its current title and writer are blanked, so the canary check still applies.
  const adminHistory = (path: string): boolean => /[/]history/.test(path) && A.distrustedIds.some((d) => path.includes(`/${d}/`));

  before(async () => {
    A = build(true);
    B = build(false);
    ids = [...A.hiddenIds, A.store.list({ namespace: "work" }).notes.length + 50]; // plus an id nobody ever had
    restA = await startRest(A.store);
    restB = await startRest(B.store);
    mcpA = await startMcp(A.store);
    mcpB = await startMcp(B.store);
  });
  after(async () => {
    await Promise.all([restA.close(), restB.close(), mcpA.close(), mcpB.close()]);
    A.store.close();
    B.store.close();
  });

  test("fixture: every restriction produced a hidden note, and the operator can see them", () => {
    const all = A.store.list({}).notes.map((n) => n.title).join("|");
    assert.match(all, /ZQXNSPACE/);
    assert.match(all, /ZQXPRIVATE/);
    assert.equal(A.store.listQuarantine().length, 1, "held write is in quarantine");
    assert.ok(A.hiddenIds.length >= 5, `hidden ids: ${A.hiddenIds}`);
  });

  for (const token of [WORK_RW, WORK_ADMIN]) {
    test(`REST ${token === WORK_RW ? "write" : "admin"} token: hidden notes answer exactly like no note, no canary anywhere`, async () => {
      const bad: string[] = [];
      for (const p of RESTPROBES(ids)) {
        if (A.managedIds.some((m) => p.path.includes(`/${m}`) || p.path.includes(`=${m}`))) continue; // retired notes stay reachable by id on purpose (restore, undo)
        const [a, b] = await Promise.all([restA.call(token, p), restB.call(token, p)]);
        const l = leaks(a, lenientAllow(p.path));
        if (l.length) bad.push(`LEAK ${p.method} ${p.path} -> ${l.join(",")}`);
        if (!LENIENT.test(p.path) && !adminHistory(p.path) && norm(a) !== norm(b)) bad.push(`DIFF ${p.method} ${p.path} | ${firstDiff(norm(a), norm(b))}`);
      }
      assert.equal(bad.join("\n"), "");
    });
  }

  test("MCP (namespace pin + ceiling): same answer as a store without the hidden notes", async () => {
    const bad: string[] = [];
    for (const [name, args] of MCP_TOOLS(ids)) {
      if (A.managedIds.includes(args.id as number) || (args.old_ids as number[] | undefined)?.some((m) => A.managedIds.includes(m))) continue;
      const a = await mcpA.call(name, args); // one after the other: the duplicate scan is single-flight process-wide
      const b = await mcpB.call(name, args);
      const feed = FEED_TOOLS.includes(name);
      const l = leaks(a, feed ? [...MANAGED, "deploy port is 9090"] : []);
      if (l.length) bad.push(`LEAK ${name} ${JSON.stringify(args)} -> ${l.join(",")}`);
      if (name !== "memory_trust" && !(name === "memory_history" && A.distrustedIds.includes(args.id as number)) && !feed && norm(a) !== norm(b)) bad.push(`DIFF ${name} ${JSON.stringify(args)} | ${firstDiff(norm(a), norm(b))}`);
    }
    assert.equal(bad.join("\n"), "");
  });

  test("MCP resources and prompts: same answer as a store without the hidden notes, no canary", async () => {
    const bad: string[] = [];
    const uris = ["monomem://recent", "monomem://held", ...ids.filter((i) => !A.managedIds.includes(i)).map((i) => `monomem://notes/${i}`), "monomem://notes/1", "monomem://notes/2", "monomem://notes/3"];
    for (const u of uris) {
      const a = await mcpA.read(u);
      const b = await mcpB.read(u);
      if (leaks(a).length) bad.push(`LEAK ${u} -> ${leaks(a).join(",")}`);
      if (norm(a) !== norm(b)) bad.push(`DIFF ${u} | ${firstDiff(norm(a), norm(b))}`);
    }
    for (const [n, args] of [["recap", { topic: "deploy port" }], ["recap", {}], ["handoff", {}], ["what-changed", {}], ["remember-decision", { decision: "use port 8080", reason: "proxy" }]] as const) {
      const a = await mcpA.prompt(n, { ...args });
      const b = await mcpB.prompt(n, { ...args });
      if (leaks(a).length) bad.push(`LEAK prompt ${n} -> ${leaks(a).join(",")}`);
      if (a !== b) bad.push(`DIFF prompt ${n}`);
    }
    assert.equal(bad.join(String.fromCharCode(10)), "");
  });

  test("store-level surfaces (session-start context, why, markdown sync export) as the restricted caller", async () => {
    const run = <T>(s: Store, fn: () => T): T => actorStore.run({ label: "work-admin", authed: true, maxSensitivity: "internal", readable: ["work"] }, fn);
    const dirs: string[] = [];
    const bad: string[] = [];
    try {
      for (const q of [undefined, "deploy port 9090", CJK]) {
        const [a, b] = await Promise.all([run(A.store, () => injectContext(A.store, { namespace: "work", signals: { branch: "", files: [], recent: [] } as never, ...(q ? { bodyHits: async () => null } : {}) })), run(B.store, () => injectContext(B.store, { namespace: "work", signals: { branch: "", files: [], recent: [] } as never }))]);
        if (leaks(a).length) bad.push(`LEAK injectContext ${q} -> ${leaks(a)}`);
        if (norm(a) !== norm(b)) bad.push(`DIFF injectContext ${q} | ${firstDiff(norm(a), norm(b))}`);
      }
      const dg = (s: Store): string => run(s, () => buildHandoffDigest(s, { since: "2000-01-01T00:00:00Z", namespaces: ["work"], self: "nobody", includeHeld: true }).text);
      if (leaks(dg(A.store)).length) bad.push(`LEAK handoff digest -> ${leaks(dg(A.store))}`);
      if (norm(dg(A.store)) !== norm(dg(B.store))) bad.push(`DIFF handoff digest | ${firstDiff(norm(dg(A.store)), norm(dg(B.store)))}`);
      // blame / ask as the restricted caller (the CLI functions behind the REST routes): same bytes with and without the hidden notes.
      const scope = { namespaces: ["work"], includeSuperseded: false, includeDistrusted: false, showHeld: true };
      for (const q of ["deploy port 9090", "ZQXNSPACE ZQXPRIVATE ZQXEVIL ZQXHELD", CJK]) {
        const [ba, bb, ta, tb] = await Promise.all([run(A.store, () => blame(A.store, q, scope)), run(B.store, () => blame(B.store, q, scope)), run(A.store, () => askTimeline(A.store, q, scope)), run(B.store, () => askTimeline(B.store, q, scope))]);
        const [xa, xb] = [JSON.stringify([ba, ta]), JSON.stringify([bb, tb])];
        if (leaks(xa).length) bad.push(`LEAK blame/ask ${q} -> ${leaks(xa)}`);
        if (norm(xa).replace(/\d+/g, "#") !== norm(xb).replace(/\d+/g, "#")) bad.push(`DIFF blame/ask ${q} | ${firstDiff(norm(xa), norm(xb))}`);
      }
      const out = (s: Store): string => {
        const d = mkdtempSync(join(tmpdir(), "scope-export-"));
        dirs.push(d);
        run(s, () => exportMarkdown(s, d, { namespace: "work", maxSensitivity: "internal" }));
        const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)).map((x) => `${f}/${x}`) : [f]));
        return files(d).sort().map((f) => `${f.replace(/\d+/g, "#")}:${readFileSync(join(d, f), "utf8")}`).join("\n");
      };
      const [ea, eb] = [out(A.store), out(B.store)];
      if (leaks(ea, ["ZQXEVIL", ...MANAGED]).length) bad.push(`LEAK markdown export -> ${leaks(ea, ["ZQXEVIL", ...MANAGED])}`);
      if (eb.length === 0) bad.push("empty export");
    } finally {
      dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
    assert.equal(bad.join("\n"), "");
  });
});

describe("scope matrix: save replies (conflicts_with, similar_note) never name a hidden note", () => {
  let A: ReturnType<typeof build>;
  let B: ReturnType<typeof build>;
  let restA: Awaited<ReturnType<typeof startRest>>;
  let restB: Awaited<ReturnType<typeof startRest>>;
  let mcpA: Awaited<ReturnType<typeof startMcp>>;
  let mcpB: Awaited<ReturnType<typeof startMcp>>;
  before(async () => {
    A = build(true);
    B = build(false);
    restA = await startRest(A.store);
    restB = await startRest(B.store);
    mcpA = await startMcp(A.store);
    mcpB = await startMcp(B.store);
  });
  after(async () => {
    await Promise.all([restA.close(), restB.close(), mcpA.close(), mcpB.close()]);
    A.store.close();
    B.store.close();
  });
  // Ids and times legitimately differ (A holds more notes); every other byte must match.
  const shape = (s: string): string => norm(s).replace(/\d+/g, "#");

  // A writer that guesses a hidden note's title, repeats its sentence, or contradicts it must learn nothing from the reply.
  const SAVES = HIDDEN.flatMap((h) => [
    { title: `${h.canary} deploy port is 9090`, body: body(h.canary) }, // the hidden note's own words
    { title: `${h.canary} deploy port is 7777`, body: `The api deploy port is 7777 now, not 9090. ${h.canary} zebra herd` }, // a contradiction of it
  ]);

  test("REST POST /notes and MCP memory_save: same reply as when the hidden notes do not exist", async () => {
    const bad: string[] = [];
    for (const sv of SAVES) {
      const [ra, rb] = [await restA.call(WORK_RW, { name: "save", method: "POST", path: "/notes", body: sv }), await restB.call(WORK_RW, { name: "save", method: "POST", path: "/notes", body: sv })];
      const ma = await mcpA.call("memory_save", { ...sv, title: `${sv.title} mcp` });
      const mb = await mcpB.call("memory_save", { ...sv, title: `${sv.title} mcp` });
      for (const [what, x] of [["REST", ra], ["MCP", ma]] as const) {
        // Which visible notes get named can shift with ranking statistics; naming a HIDDEN note by id or title never may.
        const named = [...x.matchAll(/"(?:conflicts_with|similar_note)":(\[?\{[^]*?\})/g)].flatMap((m) => [...m[1].matchAll(/"id":(\d+)/g)].map((i) => Number(i[1])));
        const hit = named.filter((n) => A.hiddenIds.includes(n));
        if (hit.length) bad.push(`${what} ${sv.title} names hidden note(s) ${hit}`);
      }
    }
    assert.equal(bad.join(String.fromCharCode(10)), "");
  });

  test("after those saves, search and the conflict reorder answer the same with and without the hidden notes", async () => {
    const bad: string[] = [];
    for (const q of ["deploy port", "deploy port 7777", "port 8080 api", CJK]) {
      const [a, b] = [await restA.call(WORK_RW, { name: "s", method: "GET", path: `/search?q=${encodeURIComponent(q)}` }), await restB.call(WORK_RW, { name: "s", method: "GET", path: `/search?q=${encodeURIComponent(q)}` })];
      const titlesOf = (x: string): string => [...x.matchAll(/"title":"([^"]*)"/g)].map((m) => m[1]).filter((t) => !ALL_CANARIES.some((c) => t.includes(c))).join("|");
      if (titlesOf(a).split("|").filter((t) => /^(Deploy port is 8080|Zebra|Password|Replacement)/.test(t)).join() !== titlesOf(b).split("|").filter((t) => /^(Deploy port is 8080|Zebra|Password|Replacement)/.test(t)).join()) bad.push(`ORDER ${q}: ${titlesOf(a)} !== ${titlesOf(b)}`);
    }
    assert.equal(bad.join(String.fromCharCode(10)), "");
  });
});

/** A short window around the first byte where two replies differ. */
function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `...${a.slice(Math.max(0, i - 40), i + 120)} !== ${b.slice(Math.max(0, i - 40), i + 120)}`;
}

describe("scope matrix: a hidden best match does not shadow a visible near-duplicate", () => {
  test("similar_note names the visible twin even when a distrusted writer's note is closer", () => {
    const store = new Store(":memory:");
    const text = "the nightly backup job runs at three in the morning and copies the database to the offsite drive";
    const visible = as("good", undefined, () => store.create({ namespace: "work", title: "Nightly backup job", body: text }));
    as("evil", undefined, () => store.create({ namespace: "work", title: "Nightly backup job", body: `${text} now` }));
    store.distrustAdd("work", "evil");
    const fresh = as("good", undefined, () => store.create({ namespace: "work", title: "Nightly backup job", body: `${text} now` }));
    const sim = as("good", "internal", () => store.similarNote(fresh.id, 0.3));
    assert.equal(sim?.id, visible.id, "the visible twin is reported; the distrusted note is neither named nor does it hide the twin");
    store.close();
  });
});
