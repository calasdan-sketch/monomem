// N processes open the SAME v22 database at once with the v23 build (rounds times); all must open, none lose notes.
import { freshEnv, run, startWriter, check, url, R8, SNAP, sleep } from "./lib.mjs";
import { rmSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
const N = Number(process.argv[2] ?? 12), ROUNDS = Number(process.argv[3] ?? 6);
const D = process.env.DIST || R8;
const t = freshEnv();
const v22 = join(t.root, "v22.db");
await run(`await import("${url(SNAP, "src/quiet-sqlite.js")}");const {Store}=await import("${url(SNAP, "src/store.js")}");const s=new Store(process.argv[1],{bodyIndex:"off"});for(let i=0;i<1500;i++)s.create({title:"h"+i,body:"herd "+i+" "+"h".repeat(300)},{bulkImport:true});s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");`, [v22], { ...t.env, MONOMEM_DB_PATH: v22 });
const base = check(v22);
let bad = 0, lost = 0, bks = [];
for (let r = 0; r < ROUNDS; r++) {
  const dd = join(t.root, "r" + r); mkdirSync(dd); const db = join(dd, "state.db"); copyFileSync(v22, db);
  const env = { ...t.env, MONOMEM_HOME: dd, ONEMEMORY_HOME: dd, MONOMEM_DB_PATH: db };
  const go = Date.now() + 2500;
  const outs = await Promise.all(Array.from({ length: N }, () => run(`await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");while(Date.now()<Number(process.argv[2]));try{const s=new Store(process.argv[1],{bodyIndex:"off"});console.log("OPENED")}catch(e){console.log("ERR "+e.message)}`, [db, String(go)], env)));
  const fails = outs.filter((o) => !o.out.includes("OPENED"));
  if (fails.length) { bad += fails.length; console.log("round", r, fails.length, "failed:", fails[0].out.slice(0, 200), fails[0].err.slice(0, 200)); }
  const c = check(db); if (c.ids.size !== base.ids.size || c.integ !== "ok" || c.uv !== 23) { lost++; console.log("round", r, c.ids.size, c.integ, c.uv); }
  bks.push(readdirSync(dd).filter((f) => /pre-v23/.test(f)).length);
}
console.log(JSON.stringify({ N, ROUNDS, openFailures: bad, badStores: lost, preBackupsPerRound: bks }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
