// docs/footprint.md promises "no outbound call by default" and lists every outbound call. This keeps that list true:
// a new fetch()/http request in src/ fails here until the doc's table (and this allowlist) are updated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED = new Map([
  ["src/embeddings.ts", 1],
  ["src/llm.ts", 1],
  ["src/hook.ts", 1],
  ["src/runner-sign.ts", 1],
  ["src/ui/js-core.ts", 2], // browser-side fetches to the server that served the page (the API calls, and the one-time sign-in code)
  ["src/cli.ts", 1], // `monomem backup restore`: is my own server up? (127.0.0.1 only)
  ["src/embeddings-offer.ts", 1], // `monomem setup`: does a local Ollama have nomic-embed-text? (127.0.0.1:11434 only)
  ["src/cli/connect.ts", 1], // `monomem open`: is my own server up? (127.0.0.1 only)
  ["src/doctor/server.ts", 2], // `monomem doctor`: the local server's version, and its /status body-index line (127.0.0.1 only)
  ["src/local-server.ts", 1], // session start proves a local server holds this store's main key (GET /proof, loopback only)
  ["src/recall.ts", 1], // the recall hook asks that proven local server for body matches (POST /relevant)
  ["src/update.ts", 3], // `monomem update` (typed only, never in hooks): the latest release from api.github.com, then its archive + SHA256SUMS; after a dashboard update, is the restarted server up? (127.0.0.1 only)
  ["src/cli/stop.ts", 1], // `monomem stop`: does the server `monomem open` started still answer? (127.0.0.1 only)
  ["src/attack-sets/index.ts", 1], // `monomem check --attacks --set poisonedrag-nq` (typed only): the pinned PoisonedRAG file from raw.githubusercontent.com, SHA-256 checked
]);
const CALL = /\bfetch\(|\bhttps?\.(?:request|get)\(|new WebSocket\(|\bnet\.connect\(|\btls\.connect\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "bench" ? [] : files(p)) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every outbound network call in src/ is one docs/footprint.md lists", () => {
  const root = join(import.meta.dirname, "..", "..");
  const found = new Map<string, number>();
  for (const f of files(join(root, "src"))) {
    const text = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, ""); // comments do not count
    const n = (text.match(CALL) ?? []).length;
    if (n) found.set(relative(root, f).split("\\").join("/"), n);
  }
  assert.deepEqual(Object.fromEntries([...found].sort()), Object.fromEntries([...ALLOWED].sort()));
  const doc = readFileSync(join(root, "docs", "footprint.md"), "utf8");
  for (const f of ALLOWED.keys()) assert.ok(doc.includes(f), `docs/footprint.md must list ${f}`);
});
