// First-open race: N processes open a Store on a FRESH EMPTY data folder at the same moment, many rounds.
// Usage: node scripts/concurrency-open.mjs [processes=8] [rounds=25] [distDir=dist]   (after `npm run build`)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[2] === "--child") {
  const [, , , dir, dist] = process.argv;
  process.env.MONOMEM_HOME = process.env.ONEMEMORY_HOME = dir;
  try {
    const { Store } = await import(pathToFileURL(join(resolve(dist), "src/store.js")).href);
    const s = new Store(join(dir, "state.db"));
    s.create({ title: "t " + process.pid, body: "b" });
    s.close();
    console.log("ok");
  } catch (e) { console.log("FAIL " + String(e?.message).split(String.fromCharCode(10))[0]); }
} else {
  const n = Number(process.argv[2] ?? 8), rounds = Number(process.argv[3] ?? 25), dist = process.argv[4] ?? "dist";
  let ok = 0, fail = 0; const why = new Map();
  for (let r = 0; r < rounds; r++) {
    const dir = mkdtempSync(join(process.env.MM_CONC_BASE || tmpdir(), "mm-open-"));
    const res = await Promise.all(Array.from({ length: n }, () => new Promise((done) => {
      let out = ""; const c = spawn(process.execPath, [process.argv[1], "--child", dir, dist], { stdio: ["ignore", "pipe", "ignore"] });
      c.stdout.on("data", (d) => (out += d)); c.on("close", () => done(out.trim()));
    })));
    for (const o of res) o === "ok" ? ok++ : (fail++, why.set(o, (why.get(o) ?? 0) + 1));
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`processes=${n} rounds=${rounds} started_ok=${ok} failed=${fail}`, [...why]);
}
