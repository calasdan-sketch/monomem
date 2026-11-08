// `monomem import --rules`: bring the rules files other coding assistants keep (.cursorrules, .cursor/rules/*,
// AGENTS.md, GEMINI.md, .windsurfrules) into Monomem as notes. Same care as `import --claude`: every section is split at
// headings, anything that looks like a secret is skipped (not stored, not shown), a section carries a stable source id so
// running it again adds nothing, and text the memory linter reads as an instruction to an AI is held in quarantine.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { splitSections, chunkBody, parseFrontmatter, looksLikeCredential, readHeld, writeHeld, MAX_FILE_BYTES } from "./claude-import.js";
import { lintContent } from "./lint.js";
import { LIMITS } from "./security.js";

export const RULES_TAG = "rules-import";
export const RULES_WRITER = "import:rules";

export type RulesKind = "cursorrules" | "cursor-rules" | "agents-md" | "gemini-md" | "windsurfrules";

export interface RulesFile {
  kind: RulesKind;
  display: string;
  real: string;
  rel: string;
  project: string;
}

const h = (s: string, n = 16): string => createHash("sha256").update(s).digest("hex").slice(0, n);

export function discoverRules(projects: string[]): { files: RulesFile[]; skipped: Array<{ display: string; why: string }> } {
  const files: RulesFile[] = [];
  const skipped: Array<{ display: string; why: string }> = [];
  for (const p of projects) {
    let root: string;
    try {
      root = realpathSync(resolve(p));
    } catch {
      skipped.push({ display: p, why: "folder not found" });
      continue;
    }
    const project = basename(root) || "project";
    const consider = (rel: string, kind: RulesKind): void => {
      const path = join(root, rel);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        return; // simply not there
      }
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        skipped.push({ display: rel, why: "cannot be read" });
        return;
      }
      if (!real.startsWith(root + sep)) return void skipped.push({ display: rel, why: "points outside the project folder" });
      if (!st.isFile() && !st.isSymbolicLink()) return;
      try {
        if (lstatSync(real).size > MAX_FILE_BYTES) return void skipped.push({ display: rel, why: "over 1 MB: not a rules file" });
      } catch {
        return;
      }
      files.push({ kind, display: `${project}/${rel}`, real, rel, project });
    };
    consider(".cursorrules", "cursorrules");
    consider("AGENTS.md", "agents-md");
    consider("GEMINI.md", "gemini-md");
    consider(".windsurfrules", "windsurfrules");
    for (const dir of [".cursor/rules", ".windsurf/rules"]) {
      let names: string[] = [];
      try {
        names = readdirSync(join(root, dir)).filter((f) => /\.(mdc|md)$/i.test(f)).sort();
      } catch {
        /* no folder */
      }
      for (const f of names) consider(`${dir}/${f}`, "cursor-rules");
    }
  }
  return { files, skipped };
}

export interface RulesCandidate {
  file: RulesFile;
  title: string;
  body: string;
  tags: string[];
  source: string;
  loc: string;
  content: string;
  secret: boolean;
}

export const rulesSourceKey = (loc: string, content: string): string => `rules-import:v1:${loc}:${content}`;
const parseKey = (s: string): { loc: string; content: string } | null => {
  const m = /^rules-import:v1:([0-9a-f]{16}):([0-9a-f]{16})$/.exec(s);
  return m ? { loc: m[1], content: m[2] } : null;
};

export function buildRulesCandidates(files: RulesFile[]): { candidates: RulesCandidate[]; unreadable: string[] } {
  const candidates: RulesCandidate[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.real, "utf8");
    } catch {
      unreadable.push(file.display);
      continue;
    }
    if (file.rel.endsWith(".mdc")) text = parseFrontmatter(text).body;
    const stem = basename(file.rel).replace(/\.(mdc|md)$/i, "") || file.rel;
    const { sections } = splitSections(text, file.kind === "agents-md" ? "Agent instructions" : file.kind === "gemini-md" ? "Gemini instructions" : `Rules (${stem})`);
    for (const s of sections) {
      const parts = chunkBody(s.body);
      parts.forEach((part, i) => {
        const title = `${file.rel}: ${parts.length > 1 ? `${s.path} (part ${i + 1} of ${parts.length})` : s.path}`.slice(0, LIMITS.title);
        const loc = h([file.project, file.rel, s.path, String(s.occurrence), String(i)].join("\u0000"));
        const content = h(part);
        const tags = [RULES_TAG, `rules:${file.kind}`, `project:${file.project}`].map((x) => x.slice(0, LIMITS.tagLen));
        const finds = lintContent({ title, body: part, tags });
        const secret = finds.some((f) => f.category === "secret" || f.category === "entropy") || looksLikeCredential(title + "\n" + part);
        candidates.push({ file, title, body: part, tags, source: rulesSourceKey(loc, content), loc, content, secret });
      });
    }
  }
  return { candidates, unreadable };
}

export interface RulesImportOptions {
  projects: string[];
  dryRun: boolean;
  namespace?: string;
  dbPath: string;
}

export async function runRulesImport(opts: RulesImportOptions, out: (s: string) => void = console.log): Promise<number> {
  const { files, skipped } = discoverRules(opts.projects);
  out("Reading rules files in the folder(s) you named (nothing leaves this computer):");
  if (!files.length) {
    out("  I found no .cursorrules, .cursor/rules, AGENTS.md, GEMINI.md or .windsurfrules there.");
    out("  Use --project <folder>[,<folder>] to name a project folder.");
    for (const s of skipped) out(`  skipped ${s.display}: ${s.why}`);
    return 0;
  }
  const { candidates, unreadable } = buildRulesCandidates(files);
  const { Store, SCHEMA_VERSION } = await import("./store.js");
  const onDisk = Store.peekSchemaVersion(opts.dbPath);
  const store = onDisk === SCHEMA_VERSION ? new Store(opts.dbPath) : null;
  let writer: InstanceType<typeof Store> | null = store;
  try {
    const known = new Map<string, string>();
    for (let offset = 0; store; offset += 500) {
      const page = store.list({ withTags: [RULES_TAG], limit: 500, offset, includeArchived: true, includeSuperseded: true });
      for (const n of page.notes) {
        const k = parseKey(n.source);
        if (k) known.set(k.loc, k.content);
      }
      if (page.notes.length < 500) break;
    }
    const held = readHeld(opts.dbPath);
    let create = 0, same = 0, changed = 0, secrets = 0, heldSkipped = 0;
    const todo: RulesCandidate[] = [];
    for (const c of candidates) {
      if (c.secret) {
        secrets++;
        continue;
      }
      const k = known.get(c.loc);
      if (k === undefined) {
        if (held.has(c.source)) heldSkipped++;
        else {
          create++;
          todo.push(c);
        }
      } else if (k === c.content) same++;
      else changed++;
    }
    out(`${candidates.length} section(s) in ${files.length} file(s): ${create} new, ${same} already imported, ${changed} changed since (left as they are), ${secrets} skipped because they look like a secret.`);
    if (secrets) out("  Skipped sections are not stored and not shown. Take the secret out of the file and run again.");
    if (heldSkipped) out(`  ${heldSkipped} section(s) were held by the memory linter on an earlier run (see \`monomem quarantine list\`).`);
    for (const s of skipped) out(`  skipped ${s.display}: ${s.why}`);
    for (const u of unreadable) out(`  could not read ${u}`);
    if (opts.dryRun) {
      out("Dry run: nothing was written.");
      return 0;
    }
    if (!todo.length) {
      out("Nothing to import.");
      return 0;
    }
    writer = writer ?? new Store(opts.dbPath);
    let created = 0, heldNow = 0, failed = 0;
    for (const t of todo) {
      try {
        writer.create({ namespace: opts.namespace, title: t.title, body: t.body, tags: t.tags, source: t.source }, { writtenBy: RULES_WRITER, skipEdges: false });
        created++;
      } catch (err) {
        if ((err as Error).constructor.name === "QuarantinedError") {
          heldNow++;
          held.add(t.source);
        } else failed++;
      }
    }
    if (heldNow) writeHeld(opts.dbPath, held);
    out(`Imported ${created} new note(s), tagged "${RULES_TAG}" and written by "${RULES_WRITER}".`);
    if (heldNow) out(`${heldNow} section(s) were held by the memory linter (they read like an instruction to an AI): see \`monomem quarantine list\`.`);
    if (failed) {
      out(`${failed} section(s) could not be stored.`);
      return 1;
    }
    return 0;
  } finally {
    writer?.close();
    if (store && store !== writer) store.close();
  }
}
