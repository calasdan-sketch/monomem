// parent: rounds x N procs on fresh dirs, optional CPU hog and AV-like scanners.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const N = Number(process.env.N ?? 12), ROUNDS = Number(process.env.ROUNDS ?? 20), AV = process.env.AV === "1", HOG = Number(process.env.HOG ?? 0), MODE = process.env.MODE ?? "write";
const root = mkdtempSync(join(tmpdir(), "mm-cold-"));
process.env.MONOMEM_HOME = join(root, "home"); process.env.ONEMEMORY_HOME = join(root, "ohome"); process.env.MONOMEM_AUDIT_LOG = join(root, "audit.log");
const hogs = [];
for (let i = 0; i < HOG; i++) hogs.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
let avOn = true, dirNow = "";
// AV-like: constantly open the db files for a few ms and read, as a scanner would
const av = AV ? setInterval(() => { for (const f of ["state.db", "state.db-wal", "state.db-shm", "state.db-journal"]) { const p = join(dirNow, f); try { if (!existsSync(p)) continue; const fd = openSync(p, "r"); const b = Buffer.alloc(4096); readSync(fd, b, 0, 4096, 0); const e = Date.now() + 5; while (Date.now() < e); closeSync(fd); } catch {} } }, 1) : null;
const fails = {}; let total = 0, bad = 0;
for (let r = 0; r < ROUNDS; r++) {
  const dir = join(root, "d" + r); dirNow = dir; const db = join(dir, "state.db");
  const go = Date.now() + 1500;
  const outs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [new URL("./cold-child.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), db, String(go), String(i), MODE], { env: { ...process.env, MONOMEM_FLOOD_WRITES_PER_HOUR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += "")); c.on("close", () => res(o.trim().split("\n").pop()));
  })));
  for (const o of outs) { total++; let j; try { j = JSON.parse(o); } catch { j = { ok: false, err: "no output: " + o.slice(0, 100) }; } if (!j.ok) { bad++; const k = j.err + " @ " + (j.stack ?? ""); fails[k] = (fails[k] ?? 0) + 1; } }
}
clearInterval(av); hogs.forEach((h) => h.kill());
console.log(JSON.stringify({ N, ROUNDS, AV, HOG, MODE, total, bad, fails }, null, 1));
try { rmSync(root, { recursive: true, force: true }); } catch {}
