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
  ["src/dashboard.ts", 2], // browser-side fetches to the server that served the page (the API calls, and the one-time sign-in code)
  ["src/cli.ts", 2], // `monomem open` and `monomem restore`: is my own server up? (127.0.0.1 only)
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
