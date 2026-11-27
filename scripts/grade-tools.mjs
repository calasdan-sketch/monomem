// Tool-definition grader: lints MCP tools/list entries the way directory graders and the spec's best-practice notes do.
// Use: node scripts/grade-tools.mjs [--json]   (runs a real stdio server per profile: default, all, admin)
// Safe: it points MONOMEM_HOME, ONEMEMORY_HOME and MONOMEM_AUDIT_LOG at a fresh temp folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const when = /\b(use|when|after|before|instead|start of|call)\b/i;

/** Score one tool 0-100 from its tools/list entry. Returns { score, issues }. */
export function gradeTool(t) {
  const issues = [];
  let score = 0;
  const add = (pts, ok, msg) => (ok ? (score += pts) : issues.push(`${msg} (-${pts})`));
  const d = t.description ?? "";
  const s = t.inputSchema ?? {};
  const props = Object.entries(s.properties ?? {});
  const a = t.annotations ?? {};
  add(5, NAME_RE.test(t.name), "name is not [a-zA-Z0-9_.-]{1,64}");
  add(5, /^[a-z]+(_[a-z0-9]+)+$/.test(t.name), "name is not verb_noun snake_case");
  add(5, typeof t.title === "string" && t.title.length >= 3, "no title");
  add(10, d.length >= 60 && d.length <= 700, `description length ${d.length} outside 60-700`);
  add(10, when.test(d), "description never says when to use it");
  add(5, !/\b(TODO|FIXME|lorem)\b/i.test(d), "placeholder text in description");
  add(5, s.type === "object", "inputSchema is not an object");
  add(5, (s.required ?? []).every((k) => k in (s.properties ?? {})), "required names a missing property");
  const undoc = props.filter(([, v]) => !v.description).map(([k]) => k);
  add(20, undoc.length === 0, `parameters without a description: ${undoc.join(", ")}`);
  const badEnum = props.filter(([, v]) => v.enum && (!Array.isArray(v.enum) || v.enum.length === 0)).map(([k]) => k);
  add(5, badEnum.length === 0, `empty enum: ${badEnum.join(", ")}`);
  const badArr = props.filter(([, v]) => v.type === "array" && !v.items).map(([k]) => k);
  add(5, badArr.length === 0, `array without items: ${badArr.join(", ")}`);
  const missing = HINTS.filter((h) => typeof a[h] !== "boolean");
  add(15, missing.length === 0, `annotations missing: ${missing.join(", ")}`);
  add(5, !(a.readOnlyHint === true && a.destructiveHint === true), "readOnly and destructive both true");
  return { name: t.name, score, issues };
}

/** Whole-list checks: unique names, no description that is another tool's twin. Returns an array of issue strings. */
export function gradeList(tools) {
  const out = [];
  const names = tools.map((t) => t.name);
  for (const n of names) if (names.indexOf(n) !== names.lastIndexOf(n)) out.push(`duplicate name ${n}`);
  const descs = tools.map((t) => t.description);
  for (const x of descs) if (descs.indexOf(x) !== descs.lastIndexOf(x)) out.push("two tools share one description");
  return out;
}

export async function listProfile(profile, cli) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "monomem-grade-"));
  const env = { ...process.env, MONOMEM_HOME: join(home, "h"), ONEMEMORY_HOME: join(home, "o"), MONOMEM_AUDIT_LOG: join(home, "audit.log") };
  delete env.MONOMEM_TOOLS;
  delete env.MONOMEM_STDIO_ADMIN_TOOLS;
  if (profile !== "default") env.MONOMEM_TOOLS = "all";
  if (profile === "admin") env.MONOMEM_STDIO_ADMIN_TOOLS = "1";
  const c = new Client({ name: "grade", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd: home, stderr: "ignore" }));
  try {
    return (await c.listTools()).tools;
  } finally {
    await c.close();
  }
}

/** Grade every profile. Returns { profile: { tools: [{name,score,issues}], list: [...], mean, min, chars } }. */
export async function gradeAll(cli) {
  const res = {};
  for (const p of ["default", "all", "admin"]) {
    const tools = await listProfile(p, cli);
    const graded = tools.map(gradeTool);
    const mean = graded.reduce((n, g) => n + g.score, 0) / graded.length;
    res[p] = { tools: graded, list: gradeList(tools), mean, min: Math.min(...graded.map((g) => g.score)), chars: JSON.stringify(tools).length };
  }
  return res;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "cli.js");
  const res = await gradeAll(cli);
  if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 1));
  else
    for (const [p, r] of Object.entries(res)) {
      console.log(`${p}: ${r.tools.length} tools, ${r.chars} chars, mean ${r.mean.toFixed(1)}, min ${r.min}`);
      for (const g of r.tools) console.log(`  ${g.score.toString().padStart(3)} ${g.name}${g.issues.length ? "  " + g.issues.join("; ") : ""}`);
      for (const i of r.list) console.log(`  LIST: ${i}`);
    }
}
