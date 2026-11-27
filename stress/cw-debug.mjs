import { freshEnv, startWriter, url, R8, sleep } from "./lib.mjs";
const D = R8; const t = freshEnv();
const mk = (tag, pace) => `await import("${url(D, "src/quiet-sqlite.js")}");const {Store}=await import("${url(D, "src/store.js")}");import {writeSync} from "node:fs";const s=new Store(process.argv[1],{busyTimeoutMs:8000,bodyIndex:"off"});let busy=0;for(let i=0;;i++){try{const n=s.create({title:"${tag}"+i,body:"cw note "+i+" tok"+i+" "+"lorem ipsum ".repeat(30)},{bulkImport:true});writeSync(1,"ACK "+n.id+"\\n");const e=Date.now()+${pace};while(Date.now()<e);}catch(e){busy++;writeSync(2,"["+i+"] "+e.name+" "+e.message+"\\n");if(!/locked|busy/i.test(e.message))process.exit(1)}}`;
const a = startWriter(mk("A", 0), [t.db], t.env), b = startWriter(mk("B", 40), [t.db], t.env);
const T0 = Date.now(); let last = 0;
while (Date.now() - T0 < 240000) { await sleep(5000); if (b.c.exitCode !== null) break; }
console.log("A acked", a.acked.size, "B acked", b.acked.size, "B exit", b.c.exitCode, "B err:", b.err().slice(-700), "A err:", a.err().slice(0, 300));
a.c.kill(); b.c.kill();
