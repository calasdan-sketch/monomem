#!/usr/bin/env node
// Dumps Monomem's visible surface so a refactor can prove it changed nothing:
//   node scripts/dump-surface.mjs <out-dir>        (run `npm run build` first)
// Writes mcp-tools.json (tools/list for several profiles), routes.txt (every REST route probed with an admin, a read and
// no key), schema.sql (a fresh database), and cli-*.txt (help, help --all, doctor, trust/token/connect). Everything runs
// in a throwaway home under <out-dir>/home: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, MONOMEM_HOME and ONEMEMORY_HOME
// all point there, so no real data folder or app config is read or written.
// Compare two runs with:  diff -r <before> <after>   (the home folder is removed at the end).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const out = resolve(process.argv[2] ?? "surface-dump");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = (p) => pathToFileURL(join(root, "dist", "src", p)).href;
const home = join(out, "home");
rmSync(out, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const scratchEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(MONOMEM_|ONEMEMORY_|CLAUDE_BRIDGE_)/.test(k)) env[k] = v;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    MONOMEM_HOME: join(home, "data"),
    ONEMEMORY_HOME: join(home, "data"),
    MONOMEM_NO_SERVER_PROBE: "1",
    MONOMEM_PORT: "1",
    NO_COLOR: "1",
  };
};
// This process too: config.js reads the environment when it loads.
const env0 = scratchEnv();
for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k];
Object.assign(process.env, env0);

// Machine- and run-specific bits that are not part of the surface.
const scrub = (s) =>
  s
    .split(home).join("<HOME>")
    .split(home.replace(/\\/g, "/")).join("<HOME>")
    .split(home.replace(/\\/g, "\\\\")).join("<HOME>")
    .split(root).join("<ROOT>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, "<TIME>")
    .replace(/\b\d+(\.\d+)? ?ms\b/g, "<N>ms")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/signing key [0-9a-f]{16}/g, "signing key <KEYID>")
    .replace(/[0-9a-f]{32,}/g, "<HEX>");

// ---- MCP tools/list ----
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Store } = await import(dist("store.js"));
const { createMcpServer } = await import(dist("mcp-server-core.js"));
async function listTools(toolsEnv, scope, opts, conn) {
  if (toolsEnv === undefined) delete process.env.MONOMEM_TOOLS;
  else process.env.MONOMEM_TOOLS = toolsEnv;
  const store = new Store(":memory:");
  const server = createMcpServer(store, scope, opts, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dump", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const { tools } = await client.listTools();
  await client.close();
  store.close();
  delete process.env.MONOMEM_TOOLS;
  return tools;
}
const profiles = {
  default: await listTools(undefined, "admin", {}, {}),
  all: await listTools("all", "admin", {}, {}),
  "all-read-scope": await listTools("all", "read", {}, {}),
  "all-namespaced": await listTools("all", "admin", { namespace: "work", readsFrom: { work: ["shared"] } }, {}),
  "all-local-stdio": await listTools("all", "admin", {}, { local: true }),
  "list-explicit": await listTools("memory_history,task_put", "admin", {}, {}),
  // 1.6: the 1.5 names. "legacy-1.5" must equal 1.5's "default" byte for byte, "legacy-1.5,all" 1.5's "all".
  "legacy-1.5": await listTools("legacy-1.5", "admin", {}, {}),
  "legacy-1.5-all": await listTools("legacy-1.5,all", "admin", {}, {}),
  "legacy-1.5-all-local-stdio": await listTools("legacy-1.5,all", "admin", {}, { local: true }),
  "legacy-1.5-list-explicit": await listTools("legacy-1.5,memory_history,task_put", "admin", {}, {}),
};
writeFileSync(join(out, "mcp-tools.json"), JSON.stringify(profiles, null, 2) + "\n");

// ---- schema of a fresh database ----
{
  const db = join(home, "schema.db");
  const store = new Store(db);
  store.close();
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(db);
  const rows = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const uv = raw.prepare("PRAGMA user_version").get();
  raw.close();
  writeFileSync(join(out, "schema.sql"), `-- user_version ${JSON.stringify(uv)}\n` + rows.map((r) => `-- ${r.type} ${r.name} (${r.tbl_name})\n${r.sql ?? ""};`).join("\n") + "\n");
}

// ---- REST routes ----
{
  const { createApiServer } = await import(dist("api.js"));
  const store = new Store(":memory:");
  const ADMIN = "dump-admin-token-0123456789";
  const READ = "dump-read-token-0123456789";
  const { sha256Hex } = await import(dist("config.js"));
  const server = createApiServer(store, [
    { token_sha256: sha256Hex(ADMIN), scope: "admin", label: "primary" },
    { token_sha256: sha256Hex(READ), scope: "read", label: "reader" },
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const routes = [
    ["GET", "/health"], ["GET", "/ready"], ["GET", "/proof?nonce=00"], ["GET", "/"], ["GET", "/ui"], ["GET", "/favicon.ico"],
    ["GET", "/dashboard.js"], ["POST", "/login"], ["GET", "/sign"], ["GET", "/signer.js"], ["GET", "/whoami"], ["GET", "/status"],
    ["GET", "/tokens"], ["POST", "/tokens"], ["DELETE", "/tokens/nobody"],
    ["POST", "/notes", { title: "dump note", body: "one" }], ["POST", "/notes", { title: "dump two", body: "two words" }],
    ["GET", "/notes"], ["GET", "/notes/1"], ["PUT", "/notes/1", { body: "changed" }], ["GET", "/notes/999"],
    ["POST", "/notes/1/confirm"], ["POST", "/notes/1/flag", { reason: "x" }], ["POST", "/notes/2/archive"], ["POST", "/notes/2/restore"],
    ["GET", "/notes/1/history"], ["POST", "/notes/1/history/restore"], ["DELETE", "/notes/999"],
    ["GET", "/search?q=dump"], ["POST", "/relevant", { message: "dump note" }], ["POST", "/get", { ids: [1] }],
    ["GET", "/index"], ["GET", "/timeline"], ["GET", "/sessions"], ["GET", "/sessions/none"], ["GET", "/changes"], ["POST", "/ack"],
    ["GET", "/stats"], ["GET", "/export"], ["POST", "/import"], ["POST", "/rebuild-edges"], ["POST", "/sweep-expired"],
    ["GET", "/quality"], ["GET", "/quarantine"], ["GET", "/quarantine/1/context"], ["POST", "/quarantine/1/approve"],
    ["POST", "/quarantine/1/reject"], ["POST", "/quarantine/1/keep-history"],
    ["GET", "/approve-first"], ["POST", "/approve-first"], ["GET", "/pinned"], ["POST", "/pinned"],
    ["POST", "/rollback/preview"], ["POST", "/rollback/confirm"], ["GET", "/access"], ["GET", "/flood"], ["POST", "/flood/resume"],
    ["GET", "/audit"], ["GET", "/insights"], ["GET", "/catch-up"], ["GET", "/handoffs"], ["POST", "/handoffs"],
    ["GET", "/files/timeline"], ["POST", "/capture"], ["GET", "/runner/status"],
    ["GET", "/tasks"], ["POST", "/tasks"], ["GET", "/tasks/1"], ["PUT", "/tasks/1"], ["POST", "/tasks/1/claim"], ["POST", "/tasks/1/approve"],
    ["GET", "/trust"], ["POST", "/trust/distrust"], ["DELETE", "/trust/distrust"], ["POST", "/trust/attesters"],
    ["DELETE", "/trust/attesters/0123456789abcdef"], ["POST", "/trust/revoked"], ["DELETE", "/trust/revoked/0123456789abcdef"],
    ["POST", "/supersede/preview"], ["POST", "/supersede/confirm"], ["POST", "/supersede/undo"],
    ["GET", "/no-such-route"], ["PATCH", "/notes/1"],
  ];
  const lines = [];
  const shape = (v, depth = 0) =>
    Array.isArray(v) ? `[${v.length ? shape(v[0], depth + 1) : ""}]` : v && typeof v === "object" && depth < 2 ? `{${Object.keys(v).sort().map((k) => `${k}:${shape(v[k], depth + 1)}`).join(",")}}` : typeof v;
  for (const who of [["admin", ADMIN], ["read", READ], ["none", null]]) {
    for (const [method, path, body] of routes) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(who[1] ? { Authorization: `Bearer ${who[1]}` } : {}), "Content-Type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const text = await res.text();
      let detail;
      try {
        const j = JSON.parse(text);
        detail = (typeof j?.error === "string" ? `error=${j.error} ` : "") + shape(j);
      } catch {
        detail = `${res.headers.get("content-type")} ${text.length} bytes`;
      }
      lines.push(scrub(`${who[0]} ${method} ${path} -> ${res.status} ${detail}`));
    }
  }
  await new Promise((r) => server.close(r));
  store.close();
  writeFileSync(join(out, "routes.txt"), lines.join("\n") + "\n");
}

// ---- CLI ----
const cli = join(root, "dist", "src", "cli.js");
let n = 0;
function run(name, args, input) {
  const r = spawnSync(process.execPath, [cli, ...args], { env: scratchEnv(), cwd: home, input: input ?? "", encoding: "utf8", timeout: 120_000 });
  writeFileSync(join(out, `cli-${String(++n).padStart(2, "0")}-${name}.txt`), scrub(`$ monomem ${args.join(" ")}\nexit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`));
}
run("no-args-help", ["--help"]);
run("help", ["help"]);
run("help-all", ["help", "--all"]);
run("doctor-not-set-up", ["doctor"]);
run("add", ["add", "dump note one", "--title", "dump"]);
run("doctor", ["doctor"]);
run("doctor-json", ["doctor", "--json"]);
for (const c of ["trust", "token", "connect", "open", "init", "quarantine", "review", "confirm", "approve-first", "doctor"]) run(`${c}-help`, [c, "--help"]);
run("trust", ["trust"]);
run("trust-list", ["trust", "list"]);
run("token-list", ["token", "list"]);
run("quarantine-list", ["quarantine", "list"]);
run("review", ["review"]);
run("confirm-none", ["confirm"]);
run("approve-first", ["approve-first"]);
run("init-print", ["init", "--print"]);
run("connect-none", ["connect"]);
run("connect-bad", ["connect", "nosuchapp"]);
run("unknown", ["nosuchcommand"]);
rmSync(home, { recursive: true, force: true });
console.log(`surface dumped to ${out}`);
