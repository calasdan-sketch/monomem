// node hookcold.mjs <root> <event> <reps> [dbdir]: time `node cli.js hook <event>` (stdin = JSON) end to end. Fresh copy of the home each rep.
import { mkdtempSync, rmSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os"; import { spawnSync } from "node:child_process";
const [root, ev, reps, src] = process.argv.slice(2); const a = [], cwd = mkdtempSync(join(tmpdir(), "mm-hk-cwd-"));
const input = JSON.stringify({ session_id: "s1", cwd, hook_event_name: ev, prompt: "how do we deploy the database migration" , transcript_path: "" });
for (let i = 0; i < +reps; i++) {
  const d = mkdtempSync(join(tmpdir(), "mm-hk-")); if (src) cpSync(src, d, { recursive: true });
  const env = { ...process.env, MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log") };
  const t = performance.now(); const r = spawnSync("node", [`${root}/dist/src/cli.js`, "hook", ev], { input, env, encoding: "utf8", cwd }); a.push(performance.now() - t);
  if (i === 0) console.error("exit", r.status, "stdout bytes", r.stdout.length, r.stderr.slice(0, 150));
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}
const s = [...a].sort((x, y) => x - y); console.log(JSON.stringify({ ev, med: +s[s.length >> 1].toFixed(0), min: +s[0].toFixed(0), max: +s.at(-1).toFixed(0) }));
