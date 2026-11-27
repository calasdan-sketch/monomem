// 100k notes via the restore path (importNotes, edges deferred) while a second process saves a note every ~100 ms.
// Reports: load time, lost writes (both writers), search time at 100k, integrity, and what ONE normal save costs a fresh process (time, rss).
import { freshEnv, url, R8, startWriter, check, run, sleep } from "./lib.mjs";
import { rmSync, statSync } from "node:fs";
const N = Number(process.argv[2] ?? 100000);
const D = process.env.DIST || R8;
const t = freshEnv(); Object.assign(process.env, t.env);
await import(url(D, "src/quiet-sqlite.js"));
const { Store } = await import(url(D, "src/store.js"));
const s = new Store(t.db, { bodyIndex: "off" });
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
const tok = (i) => "zq" + i.toString(36).padStart(6, "0");
const cw = startWriter(`await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");import {writeSync} from "node:fs";const s=new Store(process.argv[1],{busyTimeoutMs:8000,bodyIndex:"off"});let lat=[];for(let i=0;;i++){const a=performance.now();try{const n=s.create({title:"cw"+i,body:"concurrent saver "+i+" cwtok"+i,namespace:"saver"},{bulkImport:true});lat.push(performance.now()-a);writeSync(1,"ACK "+n.id+" "+Math.round(lat.at(-1))+"\\n")}catch(e){writeSync(2,e.message+"\\n")}const e=Date.now()+100;while(Date.now()<e);}`, [t.db], t.env);
const lats = []; let lp = ""; cw.c.stdout.on("data", (d) => { const l = (lp + d).split(String.fromCharCode(10)); lp = l.pop(); for (const x of l) { const m = /^ACK \d+ (\d+)/.exec(x); if (m) lats.push(Number(m[1])); } });
const vocab = Array.from({ length: 6000 }, (_, i) => "w" + (i * 2654435761 % 1000003).toString(36));
const pick = (i, k) => vocab[(i * 31 + k * 7919 + (i >> 3) * k) % 6000];
const t0 = Date.now(); const mem = [];
const BATCH = 5000;
for (let b = 0; b < N; b += BATCH) {
  const notes = [];
  for (let i = b; i < Math.min(N, b + BATCH); i++) notes.push({ title: "n" + i, body: `soak ${words[i % 12]} ${words[(i * 7) % 12]} ${words[(i * 5) % 12]} note ${tok(i)} ` + Array.from({ length: 24 }, (_, k) => pick(i, k + 1)).join(" ") });
  await s.importNotes(notes, { deferEdges: true, dedupe: false });
  if ((b + BATCH) % 20000 === 0) { const m = process.memoryUsage(); mem.push({ n: b + BATCH, secs: Math.round((Date.now() - t0) / 1000), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), cwSaves: cw.acked.size, saverP50: lats.length ? lats.slice().sort((a, b) => a - b)[lats.length >> 1] : null, saverMax: lats.length ? Math.max(...lats) : null }); console.log(JSON.stringify(mem.at(-1))); }
}
cw.c.kill("SIGKILL"); await cw.done;
const loadSecs = Math.round((Date.now() - t0) / 1000);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)];
const times = []; let miss = 0;
for (let k = 0; k < 50; k++) { const i = Math.floor(Math.random() * N); const a = performance.now(); const r = s.search(tok(i), { limit: 5 }); times.push(performance.now() - a); const arr = Array.isArray(r) ? r : (r.results ?? r.notes ?? []); if (!arr.some((x) => (x.title ?? x.note?.title) === "n" + i)) miss++; }
const g = []; for (const w of ["alpha bravo", "delta echo foxtrot", "lima kilo india"]) { const a = performance.now(); s.search(w, { limit: 10 }); g.push(performance.now() - a); }
s.close?.();
const c = check(t.db);
const cwLost = [...cw.acked].filter((x) => !c.ids.has(x)).length;
const lastErr = cw.err() ? "stderr:" + cw.err().slice(0, 200) : "";
const notesN = [...c.ids].length;
console.log(JSON.stringify({ phase: "loaded", N, notesInDb: notesN, expected: N + cw.acked.size, cwSaves: cw.acked.size, saverP50: lats.slice().sort((a, b) => a - b)[lats.length >> 1], saverP95: lats.slice().sort((a, b) => a - b)[Math.floor(lats.length * 0.95)], saverMax: Math.max(...lats), cwLost, loadSecs, tokP50: +pct(times, 0.5).toFixed(1), tokP95: +pct(times, 0.95).toFixed(1), tokMiss: miss, genericP50: +pct(g, 0.5).toFixed(1), integrity: c.integ, dbMB: Math.round(statSync(t.db).size / 1e6), lastErr }));
// a fresh process (what every agent's MCP server is) does ONE normal save into the big namespace
const one = await run(`await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");const a=performance.now();const s=new Store(process.argv[1],{bodyIndex:"off"});const o=performance.now()-a;const b=performance.now();s.create({title:"one",body:"one normal save soak alpha bravo into the big namespace"});const sv=performance.now()-b;const m=process.memoryUsage();console.log(JSON.stringify({openMs:Math.round(o),firstSaveMs:Math.round(sv),rssMB:Math.round(m.rss/1e6),heapMB:Math.round(m.heapUsed/1e6)}))`, [t.db], t.env);
console.log("fresh process, first save:", one.out.trim(), one.err.slice(0, 200));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
