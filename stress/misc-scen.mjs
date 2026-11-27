// misc scenarios: wal-trunc | readonly | versions | clock | full
import { freshEnv, run, check, url, R8, SNAP, sleep, startWriter } from "./lib.mjs";
import { rmSync, statSync, truncateSync, existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
const scen = process.argv[2];
const D = process.env.DIST || R8;
const Q = (d = D) => `await import("${url(d, "src/quiet-sqlite.js")}");const {Store}=await import("${url(d, "src/store.js")}");`;
const t = freshEnv();
const seed = (db, env, n, d = D) => run(`${Q(d)}const s=new Store(process.argv[1],{bodyIndex:"off"});const ids=[];for(let i=0;i<${n};i++)ids.push(s.create({title:"s"+i,body:"seed "+i+" "+"q".repeat(200)},{bulkImport:true}).id);console.log(JSON.stringify(ids));`, [db], env);
const openTry = (db, env, d = D, extra = "") => run(`${Q(d)}try{const s=new Store(process.argv[1],{bodyIndex:"off"});${extra}console.log("OPENED")}catch(e){console.log("ERR "+e.message)}`, [db], env);

if (scen === "wal-trunc") {
  // writer killed with -wal left behind; then truncate the WAL at various points; reopen
  const results = [];
  for (const mode of ["half", "zero", "header-only", "garbage-tail", "delete-wal", "delete-shm"]) {
    const x = freshEnv();
    const w = startWriter(`${Q()}import {writeSync} from "node:fs";const s=new Store(process.argv[1],{bodyIndex:"off"});s.db.exec("PRAGMA wal_autocheckpoint=0");for(let i=0;;i++){const n=s.create({title:"w"+i,body:"wal "+i+" "+"x".repeat(300)},{bulkImport:true});writeSync(1,"ACK "+n.id+"\\n")}`, [x.db], x.env);
    while (w.acked.size < 300) await sleep(50);
    w.c.kill("SIGKILL"); await w.done;
    const wal = x.db + "-wal", shm = x.db + "-shm"; const sz = existsSync(wal) ? statSync(wal).size : 0;
    if (mode === "half") truncateSync(wal, Math.floor(sz / 2));
    if (mode === "zero") truncateSync(wal, 0);
    if (mode === "header-only") truncateSync(wal, 32);
    if (mode === "garbage-tail") { const fd = (await import("node:fs")).openSync(wal, "r+"); (await import("node:fs")).writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, Math.max(0, sz - 8192)); (await import("node:fs")).closeSync(fd); }
    if (mode === "delete-wal") rmSync(wal, { force: true });
    if (mode === "delete-shm") rmSync(shm, { force: true });
    const r = await openTry(x.db, x.env);
    const c = check(x.db);
    const lost = [...w.acked].filter((i) => !c.ids.has(i)).length;
    results.push({ mode, walBytes: sz, acked: w.acked.size, kept: c.ids.size, lostAcked: lost, integrity: c.integ, open: r.out.trim().slice(0, 150) });
    rmSync(x.root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(results, null, 1));
}

if (scen === "readonly") {
  const out = [];
  await seed(t.db, t.env, 20);
  // 1: folder deny-write via icacls (read-only dir semantic on Windows)
  const user = process.env.USERNAME;
  execSync(`icacls "${t.home}" /deny "${user}:(WD,AD)" /Q`, { stdio: "ignore" });
  const r1 = await openTry(t.db, t.env); out.push({ case: "dir deny create files (db exists)", out: r1.out.trim().slice(0, 400) });
  execSync(`icacls "${t.home}" /remove:d "${user}" /Q`, { stdio: "ignore" });
  // 2: db file attrib +R
  execSync(`attrib +R "${t.db}"`);
  const r2 = await openTry(t.db, t.env); out.push({ case: "state.db attrib +R", out: r2.out.trim().slice(0, 400) });
  execSync(`attrib -R "${t.db}"`);
  // 3: after restoring, data intact?
  const r3 = await openTry(t.db, t.env, D, `console.log(s.list?s.list({limit:500}).length:"nolist")`); out.push({ case: "after restore perms", out: r3.out.trim().slice(0, 200) });
  const c = check(t.db); out.push({ case: "integrity", integ: c.integ, notes: c.ids.size });
  // 4: new store in a read-only parent
  console.log(JSON.stringify(out, null, 1));
}

if (scen === "versions") {
  const out = [];
  // a) v23 db, opened by v22 snapshot
  const ids = JSON.parse((await seed(t.db, t.env, 50)).out.trim());
  const before = check(t.db);
  const r = await openTry(t.db, t.env, SNAP);
  const after = check(t.db);
  out.push({ case: "v22 build opens v23 db", uv: before.uv, msg: r.out.trim().slice(0, 700), notesBefore: before.ids.size, notesAfter: after.ids.size, integ: after.integ, uvAfter: after.uv });
  // a2) v22 build opening through the MCP server entry (what an app sees)
  const r2 = await run(`await import("${url(SNAP, "src/mcp-stdio.js")}")`, [], t.env, { kill: 6000 });
  out.push({ case: "v22 mcp-stdio on v23 db", code: r2.code, err: r2.err.trim().slice(0, 500) });
  // b) v22 holds open while v23 migrates, then v22 writes
  const y = freshEnv();
  await seed(y.db, y.env, 30, SNAP);
  const script = `${Q(SNAP)}
const s = new Store(process.argv[1], { bodyIndex: "off" });
console.log("OPEN22");
import { existsSync } from "node:fs"; while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 100));
let res = "";
try { s.create({ title: "late22", body: "written by old build after upgrade" }, { bulkImport: true }); res = "WROTE"; } catch (e) { res = "REFUSED " + e.name + ": " + e.message; }
console.log(res);
try { console.log("READ " + s.list({ limit: 500 }).length); } catch (e) { console.log("READERR " + e.message); }`;
  const { spawn } = await import("node:child_process");
  const c = spawn(process.execPath, ["--input-type=module", "-e", script, "--", y.db, join(y.root, "go")], { env: y.env, stdio: ["ignore", "pipe", "pipe"] });
  let o = "", er = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (er += d));
  while (!o.includes("OPEN22")) await sleep(50);
  const up = await openTry(y.db, y.env);   // v23 migrates under the open v22 process
  out.push({ case: "v23 migrates while v22 open", out: up.out.trim().slice(0, 200) });
  writeFileSync(join(y.root, "go"), "1"); await new Promise((r) => { c.on("close", r); setTimeout(() => { c.kill("SIGKILL"); r(); }, 120000); });
  const cc = check(y.db);
  out.push({ case: "v22 write after upgrade", out: o.trim().replace(/\n/g, " | ").slice(0, 600), err: er.slice(0, 300), notes: cc.ids.size, integ: cc.integ, uv: cc.uv });
  console.log(JSON.stringify(out, null, 1));
  rmSync(y.root, { recursive: true, force: true });
}

if (scen === "clock") {
  const script = `${Q()}
const RealDate = Date; let off = 0;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); } static now() { return RealDate.now() + off; } }
globalThis.Date = FakeDate;
const s = new Store(process.argv[1], { bodyIndex: "off" });
const YEAR = 365 * 86400000; const rep = {};
const mk = (tag, n, extra = {}) => { const ids = []; for (let i = 0; i < n; i++) ids.push(s.create({ title: tag + i, body: tag + " note " + i + " unique" + tag + i, ...extra }, { bulkImport: true }).id); return ids; };
const a = mk("alpha", 20); const ttl = mk("ttlnote", 5, { forget_after: 30 });
const cnt = () => s.list({ limit: 1000 }).length;
rep.start = cnt();
off = 10 * YEAR; // forward jump
const b = mk("beta", 20); rep.afterFwdWrites = cnt();
const archived = s.sweepExpired(); rep.fwdSweepArchived = archived; rep.afterFwdSweep = cnt();
s.purgeChangeLog();
off = -3 * YEAR; // back before the first writes
const c = mk("gamma", 20); rep.afterBackWrites = cnt();
try { rep.search = s.search ? s.search("gamma").length : "n/a"; } catch (e) { rep.searchErr = e.message; }
try { rep.searchAlpha = s.search("alpha").length; } catch (e) { rep.searchAlphaErr = e.message; }
rep.sweepBack = s.sweepExpired(); rep.afterBackSweep = cnt();
off = 0; rep.sweepNormal = s.sweepExpired(); rep.final = cnt();
const raw = s.db.prepare("SELECT COUNT(*) n, SUM(archived_at IS NOT NULL) arch FROM notes").get(); rep.rows = Number(raw.n); rep.archivedRows = Number(raw.arch);
console.log(JSON.stringify(rep));`;
  const r = await run(script, [t.db], t.env);
  console.log(r.out.trim(), r.err.slice(0, 500));
}

if (scen === "full") {
  // simulate a full disk with PRAGMA max_page_count (db file cannot grow); no admin for a real small volume
  const script = `${Q()}
import { writeSync } from "node:fs";
const s = new Store(process.argv[1], { bodyIndex: "off" });
const acked = [];
for (let i = 0; i < 50; i++) acked.push(s.create({ title: "pre" + i, body: "pre " + i + " " + "p".repeat(300) }, { bulkImport: true }).id);
const pc = Number(s.db.prepare("PRAGMA page_count").get().page_count);
s.db.exec("PRAGMA max_page_count = " + (pc + 20));
let fails = 0, firstErr = "", okAfterFull = 0;
for (let i = 0; i < 400; i++) { try { acked.push(s.create({ title: "fill" + i, body: "fill " + i + " " + "f".repeat(2000) }, { bulkImport: true }).id); } catch (e) { fails++; if (!firstErr) firstErr = e.name + ": " + e.message; } }
s.db.exec("PRAGMA max_page_count = 1073741823");
const post = s.create({ title: "after", body: "after the disk freed up" }, { bulkImport: true }).id; acked.push(post);
console.log(JSON.stringify({ acked: acked.length, fails, firstErr, ids: acked }));`;
  const r = await run(script, [t.db], t.env);
  let j; try { j = JSON.parse(r.out.trim().split("\n").pop()); } catch { console.log("RAW", r.out.slice(0, 500), r.err.slice(0, 500)); }
  if (j) { const c = check(t.db); const lost = j.ids.filter((i) => !c.ids.has(i)).length; console.log(JSON.stringify({ acked: j.acked, writeFailures: j.fails, firstErr: j.firstErr, lostAcked: lost, integ: c.integ })); }
}
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
