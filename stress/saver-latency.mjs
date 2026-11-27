// How long does an interactive save (another process, one save per ~100 ms) wait while a bulk import runs?
import { freshEnv, url, R8, check, sleep } from "./lib.mjs";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
const N = Number(process.argv[2] ?? 8000);
const D = process.env.DIST || R8;
const t = freshEnv(); Object.assign(process.env, t.env);
await import(url(D, "src/quiet-sqlite.js"));
const { Store } = await import(url(D, "src/store.js"));
const s = new Store(t.db, { bodyIndex: "off" });
const script = `await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");import {writeSync} from "node:fs";const s=new Store(process.argv[1],{bodyIndex:"off"});writeSync(1,"READY"+String.fromCharCode(10));for(let i=0;;i++){const a=performance.now();try{const n=s.create({title:"sv"+i,body:"interactive save "+i,namespace:"saver"},{bulkImport:true});writeSync(1,"LAT "+Math.round(performance.now()-a)+" "+n.id+String.fromCharCode(10))}catch(e){writeSync(1,"FAIL "+e.message+String.fromCharCode(10))}const e=Date.now()+100;while(Date.now()<e);}`;
const c = spawn(process.execPath, ["--input-type=module", "-e", script, "--", t.db], { env: t.env, stdio: ["ignore", "pipe", "inherit"] });
let out = ""; c.stdout.on("data", (d) => (out += d));
while (!out.includes("READY")) await sleep(50);
const words = ["alpha", "bravo", "charlie", "delta"];
const notes = Array.from({ length: N }, (_, i) => ({ title: "n" + i, body: `import ${words[i % 4]} ${i} ` + "lorem ipsum dolor sit amet ".repeat(8) }));
const t0 = Date.now();
await s.importNotes(notes, { deferEdges: true, dedupe: false });
const secs = (Date.now() - t0) / 1000;
await sleep(300); c.kill("SIGKILL");
const lat = out.split("\n").filter((l) => l.startsWith("LAT")).map((l) => Number(l.split(" ")[1]));
const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
const q = (p) => lat.slice().sort((a, b) => a - b)[Math.floor(lat.length * p)];
console.log(JSON.stringify({ N, importSecs: +secs.toFixed(1), saves: lat.length, fails: fails.length, p50: q(0.5), p95: q(0.95), maxMs: Math.max(...lat), expectedSavesIfFree: Math.round(secs * 8) }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
