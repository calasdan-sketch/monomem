#!/usr/bin/env node
// One-time opt-in: installs transformers.js and downloads the multilingual-e5-small model (about 120 MB, once) into
// <MONOMEM_HOME>/embed. Monomem never does this by itself. Afterwards set MONOMEM_EMBEDDINGS=local and run `monomem reindex`.
// Usage: node scripts/install-local-embeddings.mjs [dir]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MODEL = process.env.MONOMEM_LOCAL_EMBED_MODEL || "Xenova/multilingual-e5-small";
const dir = process.argv[2] || process.env.MONOMEM_LOCAL_EMBED_DIR || join(process.env.MONOMEM_HOME || join(homedir(), ".monomem"), "embed");
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"name":"monomem-embed","private":true,"type":"module"}\n');
console.log(`Installing transformers.js into ${dir} ...`);
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "@huggingface/transformers", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
const { env, pipeline } = createRequire(join(dir, "package.json"))("@huggingface/transformers");
env.cacheDir = join(dir, "models"); // same folder monomem reads (localModelPath)
env.localModelPath = join(dir, "models");
console.log(`Downloading ${MODEL} (once) ...`);
const run = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
const out = await run("passage: hello", { pooling: "mean", normalize: true });
console.log(`Done: model answers with ${out.data.length} numbers. Now: set MONOMEM_EMBEDDINGS=local, then reindex.`);
