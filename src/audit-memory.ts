// `monomem audit-memory [path...]`: look through the files other AI tools read as standing instructions (CLAUDE.md, AGENTS.md,
// GEMINI.md, Cursor and Windsurf rules, Copilot instructions ...) for passwords, keys and text that tries to give an AI orders.
// Read-only: it never changes a file. It uses the same secret check and injection check every Monomem write goes through
// (lint.ts), line by line so a finding has a place, and a secret is never printed in full: the first four characters and a length.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { lintBatch, lintContent } from "./lint.js";
import { SECRET_PATTERNS, secretAssignments, printable } from "./security.js";
import { INVISIBLE_RE } from "./context-inject.js";

export type MemoryFindingKind = "secret" | "possible-secret" | "injection" | "hidden-characters";
export interface MemoryFinding {
  file: string;
  /** 1-based; null when only the file as a whole reads like an instruction (split over several lines). */
  line: number | null;
  kind: MemoryFindingKind;
  label: string;
  /** The line with every secret masked. Never the secret. */
  excerpt: string;
}

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 300;
const NAMES = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", ".cursorrules", ".windsurfrules", ".clinerules", "conventions.md", "copilot-instructions.md", "agent.md"]);
const RULE_DIRS = /(?:^|\/)\.(?:cursor|windsurf|roo|continue|clinerules)\/rules?\/[^/]+$|(?:^|\/)\.claude\/(?:rules|commands|agents|skills)\/.+\.md$|(?:^|\/)\.github\/instructions\/[^/]+\.md$|(?:^|\/)\.(?:codex|gemini|claude)\/[^/]+\.md$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", "venv", ".venv", "__pycache__", "coverage", ".next"]);
const norm = (p: string): string => p.replace(/\\/g, "/");

/** Memory files at known places under a home folder (not a recursive walk of the whole home). */
function homeFiles(home: string): string[] {
  const out: string[] = [];
  for (const rel of [".claude/CLAUDE.md", ".gemini/GEMINI.md", ".codex/AGENTS.md", ".cursorrules", "AGENTS.md", "CLAUDE.md"]) {
    const p = join(home, rel);
    try {
      const st = lstatSync(p); // a link or junction is skipped: it could point anywhere
      if (st.isFile() && !st.isSymbolicLink()) out.push(p);
    } catch {
      /* not there */
    }
  }
  for (const rel of [".claude/rules", ".cursor/rules"]) {
    try {
      for (const n of readdirSync(join(home, rel))) {
        if (!/\.(?:md|mdc|txt)$/i.test(n)) continue;
        try {
          if (lstatSync(join(home, rel, n)).isFile()) out.push(join(home, rel, n));
        } catch {
          /* gone */
        }
      }
    } catch {
      /* no such folder */
    }
  }
  return out;
}

/** The memory files under `dir` (depth at most 6). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const full = join(d, n);
      let st;
      try {
        st = lstatSync(full); // a link or junction is never followed or read
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP.has(n)) walk(full, depth + 1);
      } else if (NAMES.has(n.toLowerCase()) || RULE_DIRS.test(norm(full))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** What to scan for each argument: a file as given; a folder's memory files (a home folder: the known places in it). */
export function memoryFiles(targets: string[]): { files: string[]; missing: string[]; skipped: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  const skipped: string[] = [];
  const home = resolve(homedir());
  for (const t of targets) {
    const p = resolve(t);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      missing.push(t);
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.push(t); // a link or junction (it could point at any file on the disk) is not followed
      continue;
    }
    if (st.isFile()) files.add(p);
    else for (const f of p === home ? homeFiles(p) : walkFiles(p)) files.add(f);
  }
  return { files: [...files].slice(0, MAX_FILES), missing, skipped };
}

/** A secret is never shown whole: under 12 characters only its length (four letters would be a third of it), else the first four and the length. */
const mask = (s: string): string => (s.length < 12 ? `(${s.length} characters)` : `${s.slice(0, 4)}…(${s.length} characters)`);

const PHRASE_MAX_LINE = 2000; // a longer line is not tested (the pattern is bounded per match, but a huge line could hold very many)
/** "password = correct horse battery": a password, pw or pass assignment whose value has spaces (a pass phrase), so no token shape fits. */
const PHRASE_ASSIGN = /\b(?:(?:password|passwd|passphrase|pwd|pw)\s*[:=]|pass\s*=)\s*(?!<|\$|\{|%|your\b|the\b|example\b|none\b|n\/a\b|required\b|optional\b|redacted\b|see\b|ask\b|stored\b|in\b|from\b|set\b|changeme\b)([^\s'"`][^\n]{0,160}?\s+[^\s'"`][^\n]{0,160}?)\s*$/i;

/** `line` with every secret in it hidden. Known key shapes, "password: value" assignments, then any long mixed token. */
export function maskSecrets(line: string): string {
  let t = line.length <= PHRASE_MAX_LINE ? line.replace(PHRASE_ASSIGN, (m, v: string) => m.replace(v, mask(v))) : line;
  for (const [, re] of SECRET_PATTERNS) t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), (m) => mask(m));
  const spans = secretAssignments(t, 20).sort((a, b) => b.index - a.index);
  for (const s of spans) t = t.slice(0, s.index) + t.slice(s.index, s.index + s.length).replace(/[^\s:="'`]{6,}$/, (v) => mask(v)) + t.slice(s.index + s.length);
  // a value after "password:" is the tail of the span; anything key-shaped left (sk-..., eyJ..., a URL password, hex) goes too
  t = t.replace(/\b[a-z][a-z0-9+.-]{0,20}:\/\/([^\s/:@]{0,64}):([^\s/@]{1,128})@/gi, (m, u: string, p: string) => m.replace(`:${p}@`, `:${mask(p)}@`));
  t = t.replace(/[A-Za-z0-9+/_=~-]{16,}/g, (tok) => (/[A-Za-z]/.test(tok) && /[0-9]/.test(tok) && !tok.includes("…") ? mask(tok) : /^(?:sk|eyJ|ghp_|gho_|xox)/.test(tok) ? mask(tok) : tok));
  return printable(t.replace(INVISIBLE_RE, "?").replace(/\s+/g, " ").trim(), 140);
}

/** The findings in one file's text. `file` is only the label. */
export function scanMemoryText(file: string, text: string): MemoryFinding[] {
  const out: MemoryFinding[] = [];
  const lines = text.split(/\r?\n/);
  let lineInjection = false;
  lintBatch(() => {
    lines.forEach((raw, i) => {
      if (!raw.trim()) return;
      if (INVISIBLE_RE.test(raw.replace(/[\t\u0009\u000b\u000c]/g, ""))) {
        INVISIBLE_RE.lastIndex = 0;
        out.push({ file, line: i + 1, kind: "hidden-characters", label: "hidden or control characters", excerpt: maskSecrets(raw) });
      }
      INVISIBLE_RE.lastIndex = 0;
      const found = lintContent({ body: raw });
      if (raw.length <= PHRASE_MAX_LINE && PHRASE_ASSIGN.test(raw) && !found.some((f) => f.category === "secret")) found.push({ category: "secret", label: "password with spaces", field: "body" });
      for (const f of found) {
        if (f.category === "secret") out.push({ file, line: i + 1, kind: "secret", label: f.label, excerpt: maskSecrets(raw) });
        else if (f.category === "entropy") out.push({ file, line: i + 1, kind: "possible-secret", label: f.label, excerpt: maskSecrets(raw) });
        else if (f.category === "injection") {
          lineInjection = true;
          out.push({ file, line: i + 1, kind: "injection", label: f.label, excerpt: maskSecrets(raw) });
        }
      }
    });
    // an instruction split over lines ("ignore previous" / "instructions ...") only reads as one when the file is read whole
    if (!lineInjection) {
      for (const f of lintContent({ body: text.slice(0, MAX_BYTES) })) {
        if (f.category === "injection") out.push({ file, line: null, kind: "injection", label: f.label, excerpt: "(spread over several lines)" });
      }
    }
  });
  return out;
}

export function auditMemory(targets: string[]): { files: string[]; missing: string[]; findings: MemoryFinding[]; unreadable: string[]; skipped: string[] } {
  const { files, missing, skipped } = memoryFiles(targets);
  const findings: MemoryFinding[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      const st = lstatSync(f); // checked again at read time: a file swapped for a link after it was listed is not read
      if (st.isSymbolicLink()) {
        skipped.push(f);
        continue;
      }
      if (st.size > MAX_BYTES) {
        unreadable.push(`${f} (over 1 MB)`);
        continue;
      }
      findings.push(...scanMemoryText(f, readFileSync(f, "utf8")));
    } catch {
      unreadable.push(f);
    }
  }
  return { files: files.filter((f) => !skipped.includes(f)), missing, findings, unreadable, skipped };
}

/** The label a person sees for a file: its name with the folder above it. */
export const shortName = (f: string): string => `${basename(join(f, ".."))}/${basename(f)}`;
