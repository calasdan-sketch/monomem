// How big is the session-start block? Measures the README "Honest numbers" recall figures.
//
//   npm run build
//   node bench/recall-size.mjs
//
// Makes a throwaway data folder (never your own), adds 60 short notes with `monomem add`, runs `monomem recall` at the
// default MONOMEM_RECALL_TOKENS, and prints the characters, an estimated token count (4 characters a token) and how many
// of the 60 notes the block lists. The folder is deleted afterwards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist", "src", "cli.js");
const home = mkdtempSync(join(tmpdir(), "monomem-recall-size-"));
const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_AUDIT_LOG: join(home, "audit.log"), NO_COLOR: "1" };
for (const k of Object.keys(env)) if (k.startsWith("MONOMEM_") && !["MONOMEM_HOME", "MONOMEM_AUDIT_LOG"].includes(k)) delete env[k];
delete env.MONOMEM_RECALL_TOKENS;
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`monomem ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
};
try {
  const topics = ["deploy", "database", "testing", "release", "billing", "auth", "logging", "caching", "search", "backup"];
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const t = topics[i % topics.length];
    const out = run(["add", `Note ${i + 1} about ${t}: we use the ${t} setup from step ${i + 1} and keep it short.`, "--title", `${t} note ${i + 1}`]);
    const m = /#(\d+)/.exec(out);
    if (m) ids.push(Number(m[1]));
  }
  const block = run(["recall"]);
  const listed = ids.filter((id) => new RegExp(`#${id}\\b`).test(block)).length;
  console.log(JSON.stringify({ notes: ids.length, chars: block.length, tokens_est: Math.round(block.length / 4), listed }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
