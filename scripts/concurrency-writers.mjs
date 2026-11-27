// Multi-process write contention check: N processes, each opening its own Store (server busy timeout) and creating K notes.
// Usage: node scripts/concurrency-writers.mjs [writers=25] [notes=6]   (run after `npm run build`; uses a fresh temp MONOMEM_HOME)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === "--child") {
  const [, , , dir, idx, k] = process.argv;
  process.env.MONOMEM_HOME = process.env.ONEMEMORY_HOME = dir;
  const { Store } = await import(pathToFileURL(join(here, "../dist/src/store.js")).href);
  const { SERVER_BUSY_TIMEOUT_MS } = await import(pathToFileURL(join(here, "../dist/src/db-problem.js")).href);
  let ok = 0, busy = 0, other = 0;
  try {
    const s = new Store(join(dir, "state.db"), { busyTimeoutMs: SERVER_BUSY_TIMEOUT_MS });
    for (let i = 0; i < Number(k); i++) {
      try { s.create({ title: `w${idx} n${i}`, body: `body ${idx}/${i} ${"x".repeat(2000)}` }); ok++; }
      catch (e) { if (process.env.MM_CONC_DEBUG) console.error(e?.stack?.split(String.fromCharCode(10)).slice(0,5).join(" | ")); /busy|locked/i.test(String(e?.message)) ? busy++ : other++; }
    }
  } catch (e) { other += Number(k); console.error(String(e?.message)); }
  console.log(JSON.stringify({ ok, busy, other }));
} else {
  const writers = Number(process.argv[2] ?? 25), notes = Number(process.argv[3] ?? 6);
  const dir = mkdtempSync(join(process.env.MM_CONC_BASE || tmpdir(), "mm-conc-"));
  const t0 = Date.now();
  const runs = Array.from({ length: writers }, (_, i) => new Promise((res) => {
    let out = ""; const c = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", dir, String(i), String(notes)], { stdio: ["ignore", "pipe", "inherit"] });
    c.stdout.on("data", (d) => (out += d)); c.on("close", () => { try { res(JSON.parse(out.trim().split("\n").pop())); } catch { res({ ok: 0, busy: 0, other: notes }); } });
  }));
  const r = await Promise.all(runs);
  const sum = (k) => r.reduce((a, x) => a + x[k], 0);
  console.log(`writers=${writers} attempted=${writers * notes} ok=${sum("ok")} busy_refused=${sum("busy")} other_errors=${sum("other")} seconds=${((Date.now() - t0) / 1000).toFixed(1)}`);
  rmSync(dir, { recursive: true, force: true });
}
