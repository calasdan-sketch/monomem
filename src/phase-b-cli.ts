// Command-line front ends for: scrub, pii, health, digest, safety-report, audit, demo, snippet.
// Kept apart from cli.ts so that file does not grow further. Every command here only reads, or (scrub) takes a backup first.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

type Args = ReturnType<typeof parseArgs>["values"];
function args(spec: Record<string, { type: "string" | "boolean" }>, strict = true): { v: Args; pos: string[] } {
  try {
    const r = parseArgs({ args: process.argv.slice(3), options: spec, allowPositionals: true, strict });
    return { v: r.values, pos: r.positionals };
  } catch (e) {
    console.error(`${(e as Error).message.replace(/^.*?: /, "")}`);
    process.exit(1);
  }
}
const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function scrubCmd(): Promise<void> {
  const { v } = args({ yes: { type: "boolean" }, out: { type: "string" } });
  const { DB_PATH, DATA_DIR } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { runScrub, mb, defaultScrubBackup, diskBytes } = await import("./scrub.js");
  const { keyPath } = await import("./crypto.js");
  const { dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const before = diskBytes(DB_PATH);
  const encrypted = existsSync(keyPath(dirname(DB_PATH)));
  console.log("Scrub does NOT remove personal data inside the notes you still have. It only cleans out leftovers of notes you already deleted.");
  console.log("(Also available as: monomem purge-deleted.)");
  console.log("It removes the text of notes deleted a long time ago from the database file itself.");
  console.log("Before 1.0.3 those words could stay behind in the search index and in freed space. Scrub rebuilds the search index,");
  console.log("turns on overwrite-on-delete, and compacts the file. It takes a backup first. It changes no note.");
  console.log(`Database today: ${mb(before)}. Encryption: ${encrypted ? "on" : "off"}.`);
  if (v.yes !== true) {
    console.log("\nThis was only a description. To do it: monomem scrub --yes   (a backup is made first, in your home folder)");
    return;
  }
  const backup = s(v.out) ?? defaultScrubBackup(homedir());
  const store = new Store(DB_PATH);
  try {
    const r = runScrub(store, DB_PATH, backup);
    console.log(`\nBackup saved to ${r.backupDir}${encrypted ? " (the encryption key was NOT copied there; keep your own copy of it)" : ""}`);
    console.log(`Size before: ${mb(r.beforeBytes)}   after: ${mb(r.afterBytes)}${r.vacuumed ? "" : "   (the file could not be compacted right now: try again when nothing else is writing)"}`);
    console.log("Done. Text from earlier deletions is no longer in the search index or in freed pages of this file.");
    console.log(`!! The backup it just made still CONTAINS the old text. It is at ${r.backupDir}. Once you are happy with the result, delete that folder to get rid of the old text for good.`);
    console.log(`Older copies are untouched: backups, and files named ${DATA_DIR}/state.db.pre-v*-backup (monomem backup --prune-premigration removes those).`);
  } finally {
    store.close();
  }
}

export async function piiCmd(): Promise<void> {
  const { v, pos } = args({ namespace: { type: "string" }, json: { type: "boolean" } });
  if (pos[0] !== "scan") {
    console.error("usage: monomem pii scan [--namespace <name>] [--json]");
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { scanPii, describePii } = await import("./pii.js");
  const store = new Store(DB_PATH);
  try {
    const ns = s(v.namespace);
    const notes = store.exportAll({ live: true }).filter((n) => !ns || n.namespace === ns); // gate-ok: local command, full local trust
    const r = scanPii(notes);
    if (v.json === true) {
      console.log(JSON.stringify({ scanned: r.scanned, skipped_private: r.skippedPrivate, suggestions: r.suggestions.map((x) => ({ ...x, fix: `monomem label ${x.id} private` })) }, null, 2));
      return;
    }
    console.log(`Looked at ${r.scanned} note(s); skipped ${r.skippedPrivate} already private. Nothing was changed.`);
    if (!r.suggestions.length) console.log("Found nothing that looks like personal data. (This is a pattern check: it can miss things.)");
    for (const x of r.suggestions) {
      console.log(`\n[${x.namespace}] ${describePii(x)}`);
      console.log(`    to hide it from limited apps: monomem label ${x.id} private`);
    }
    if (r.suggestions.length) console.log("\nThese are suggestions from a pattern check. It can flag things that are not personal and miss things that are. Only you decide.");
  } finally {
    store.close();
  }
}

async function openAll(): Promise<{ store: import("./store.js").Store; DATA_DIR: string; tokens: import("./config.js").TokenEntry[]; bind: string; dbPath: string }> {
  const cfg = await import("./config.js");
  const { Store } = await import("./store.js");
  return { store: new Store(cfg.DB_PATH), DATA_DIR: cfg.DATA_DIR, tokens: cfg.resolveTokens(), bind: cfg.BIND_HOST, dbPath: cfg.DB_PATH };
}

export async function digestCmd(): Promise<void> {
  const { v } = args({ since: { type: "string" }, namespace: { type: "string" }, json: { type: "boolean" } });
  const { store } = await openAll();
  try {
    const { buildDigest, renderDigest } = await import("./digest.js");
    const ns = s(v.namespace);
    const d = await buildDigest(store, s(v.since) ?? "24h", { namespaces: ns ? [ns] : undefined });
    console.log(v.json === true ? JSON.stringify(d, null, 2) : renderDigest(d));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  } finally {
    store.close();
  }
}

export async function safetyReportCmd(): Promise<void> {
  const { v } = args({ out: { type: "string" } });
  const out = s(v.out);
  if (!out) {
    console.error("usage: monomem safety-report --out report.html");
    process.exit(1);
  }
  const { store, DATA_DIR, tokens, bind, dbPath } = await openAll();
  try {
    const { safetyChecks, renderSafetyHtml } = await import("./safety-report.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    const checks = await safetyChecks({ store, dbPath, dataDir: DATA_DIR, bindHost: bind, tokens, version: PACKAGE_VERSION, node: process.versions.node, platform: process.platform, stdioCeiling: process.env.MONOMEM_STDIO_MAX_SENSITIVITY });
    const html = renderSafetyHtml(checks, { version: PACKAGE_VERSION, date: new Date().toISOString().slice(0, 10), node: process.versions.node, platform: process.platform });
    writeFileSync(resolve(out), html);
    const warns = checks.filter((c) => c.status === "Warn");
    console.log(`Wrote ${resolve(out)}: ${checks.length - warns.length} passed, ${warns.length} to look at. It holds counts and settings only: no note text, no keys.`);
    for (const w of warns) console.log(`  Warn: ${w.name}${w.fix ? `  ->  ${w.fix}` : ""}`);
  } finally {
    store.close();
  }
}

export async function auditCmd(): Promise<void> {
  const { v } = args({ since: { type: "string" }, op: { type: "string" }, label: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } });
  const { readAudit, renderAudit, parseWindow } = await import("./audit-view.js");
  const w = parseWindow(s(v.since) ?? "24h");
  if (w === null) {
    console.error("--since must look like 30m, 24h or 7d");
    process.exit(1);
  }
  const r = readAudit({ sinceMs: w, op: s(v.op), label: s(v.label), limit: s(v.limit) ? Number(v.limit) : 100 });
  if (v.json === true) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(renderAudit(r.entries));
    if (r.truncated) console.log("(more entries exist: narrow it with --op or --label, or raise --limit)");
  }
}

export async function demoCmd(): Promise<void> {
  const { v } = args({ slow: { type: "boolean" }, out: { type: "string" } });
  const { runDemo } = await import("./demo.js");
  process.exitCode = await runDemo({ pauseMs: v.slow === true ? 7000 : 0, receiptOut: s(v.out) ? resolve(s(v.out)!) : undefined });
}

export async function snippetCmd(): Promise<void> {
  const { pos } = args({});
  const { SNIPPET_CLIENTS, renderSnippet } = await import("./snippet.js");
  const c = (pos[0] ?? "generic") as (typeof SNIPPET_CLIENTS)[number];
  if (!SNIPPET_CLIENTS.includes(c)) {
    console.error(`usage: monomem snippet [${SNIPPET_CLIENTS.join("|")}]`);
    process.exit(1);
  }
  console.log(renderSnippet(c));
}
