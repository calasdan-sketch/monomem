import { freshEnv, url, R8, startWriter, check, sleep } from "./lib.mjs";
import { rmSync, statSync } from "node:fs";
const N = Number(process.argv[2] ?? 100000), STEP = Number(process.argv[3] ?? 10000);
const D = process.env.DIST || R8;
const t = freshEnv();
Object.assign(process.env, t.env);
await import(url(D, "src/quiet-sqlite.js"));
const { Store } = await import(url(D, "src/store.js"));
const s = new Store(t.db, { bodyIndex: "off" });
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)];
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
const tok = (i) => "zq" + i.toString(36).padStart(6, "0");
// a concurrent writer process hits the same file during the run
const FAST = process.env.FAST === "1"; const CW = process.env.CW !== "0";
const cw = !CW ? { c: { kill() {}, exitCode: null }, acked: new Set(), done: Promise.resolve(), err: () => "" } : startWriter(`await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");import {writeSync} from "node:fs";const s=new Store(process.argv[1],{busyTimeoutMs:8000,bodyIndex:"off"});for(let i=0;;i++){try{const n=s.create({title:"cw"+i,body:"concurrent writer note "+i+" cwtok"+i},{bulkImport:true});writeSync(1,"ACK "+n.id+"\\n");const e=Date.now()+40;while(Date.now()<e);}catch(e){if(/locked|busy/i.test(e.message))continue;process.exit(1)}}`, [t.db], t.env);
const rows = []; const ids = [];
const t0 = Date.now(); let busyErrs = 0;
function probe(n) {
  const times = []; let miss = 0;
  for (let k = 0; k < 25; k++) {
    const i = Math.floor(Math.random() * ids.length);
    const q = tok(i); const a = performance.now();
    let r; try { r = s.search(q, { limit: 5 }); } catch (e) { r = []; }
    times.push(performance.now() - a);
    const arr = Array.isArray(r) ? r : (r.results ?? r.notes ?? []);
    if (!arr.some((x) => (x.title ?? x.note?.title) === "n" + i)) miss++;
  }
  const g = []; for (const w of ["alpha bravo", "delta echo foxtrot", "lima kilo"]) { const a = performance.now(); try { s.search(w, { limit: 10 }); } catch {} g.push(performance.now() - a); }
  const m = process.memoryUsage();
  rows.push({ n, secs: Math.round((Date.now() - t0) / 1000), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), tokP50: +pct(times, 0.5).toFixed(1), tokP95: +pct(times, 0.95).toFixed(1), genericP50: +pct(g, 0.5).toFixed(1), tokMiss: miss, dbMB: Math.round(statSync(t.db).size / 1e6) });
  console.log(JSON.stringify({ ...rows.at(-1), cwAlive: cw.c.exitCode === null, cwActed: cw.acked.size, cwErr: cw.err().slice(-300) }));
}
for (let i = 0; i < N; i++) {
  for (;;) {
    try {
      const n = s.create({ title: "n" + i, body: `soak ${words[i % 12]} ${words[(i * 7) % 12]} ${words[(i * 5) % 12]} note ${tok(i)} ` + "lorem ipsum dolor sit amet ".repeat(8) }, { bulkImport: true, skipEdges: FAST });
      ids.push(n.id); break;
    } catch (e) { if (/locked|busy/i.test(e.message)) { busyErrs++; continue; } throw e; }
  }
  if ((i + 1) % STEP === 0) probe(i + 1);
}
cw.c.kill("SIGKILL"); await cw.done;
s.close?.();
const c = check(t.db);
const have = new Set(c.ids);
const lostMain = ids.filter((x) => !have.has(x)).length;
const lostCw = [...cw.acked].filter((x) => !have.has(x)).length;
console.log(JSON.stringify({ N, notesInDb: c.ids.size, lostMain, concurrentAcked: cw.acked.size, lostConcurrent: lostCw, busyErrs, integrity: c.integ, minutes: +((Date.now() - t0) / 60000).toFixed(1) }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
