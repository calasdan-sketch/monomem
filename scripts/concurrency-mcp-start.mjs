import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [,, dist, n, rounds, base] = process.argv; let ok=0, fail=0; const why=new Map();
for (let r=0;r<+rounds;r++){
  const dir=mkdtempSync(join(base||tmpdir(),"mm-mo-"));
  const res=await Promise.all(Array.from({length:+n},()=>new Promise((done)=>{
    const c=spawn(process.execPath,[join(dist,"src/mcp-stdio.js")],{env:{...process.env,MONOMEM_HOME:dir,ONEMEMORY_HOME:dir},stdio:["pipe","pipe","pipe"]});
    let err="";c.stderr.on("data",d=>err+=d);
    c.stdout.on("data",()=>{});
    const t=setInterval(()=>{ if(/connected/.test(err)){clearInterval(t);c.kill();done("ok")} },20);
    c.on("close",()=>{clearInterval(t);done(/connected/.test(err)?"ok":("FAIL "+err.trim().split("\n").pop().slice(0,90)))});
  })));
  for(const o of res) o==="ok"?ok++:(fail++,why.set(o,(why.get(o)||0)+1));
  await new Promise(r=>setTimeout(r,300)); try{rmSync(dir,{recursive:true,force:true})}catch{}
}
console.log(`n=${n} rounds=${rounds} ok=${ok} fail=${fail}`,[...why]);
