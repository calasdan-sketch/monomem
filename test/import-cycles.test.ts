// store.ts must sit in no import cycle (1.5.0 round-2 A1). A module in a runtime cycle is evaluated before its partner has
// finished loading, so a top-level `const` that reads an import becomes a TDZ crash at startup, and which file wins depends
// on load order. The store split (src/store/*) relies on this: the moved modules import `type { Store }` only.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Runtime (value) imports of one source text: relative specifiers only; `import type` and all-`type` brace lists are skipped. */
export function runtimeImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+"(\.{1,2}\/[^"]+)"/gm)) {
    if (m[1]) continue;
    const inner = m[2].trim();
    if (/^\{[\s\S]*\}$/.test(inner) && inner.replace(/[{}\s]/g, "").split(",").filter(Boolean).every((s) => s.startsWith("type"))) continue;
    out.push(m[3]);
  }
  for (const m of text.matchAll(/^import\s+"(\.{1,2}\/[^"]+)"/gm)) out.push(m[1]);
  return out;
}

/** Strongly connected components with more than one member (Tarjan), as sorted paths relative to src/. */
export function cycles(graph: Map<string, string[]>): string[][] {
  let idx = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const I = new Map<string, number>();
  const L = new Map<string, number>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    I.set(v, idx);
    L.set(v, idx++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!I.has(w)) {
        visit(w);
        L.set(v, Math.min(L.get(v)!, L.get(w)!));
      } else if (on.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!));
    }
    if (L.get(v) === I.get(v)) {
      const c: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1) out.push(c.sort());
    }
  };
  for (const v of graph.keys()) if (!I.has(v)) visit(v);
  return out;
}

function srcGraph(): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const f of tsFiles(SRC)) {
    const key = relative(SRC, f).replace(/\\/g, "/");
    const deps = runtimeImports(readFileSync(f, "utf8")).map((spec) =>
      relative(SRC, resolve(dirname(f), spec.replace(/\.js$/, ".ts"))).replace(/\\/g, "/"),
    );
    g.set(key, deps);
  }
  return g;
}

test("the scanner: type-only imports are ignored, value imports and side-effect imports count (positive control)", () => {
  const sample = [
    'import type { Store } from "./store.js";',
    'import { type A, type B } from "./a.js";',
    'import { type C, D } from "./c.js";',
    "import {",
    "  E,",
    '} from "../e.js";',
    'import { x } from "node:fs";',
    'export { F } from "./f.js";',
    'import "./side.js";',
  ].join("\n");
  assert.deepEqual(runtimeImports(sample).sort(), ["../e.js", "./c.js", "./f.js", "./side.js"]);
  const g = new Map([["a", ["b"]], ["b", ["a", "c"]], ["c", []]]);
  assert.deepEqual(cycles(g), [["a", "b"]]);
});

test("store.ts is in no runtime import cycle", () => {
  const g = srcGraph();
  assert.ok(g.has("store.ts") && g.get("store.ts")!.length > 5, "the scan found store.ts and its imports");
  const withStore = cycles(g).filter((c) => c.includes("store.ts"));
  assert.deepEqual(withStore, [], `store.ts sits in an import cycle: ${withStore.map((c) => c.join(" ")).join(" | ")}`);
});
