// kill -9 scenarios (r8 dist, or DIST env): write | checkpoint | backup | migrate
import { freshEnv, run, startWriter, check, sleep, R8, SNAP, url } from "./lib.mjs";
import { rmSync, existsSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const scen = process.argv[2], ROUNDS = Number(process.argv[3] ?? 10);
const D = process.env.DIST || R8;
const Q = `await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");`;
const W = () => `${Q}
import { writeSync } from "node:fs";
const [db, label] = process.argv.slice(1);
const s = new Store(db, { busyTimeoutMs: 8000, bodyIndex: "off" });
for (let i = 0; ; i++) {
  try { const n = s.create({ title: "k-"+label+"-"+i, body: "kill test " + label + " " + i + " " + "x".repeat(300) }, { bulkImport: true }); writeSync(1, "ACK " + n.id + "\\n");
  ${scen === "checkpoint" ? 'if (i % 3 === 0) s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); else if (i % 3 === 1) s.db.exec("PRAGMA wal_checkpoint(PASSIVE)");' : ""} }
  catch (e) { if (/locked|busy/i.test(e.message)) continue; process.stderr.write(e.message); process.exit(1); }
}`;
const t = freshEnv(); const all = new Set();
let out = {};
if (scen === "write" || scen === "checkpoint") {
  let lostAll = 0, bad = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const ws = Array.from({ length: 4 }, (_, k) => startWriter(W(), [t.db, `r${r}w${k}`], t.env));
    const t0 = Date.now(); while (!ws.some((w) => w.acked.size) && Date.now() - t0 < 30000) await sleep(50);
    await sleep(40 + Math.random() * 600);
    ws.forEach((w) => w.c.kill("SIGKILL")); await Promise.all(ws.map((w) => w.done));
    ws.forEach((w) => w.acked.forEach((i) => all.add(i)));
    const c = check(t.db); if (c.integ !== "ok") bad++;
    const lost = [...all].filter((i) => !c.ids.has(i)); lostAll += lost.length;
    if (lost.length || c.integ !== "ok") console.log("round", r, "lost", lost.length, c.integ);
  }
  out = { acked: all.size, lost: lostAll, integrityBad: bad };
}
if (scen === "backup") {
  await run(`${Q}const s=new Store(process.argv[1],{bodyIndex:"off"});for(let i=0;i<6000;i++)s.create({title:"b"+i,body:"seed "+i+" "+"y".repeat(500)},{bulkImport:true});`, [t.db], t.env);
  const base = check(t.db); console.log("seeded", base.ids.size);
  let partialAsBackup = 0, srcBad = 0, okBackups = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const o = join(t.root, "bk" + r);
    const bs = `${Q}const {backupStore}=await import("${url(D, "src/backup.js")}");console.log("GO");const s=new Store(process.argv[1],{bodyIndex:"off"});console.log("OPEN");backupStore(s, process.argv[1], process.argv[2]);console.log("DONE");`;
    const res = await run(bs, [t.db, o], t.env, { killAfter: { marker: "OPEN", ms: Math.random() * 500 } });
    const c = check(t.db); if (c.integ !== "ok" || c.ids.size !== base.ids.size) srcBad++;
    const fin = join(o, "state.db");
    if (existsSync(fin)) { const b = check(fin); if (b.integ !== "ok" || b.ids.size !== base.ids.size) partialAsBackup++; else okBackups++; }
    console.log("round", r, res.out.includes("DONE") ? "completed" : "killed", existsSync(o) ? readdirSync(o).join(",") : "no-dir");
  }
  out = { srcBad, partialAsBackup, okBackups };
}
if (scen === "migrate") {
  const N = Number(process.env.NOTES ?? 6000);
  const v22 = join(t.root, "v22.db");
  await run(`await import("${url(SNAP, "src/quiet-sqlite.js")}");const {Store}=await import("${url(SNAP, "src/store.js")}");const s=new Store(process.argv[1],{bodyIndex:"off"});for(let i=0;i<${N};i++)s.create({title:"m"+i,body:"seed "+i+" "+"z".repeat(400)},{bulkImport:true});s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");`, [v22], { ...t.env, MONOMEM_DB_PATH: v22 }, { timeout: 900000 });
  const base = check(v22); console.log("v22 seeded", base.ids.size, "uv", base.uv);
  const mk = (n) => { const dd = join(t.root, n); mkdirSync(dd); const db = join(dd, "state.db"); copyFileSync(v22, db); return { dd, db, env: { ...t.env, MONOMEM_HOME: dd, ONEMEMORY_HOME: dd, MONOMEM_DB_PATH: db } }; };
  const open = (db, env, o) => run(`${Q}console.log("GO");new Store(process.argv[1],{bodyIndex:"off"});console.log("OPENED")`, [db], env, o);
  const tm = mk("time"); const t0 = Date.now(); const full = await open(tm.db, tm.env); const dur = Date.now() - t0;
  console.log("full migrate+open ms", dur, full.out.trim(), full.err.slice(0, 200));
  let bad = 0, lost = 0, notV23 = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const m = mk("m" + r);
    await open(m.db, m.env, { killAfter: { marker: "GO", ms: Math.random() * Math.max(dur - 500, 200) } });
    const re = await open(m.db, m.env);
    const c = check(m.db);
    if (!re.out.includes("OPENED")) { bad++; console.log("round", r, "REOPEN FAIL", re.err.slice(0, 300)); }
    if (c.integ !== "ok") { bad++; console.log("round", r, c.integ); }
    if (c.ids.size !== base.ids.size) { lost++; console.log("round", r, "notes", c.ids.size, "vs", base.ids.size); }
    if (c.uv !== 23) notV23++;
  }
  out = { N, dur, bad, lost, notV23 };
}
console.log(JSON.stringify({ scen, ROUNDS, ...out }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
