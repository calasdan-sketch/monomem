// `bench --longmemeval | --locomo` and `bench --scale` point MONOMEM_HOME at a temp folder, then import config.js
// dynamically. If cli.js loads config.js through a STATIC import, config resolves the real data folder first and the
// retrieval bench refuses to run on any machine that has a store (92ad1a6 did this via `import ... from "./lint.js"`).
// This test walks cli.js's static import graph and fails if config.js is reachable.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const IMPORT_RE = /^\s*import\s+(?:[^;]*?\s+from\s+)?"(\.[^"]+)"/gm; // `import type` is erased by tsc, so dist never has it

test("cli.js never loads config.js through a static import (bench must move MONOMEM_HOME first)", () => {
  const start = join(SRC, "cli.js");
  const target = join(SRC, "config.js");
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (file === target) break;
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const next = resolve(dirname(file), m[1]);
      if (!parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  const chain: string[] = [];
  for (let f: string | null | undefined = target; f; f = parent.get(f)) chain.unshift(f.slice(SRC.length + 1));
  assert.equal(parent.has(target), false, `static import chain reaches config.js: ${chain.join(" -> ")}`);
});
