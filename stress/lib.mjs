import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
export const R8 = fileURLToPath(new URL("../dist", import.meta.url));
export const SNAP = "C:\\Users\\danie\\lab3\\snapshot\\dist";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function freshEnv(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "mm-scen-"));
  const home = join(root, "home"); mkdirSync(home);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(MONOMEM_|ONEMEMORY_|CLAUDE_BRIDGE_)/.test(k)) env[k] = v;
  Object.assign(env, { MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_AUDIT_LOG: join(root, "audit.log"), MONOMEM_DB_PATH: join(home, "state.db"), MONOMEM_FLOOD_WRITES_PER_HOUR: "0", ...extra });
  return { root, home, db: join(home, "state.db"), env };
}
export const url = (dist, f) => pathToFileURL(join(dist, f)).href;
export function run(script, args, env, { timeout = 300000, kill, killAfter } = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; if (killAfter && !killAfter.done && out.includes(killAfter.marker)) { killAfter.done = true; setTimeout(() => c.kill("SIGKILL"), killAfter.ms); } }); c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill("SIGKILL"), timeout);
    if (kill) setTimeout(() => c.kill("SIGKILL"), kill);
    c.on("close", (code, sig) => { clearTimeout(t); res({ code, sig, out, err }); });
  });
}
export function startWriter(script, args, env) {
  const c = spawn(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const acked = new Set(); let pend = "", err = "";
  c.stdout.on("data", (d) => { const l = (pend + d).split("\n"); pend = l.pop(); for (const x of l) { const m = /^ACK (\d+)/.exec(x); if (m) acked.add(Number(m[1])); } });
  c.stderr.on("data", (d) => (err += d));
  const done = new Promise((r) => c.on("close", () => r()));
  return { c, acked, done, err: () => err };
}
export function check(db) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const h = new DatabaseSync(db); h.exec("PRAGMA busy_timeout=8000");
      const integ = h.prepare("PRAGMA integrity_check").get().integrity_check;
      const ids = new Set(h.prepare("SELECT id FROM notes").all().map((r) => Number(r.id)));
      const uv = h.prepare("PRAGMA user_version").get().user_version;
      h.close(); return { integ, ids, uv };
    } catch (e) { last = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); }
  }
  return { integ: "OPEN-FAIL: " + last.message, ids: new Set(), uv: -1 };
}
