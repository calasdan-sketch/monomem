// P processes each write K notes through the real Store with default busy settings; count refusals, lost acks, latency.
import { freshEnv, startWriter, check, url, R8 } from "./lib.mjs";
import { rmSync } from "node:fs";
const P = Number(process.argv[2] ?? 12), K = Number(process.argv[3] ?? 40);
const D = process.env.DIST || R8;
const t = freshEnv();
const script = `await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");import {writeSync} from "node:fs";
const go=Number(process.argv[2]);while(Date.now()<go);
let busy=0,lat=[];const s=new Store(process.argv[1],{bodyIndex:"off"});
for(let i=0;i<${K};i++){const a=performance.now();try{const n=s.create({title:"mw"+process.pid+"-"+i,body:"multi writer "+i+" "+"z".repeat(200)},{bulkImport:true});lat.push(performance.now()-a);writeSync(1,"ACK "+n.id+"\\n")}catch(e){busy++;writeSync(2,"ERR "+e.message+"\\n")}}
writeSync(1,"STAT "+JSON.stringify({busy,max:Math.max(...lat),p50:lat.sort((x,y)=>x-y)[lat.length>>1]})+"\\n");`;
const go = Date.now() + 4000 + P * 300;
const ws = Array.from({ length: P }, () => startWriter(script, [t.db, String(go)], t.env));
await Promise.all(ws.map((w) => w.done));
const all = new Set(); ws.forEach((w) => w.acked.forEach((i) => all.add(i)));
const c = check(t.db);
const lost = [...all].filter((i) => !c.ids.has(i)).length;
const errs = ws.map((w) => w.err()).join("").split("\n").filter(Boolean);
console.log(JSON.stringify({ P, K, acked: all.size, expected: P * K, lost, refused: errs.length, errSample: errs.slice(0, 3), integ: c.integ }));
try { rmSync(t.root, { recursive: true, force: true }); } catch {}
