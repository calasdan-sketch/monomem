#!/usr/bin/env node
// Smoke-test a built standalone folder (scripts/build-bundle.mjs) in a scratch home: nothing outside a temp folder is read
// or written. Checks: --version (the release version, never 0.0.0), doctor (database and hook checks pass), an MCP
// initialize over stdio, the session-start hook, `start` answering /health on both ports, `service install --print`
// naming the bundled runtime (prints only, registers nothing), and `setup --dry-run` naming only the bundled runtime
// (no bare `node`, the install home's paths).
//   node scripts/smoke-bundle.mjs <folder>/Monomem <expected version>
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [folderArg, want] = process.argv.slice(2);
if (!folderArg || !want) {
  console.error("usage: node scripts/smoke-bundle.mjs <Monomem folder> <version>");
  process.exit(2);
}
const app = resolve(folderArg);
const win = process.platform === "win32";
const node = join(app, "runtime", win ? "node.exe" : "node");
const cli = join(app, "dist", "src", "cli.js");
const home = mkdtempSync(join(tmpdir(), "mm-smoke-"));
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP,
  HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), MONOMEM_HOME: join(home, ".monomem"), ONEMEMORY_HOME: join(home, ".onememory"),
};
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n${detail}`}`);
  if (!ok) failed++;
};
const run = (args, input, extra = {}) => {
  const t = performance.now();
  const r = spawnSync(node, [cli, ...args], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 60_000 });
  return { ...r, ms: Math.round(performance.now() - t), all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

try {
  const v = run(["--version"]);
  check(`--version prints ${want} (${v.ms} ms)`, v.status === 0 && v.stdout.trim() === want, v.all);
  writeFileSync(join(home, ".claude.json"), "{}\n");
  const add = run(["add", "smoke note: staging port 8443"]);
  check("add", add.status === 0, add.all);
  const d = run(["doctor"]);
  check("doctor: database and hook checks pass", d.status === 0 && /\[ok\]\s+database OK/.test(d.all) && /\[ok\]\s+recall hook smoke test passed/.test(d.all), d.all);
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n";
  const m = run(["mcp"], init);
  const reply = (m.stdout || "").split("\n").find((l) => l.includes('"id":1'));
  check(`MCP initialize over stdio (serverInfo.version ${want})`, !!reply && JSON.parse(reply).result?.serverInfo?.version === want, m.all);
  const hook = run(["recall", "--budget-ms", "800"], JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "smoke", cwd: home }));
  check(`session-start hook (${hook.ms} ms)`, hook.status === 0 && /8443|smoke note/.test(hook.stdout), hook.all);
  // `start` is what broke in the 1.5.0 SEA trial: both servers must come up from the folder and answer /health.
  const free = () => new Promise((res) => { const srv = createServer().listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); }); });
  const [api, mcp] = [await free(), await free()];
  const server = spawn(node, [cli, "start"], { env: { ...env, MONOMEM_PORT: String(api), MONOMEM_MCP_PORT: String(mcp) }, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  server.stderr.on("data", (b) => (serverErr += b));
  const health = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; } };
  let codes = [0, 0];
  for (let i = 0; i < 60 && !(codes[0] === 200 && codes[1] === 200); i++) {
    await new Promise((r) => setTimeout(r, 250));
    codes = [await health(api), await health(mcp)];
  }
  const gone = new Promise((r) => (server.exitCode !== null ? r() : server.once("exit", r)));
  server.kill();
  await gone; // the scratch home is removed below: the server must have let go of its database
  check(`start: /health answers on the API and MCP ports (${codes.join(", ")})`, codes[0] === 200 && codes[1] === 200, serverErr);
  const sv = run(["service", "install", "--print"]);
  check("service install --print names the bundled runtime and cli.js (prints only)", sv.status === 0 && sv.all.includes(node) && sv.all.includes(cli), sv.all);
  const s = run(["setup", "--dry-run", "--yes", "--only", "claude-code"]);
  const homeDir = win ? join(env.LOCALAPPDATA, "Programs", "Monomem") : process.platform === "darwin" ? join(home, "Applications", "Monomem") : join(env.XDG_DATA_HOME, "monomem");
  check("setup --dry-run names the bundled runtime in its home, never a bare node", s.status === 0 && !/"node "|\bnode "/.test(s.stdout) && s.stdout.includes(JSON.stringify(join(homeDir, "runtime")).slice(1, -1)), s.all);
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(failed ? 1 : 0);
