// kill -9 during markdown sync: (1) export, (2) import. After each kill: no torn .md file, a re-run converges, no duplicates.
import { freshEnv, run, check, url, R8, sleep } from "./lib.mjs";
import { rmSync, readdirSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ROUNDS = Number(process.argv[2] ?? 6), N = Number(process.argv[3] ?? 1500);
const D = process.env.DIST || R8;
const Q = `await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");const S=await import("${url(D, "src/sync.js")}");`;
const t = freshEnv();
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
await run(`${Q}const s=new Store(process.argv[1],{bodyIndex:"off"});for(let i=0;i<${N};i++)s.create({title:"sync note "+i,body:"sync body "+i+" "+"w".repeat(200)},{bulkImport:true});`, [t.db], t.env);
const base = check(t.db);
const dir = join(t.root, "vault");
const expScript = `${Q}console.log("GO");const s=new Store(process.argv[1],{bodyIndex:"off"});S.exportMarkdown(s,process.argv[2]);console.log("DONE")`;
const clean = await run(expScript, [t.db, join(t.root, "clean")], t.env);
const cleanFiles = walk(join(t.root, "clean")).filter((f) => f.endsWith(".md")).length;
let torn = 0, notConverged = 0;
for (let r = 0; r < ROUNDS; r++) {
  const d = join(dir, "r" + r);
  await run(expScript, [t.db, d], t.env, { killAfter: { marker: "GO", ms: 300 + Math.random() * 1500 } });
  let files = []; try { files = walk(d); } catch {}
  const md = files.filter((f) => f.endsWith(".md"));
  for (const f of md) { const txt = readFileSync(f, "utf8"); if (!txt.startsWith("---") || !/\n---\n/.test(txt) || !/\nid: \d+/.test(txt)) torn++; }
  const again = await run(expScript, [t.db, d], t.env);
  const after = walk(d).filter((f) => f.endsWith(".md")).length;
  if (!again.out.includes("DONE") || after !== cleanFiles) notConverged++;
  console.log("export round", r, "files after kill", md.length, "tmp left", files.filter((f) => f.endsWith(".tmp")).length, "after rerun", after, "of", cleanFiles);
}
// import side: another store imports the clean vault; kill midway; rerun; expect exactly N notes (no duplicates)
let dup = 0, impBad = 0;
const impScript = `${Q}console.log("GO");const s=new Store(process.argv[1],{bodyIndex:"off"});const r=await S.importMarkdown(s,process.argv[2]);console.log("DONE "+s.list({limit:1}).total)`;
for (let r = 0; r < ROUNDS; r++) {
  const home = join(t.root, "imp" + r); mkdirSync(home); const db = join(home, "state.db");
  const env = { ...t.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_DB_PATH: db };
  await run(impScript, [db, join(t.root, "clean")], env, { killAfter: { marker: "GO", ms: 500 + Math.random() * 3000 } });
  const mid = check(db);
  const again = await run(impScript, [db, join(t.root, "clean")], env);
  const fin = check(db);
  if (fin.integ !== "ok" || fin.ids.size !== N) { impBad++; console.log("import round", r, "notes", fin.ids.size, "expected", N, fin.integ, again.err.slice(0, 200)); }
  if (fin.ids.size > N) {
    dup++;
    const { DatabaseSync } = await import("node:sqlite"); const h = new DatabaseSync(db, { readOnly: true });
    const d = h.prepare("SELECT title, COUNT(*) c, GROUP_CONCAT(id) ids, GROUP_CONCAT(created_at) cr FROM notes GROUP BY title HAVING c > 1").all();
    console.log("DUP", JSON.stringify(d), "sync_map rows", JSON.stringify(h.prepare("SELECT COUNT(*) c FROM sync_map").get()));
    for (const x of d) console.log(JSON.stringify(h.prepare("SELECT id, namespace, rev, archived_at, written_by FROM notes WHERE title = ?").all(x.title)), JSON.stringify(h.prepare("SELECT * FROM sync_map WHERE local_id IN (" + x.ids + ")").all()));
    h.close();
  }
  console.log("import round", r, "after kill", mid.ids.size, "after rerun", fin.ids.size, "of", N);
}
console.log(JSON.stringify({ scen: "sync-kill", ROUNDS, N, tornFiles: torn, exportNotConverged: notConverged, importBad: impBad, duplicates: dup }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
