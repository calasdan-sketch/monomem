// child: wait for go-time, open Store raw (no retry wrapper), write one note, report.
import { pathToFileURL } from "node:url";
const D = process.env.DIST ? pathToFileURL(process.env.DIST).href : new URL("../dist", import.meta.url).href;
await import(D+"/src/quiet-sqlite.js");
const { Store } = await import(D+"/src/store.js");
const [db, goAt, label, mode] = process.argv.slice(2);
while (Date.now() < Number(goAt)) { /* spin */ }
const t0 = Date.now();
try {
  const s = new Store(db, { bodyIndex: "off" });
  const t1 = Date.now();
  let id = -1;
  if (mode !== "openonly") id = s.create({ title: `n-${label}`, body: `cold start note ${label}` }, { bulkImport: true }).id;
  s.close?.();
  console.log(JSON.stringify({ ok: true, label, openMs: t1 - t0, id }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, label, err: String(e.message).slice(0, 200), stack: String(e.stack).split("\n").slice(1, 5).join(" | ") }));
}
