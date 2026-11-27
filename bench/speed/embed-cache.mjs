// --import this: memoise embedding HTTP calls on disk (key = request body) so two builds are compared on IDENTICAL vectors.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const F = process.env.EMBED_CACHE_FILE; const mem = new Map();
if (F && existsSync(F)) for (const l of readFileSync(F, "utf8").split("\n")) { if (!l) continue; const [k, v] = JSON.parse(l); mem.set(k, v); }
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/embeddings") || !F) return real(url, init);
  const k = String(init?.body); let v = mem.get(k);
  if (!v) { const r = await real(url, init); if (!r.ok) return r; v = await r.text(); mem.set(k, v); appendFileSync(F, JSON.stringify([k, v]) + "\n"); }
  return new Response(v, { status: 200, headers: { "content-type": "application/json" } });
};
