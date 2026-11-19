// The commands added in 1.7.0: drift, audit-memory, prune, handoff, tools. Loaded on demand by cli.ts so none of them
// adds to start-up. Each is read-only except `prune --yes` (archives, never deletes) and `tools --verify` (writes tool-pin.json).
import { parseFlags } from "./shared.js";

async function gitRoot(cwd: string): Promise<string> {
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The project namespace: --ns, else the folder's own. `undefined` = every namespace (said so in `note`). */
async function projectNs(flagNs: string | undefined): Promise<{ ns?: string; note: string; stop: boolean }> {
  if (flagNs) return { ns: flagNs, note: "", stop: false };
  const { resolveRecallNamespace } = await import("../recall.js");
  const res = await resolveRecallNamespace(process.cwd());
  if (res.kind === "resolved") return { ns: res.namespace, note: "", stop: false };
  if (res.kind === "unresolvable") return { note: "", stop: true };
  return { note: "This folder has no project namespace, so notes from every namespace were used.", stop: false };
}

async function openStore() {
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  return new Store(DB_PATH);
}

const BAD_NS = "This folder's namespace could not be worked out (see the message above). Name one with --ns.";

export async function round3Cmd(cmd: string, args: string[]): Promise<void> {
  if (cmd === "drift") return drift(args);
  if (cmd === "audit-memory") return auditMemoryCmd(args);
  if (cmd === "prune") return prune(args);
  if (cmd === "handoff") return handoff(args);
  if (cmd === "rescan") return rescan(args);
  return toolsCmd(args);
}

async function drift(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["namespace", "root"], bools: ["json"] });
  if (rest.length) {
    console.error("Usage: monomem drift [--ns <namespace>] [--root <folder>] [--json]");
    process.exit(1);
  }
  const root = typeof flags.root === "string" ? flags.root : (await gitRoot(process.cwd())) || process.cwd();
  const p = await projectNs(typeof flags.namespace === "string" ? flags.namespace : undefined);
  if (p.stop) {
    console.error(BAD_NS);
    process.exit(1);
  }
  const { findDrift, RepoFacts } = await import("../drift.js");
  const { TASK_TAG } = await import("../task-core.js");
  const { HANDOFF_TAG } = await import("../tasks.js");
  const store = await openStore();
  try {
    const notes = store.list({ namespace: p.ns, limit: 5000, count: false, withoutTags: [TASK_TAG, HANDOFF_TAG] }).notes;
    const { disagreements, claims } = findDrift(notes, new RepoFacts(root));
    if (flags.json) console.log(JSON.stringify({ root, namespace: p.ns ?? null, notes: notes.length, claims, disagreements }, null, 2));
    else {
      if (p.note) console.log(p.note);
      if (!disagreements.length) console.log(`No drift: ${claims} claim(s) about this repository in ${notes.length} note(s) all agree with ${root}.`);
      else {
        console.log(`${disagreements.length} note claim(s) disagree with ${root}:`);
        for (const d of disagreements) console.log(`  note #${d.id} "${d.title.slice(0, 60)}" ${d.problem}`);
        console.log("Fix or archive those notes (monomem archive <id>), or confirm they are about another repository.");
      }
    }
    if (disagreements.length) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function auditMemoryCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: [], bools: ["json"] });
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const root = (await gitRoot(process.cwd())) || process.cwd();
  const targets = rest.length ? rest : [root, join(homedir(), ".claude", "CLAUDE.md")].filter((t) => existsSync(t));
  const { auditMemory } = await import("../audit-memory.js");
  const r = auditMemory(targets);
  const bad = r.findings.filter((f) => f.kind === "secret" || f.kind === "injection");
  if (flags.json) console.log(JSON.stringify({ files: r.files, missing: r.missing, skipped: r.skipped, unreadable: r.unreadable, findings: r.findings }, null, 2));
  else {
    console.log(`Checked ${r.files.length} memory file(s). Nothing was changed.`);
    for (const m of r.missing) console.log(`  not found: ${m}`);
    for (const s of r.skipped) console.log(`  skipped (a link or junction, which could point anywhere; name the real file to check it): ${s}`);
    for (const u of r.unreadable) console.log(`  could not read: ${u}`);
    for (const f of r.findings) console.log(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.kind}: ${f.label}\n      ${f.excerpt}`);
    if (!r.findings.length) console.log("No secrets or instruction-style text found.");
    else console.log("Secrets are shown cut short on purpose. Rotate any real one and remove it from the file.");
  }
  if (bad.length) process.exitCode = 1;
}

async function prune(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["namespace", "days"], bools: ["json", "dry-run", "yes"] });
  const days = flags.days === undefined ? 90 : Number(flags.days);
  if (rest.length || !Number.isFinite(days) || days < 0 || (flags.yes && flags["dry-run"])) {
    console.error("Usage: monomem prune [--days N] [--ns <namespace>] [--dry-run | --yes] [--json]   (default is --dry-run; --yes archives, never deletes)");
    process.exit(1);
  }
  const p = await projectNs(typeof flags.namespace === "string" ? flags.namespace : undefined);
  if (p.stop) {
    console.error(BAD_NS);
    process.exit(1);
  }
  const { pruneCandidates, applyPrune } = await import("../prune.js");
  const store = await openStore();
  try {
    const cands = pruneCandidates(store, { namespace: p.ns, days });
    const done = flags.yes ? applyPrune(store, cands) : [];
    if (flags.json) console.log(JSON.stringify({ days, dry_run: !flags.yes, candidates: cands, archived: done }, null, 2));
    else {
      if (p.note) console.log(p.note);
      if (!cands.length) console.log(`Nothing to prune: no unpinned, never-recalled, low-value note is older than ${days} days.`);
      for (const c of cands) console.log(`  note #${c.id} "${c.title.slice(0, 60)}"  ${c.why}`);
      if (flags.yes) {
        if (!done.length) console.log(cands.length ? "Nothing was archived (every candidate was protected or already gone when it was re-checked)." : "");
        else {
          console.log(`Archived ${done.length} note${done.length === 1 ? "" : "s"} (nothing was deleted):`);
          const byId = new Map(cands.map((c) => [c.id, c]));
          for (const id of done) console.log(`  note #${id} "${(byId.get(id)?.title ?? "").slice(0, 60)}"   undo: monomem restore ${id}`);
        }
      }
      else if (cands.length) console.log(`${cands.length} note(s) would be archived (dry run). Run again with --yes to archive them; monomem restore <id> brings one back.`);
    }
  } finally {
    store.close();
  }
}

/** `monomem check --rescan [--dry-run] [--ns <namespace>] [--json]`: today's linter over every stored note (src/rescan.ts). */
async function rescan(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["namespace", "ns"], bools: ["json", "dry-run"] });
  if (rest.length) {
    console.error("Usage: monomem check --rescan [--dry-run] [--ns <namespace>] [--json]");
    process.exit(1);
  }
  const { DATA_DIR, PACKAGE_VERSION } = await import("../config.js");
  const { rescanNotes, rescanSummary, writeScanMarker } = await import("../rescan.js");
  const ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
  const dry = Boolean(flags["dry-run"]);
  const store = await openStore();
  try {
    const r = rescanNotes(store, { namespace: ns, dryRun: dry });
    if (flags.json) console.log(JSON.stringify({ version: PACKAGE_VERSION, dry_run: dry, ...r }, null, 2));
    else for (const l of rescanSummary(r, PACKAGE_VERSION, dry)) console.log(l);
    if (!dry && !ns) {
      try {
        writeScanMarker(DATA_DIR, { scanned_version: PACKAGE_VERSION, scanned_at: new Date().toISOString() });
      } catch {
        /* a read-only data folder: the scan itself still happened */
      }
    }
  } finally {
    store.close();
  }
}

async function handoff(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["namespace", "max-tokens"], bools: ["all-projects"] });
  const maxTokens = flags["max-tokens"] === undefined ? 1500 : Number(flags["max-tokens"]);
  if (rest.length || !Number.isFinite(maxTokens) || maxTokens < 1) {
    console.error("Usage: monomem handoff [--ns <namespace>] [--all-projects] [--max-tokens N]");
    process.exit(1);
  }
  const p = await projectNs(typeof flags.namespace === "string" ? flags.namespace : undefined);
  if (p.stop) {
    console.error(BAD_NS);
    process.exit(1);
  }
  // This brief leaves the machine (it is pasted into another tool). With per-project scope off or no project for this folder,
  // the notes of every project must not go along by default: only the default space does, unless --all-projects says otherwise.
  if (p.ns === undefined && !flags["all-projects"]) {
    const { handoffDefaultNamespace } = await import("../handoff.js");
    p.ns = handoffDefaultNamespace();
    p.note = `No project is set for this folder, so only the "${p.ns}" notes were used. To include every project's notes: monomem handoff --all-projects`;
  } else if (p.ns === undefined) p.note = "";
  const { buildHandoff } = await import("../handoff.js");
  const { basename } = await import("node:path");
  const store = await openStore();
  try {
    const root = (await gitRoot(process.cwd())) || process.cwd();
    const r = buildHandoff(store, { namespace: p.ns, maxTokens, project: basename(root), allProjects: Boolean(flags["all-projects"]) });
    process.stdout.write(r.text);
    if (p.note) console.error(p.note);
  } finally {
    store.close();
  }
}

async function toolsCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: [], bools: ["verify", "accept", "json"] });
  if (rest.length || !flags.verify) {
    console.error("Usage: monomem tools --verify [--accept] [--json]   (records and checks a hash of the tool names, descriptions and inputs this build serves)");
    process.exit(1);
  }
  const { DATA_DIR, PACKAGE_VERSION } = await import("../config.js");
  const { pinPath, readPin, writePin, hashTools, servedTools, comparePin, pinWentMissing } = await import("../tool-pin.js");
  const path = pinPath(DATA_DIR);
  const now = hashTools(await servedTools(), PACKAGE_VERSION);
  const stored = readPin(path);
  const { existsSync } = await import("node:fs");
  const v = comparePin(stored, now, !stored && (existsSync(path) || pinWentMissing(path))); // a record that went missing is not a fresh start
  if ((v.status === "recorded" || flags.accept) && v.status !== "unreadable") writePin(path, now);
  else if (v.status === "unreadable" && flags.accept) writePin(path, now);
  if (flags.json) console.log(JSON.stringify({ ...v, accepted: Boolean(flags.accept), tools: Object.keys(now.tools).length, overall: now.overall }, null, 2));
  else console.log(v.message + (flags.accept && v.status !== "recorded" ? " Recorded the current tools." : ""));
  if (v.status === "changed-same-version" && !flags.accept) process.exitCode = 1;
  else if ((v.status === "changed-after-upgrade" || v.status === "unreadable") && !flags.accept) process.exitCode = 1;
}
