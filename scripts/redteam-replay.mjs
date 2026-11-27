// Replay a JSONL of payloads ({id,tool,family,text,title?}) through Monomem's real REST write path on a throwaway store,
// once as an app key (writer "outsider") and once as the owner's terminal (writer "cli"). Output: JSONL verdicts.
// usage: node scripts/redteam-replay.mjs payloads.jsonl out.jsonl   (run after `npm run build`)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/src/store.js";
import { MonomemAdapter } from "../dist/src/bench/monomem-adapter.js";
import { withStoreCopy } from "../dist/src/drill.js";
import { sampleVerdict } from "../dist/src/attack-sets/index.js";

const [inp, outp] = process.argv.slice(2);
const items = readFileSync(inp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tmp = mkdtempSync(join(tmpdir(), "redteam-seed-"));
const seed = join(tmp, "state.db");
new Store(seed).close();
const rows = [];
await withStoreCopy(seed, async (copy) => {
  const ad = new MonomemAdapter(copy);
  try {
    await ad.open({ actors: { agent: { scope: "write", writer: "outsider", server: "main" }, owner: { scope: "write", writer: "cli", server: "main" }, reader: { scope: "read", writer: "reader", server: "main" } }, grants: {} });
    let n = 0;
    for (const it of items) {
      for (const who of ["agent", "owner"]) {
        const tag = `rt${n++}x${Math.random().toString(36).slice(2, 8)}`;
        const w = await ad.write(who, { title: it.title ?? "Note", body: it.text, tags: [tag] });
        let found = false;
        if (w.outcome === "ok") {
          const h = await ad.search("reader", tag);
          found = (h.hits ?? []).some((x) => x.id === w.note?.id);
        }
        rows.push({ id: it.id, tool: it.tool, family: it.family, who, ...sampleVerdict(w, found) });
      }
    }
  } finally {
    await ad.close().catch(() => {});
  }
});
rmSync(tmp, { recursive: true, force: true });
writeFileSync(outp, rows.map((r) => JSON.stringify(r)).join("\n"));
console.log("rows", rows.length);
