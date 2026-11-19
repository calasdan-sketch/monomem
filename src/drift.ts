// `monomem drift`: do this project's notes still agree with the repository? Finds concrete claims in note text (file paths,
// ports, environment variables, package names, npm scripts and make targets, git branches) and checks each against the working
// tree, package.json and git. Free and local: no model, no network. A note that disagrees is listed with what is wrong.
//
// Conservative on purpose: a claim is only extracted when it is written in a form that names the repo ("src/old.ts", "port 3000",
// "npm run build", `MY_ENV_VAR`), and a path that is missing at its exact place still passes when a file with that ending exists
// somewhere in the tree (notes drop the leading folder). It cannot judge prose ("we deploy on Fridays"), a claim about another
// repository, or a variable that only a hosted service defines (well-known cloud prefixes are skipped).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { printable } from "./security.js";

export type ClaimKind = "file" | "port" | "env" | "package" | "script" | "make" | "branch";
export interface Claim {
  kind: ClaimKind;
  value: string;
}
export interface Disagreement {
  id: number;
  title: string;
  namespace: string;
  kind: ClaimKind;
  claim: string;
  problem: string;
}

const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|rb|php|sh|bash|ps1|yml|yaml|toml|ini|cfg|env|css|scss|html|sql|txt|lock|xml|gradle|c|h|cpp|cs|swift|vue|svelte";
const MAX_CLAIMS = 40;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "venv", ".venv", "__pycache__", "coverage", ".turbo", ".cache", "vendor"]);
const TEXT_EXT = new RegExp(`\\.(?:${CODE_EXT})$|(?:^|/)(?:Makefile|Dockerfile|\\.env[\\w.-]*)$`, "i");
const FILE_LIMIT = 20_000;
const TOTAL_TEXT = 24 * 1024 * 1024;
const ONE_FILE = 1024 * 1024;
// Variables a hosted service or the platform defines: a note naming one says nothing about this repository.
const EXTERNAL_ENV = /^(?:AWS_|AZURE_|GOOGLE_|GCP_|GITHUB_|GITLAB_|NODE_|NPM_|PYTHON|VIRTUAL_|LD_|XDG_|CLAUDE_|ANTHROPIC_|OPENAI_|HTTPS?_PROXY|NO_PROXY|CI_|RUNNER_|DOCKER_|KUBE|JAVA_|GOPATH|GOROOT|CARGO_|RUST_|TERM_|LC_|SSH_|USER_|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAM)/;
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** The claims written in `text`, at most MAX_CLAIMS, each once. Pure: no file or git access. */
export function extractClaims(text: string): Claim[] {
  const out = new Map<string, Claim>();
  const add = (kind: ClaimKind, value: string): void => {
    if (out.size < MAX_CLAIMS && value) out.set(`${kind}\0${value}`, { kind, value });
  };
  const t = text.replace(/\b(?:https?|ftp|ssh|git):\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");
  // files: a path with a folder and a known extension, or a backticked bare file name
  for (const m of t.matchAll(new RegExp(String.raw`(?<![\w/@.:~\\-])((?:\.{1,2}/)?(?:[\w@.-]+/)+[\w@.-]+\.(?:${CODE_EXT}))(?::\d+(?:-\d+)?)?(?![\w/-])`, "gi"))) {
    const p = m[1].replace(/^\.\//, "");
    const first = p.split("/")[0];
    if (/[*{}<>$]/.test(p) || p.startsWith("..") || /^[\w-]+(?:\.[\w-]+)+$/.test(first) && !first.startsWith(".")) continue; // glob, outside the repo, or a web address
    if (/^node_modules\//.test(p)) continue;
    add("file", p);
  }
  for (const m of t.matchAll(new RegExp("`([\\w.-]+\\.(?:" + CODE_EXT + "))`", "gi"))) add("file", m[1]);
  // ports
  const port = (s: string): void => {
    const n = Number(s);
    if (Number.isInteger(n) && n >= 80 && n <= 65535) add("port", String(n));
  };
  for (const m of t.matchAll(/\bport(?:\s+number)?\s*(?:is|=|:|on|to)?\s*[`'"]?(\d{2,5})\b/gi)) port(m[1]);
  for (const m of t.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi)) port(m[1]);
  // environment variables: backticked, or named as one
  for (const m of t.matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})`|\b(?:env(?:ironment)?\s+var(?:iable)?s?|set|export)\s+`?([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/g)) {
    const v = m[1] ?? m[2];
    if (!EXTERNAL_ENV.test(v)) add("env", v);
  }
  // packages: npm/pnpm/yarn/bun install|add <name> (not a global install), "depends on `x` package"
  for (const m of t.matchAll(/\b(?:npm|pnpm|yarn|bun)[ \t]+(?:install|add|i)[ \t]+((?:-{1,2}[\w=-]+[ \t]+)*)(@?[a-z0-9][\w./~-]*(?:@[\w.^~*<>=-]+)?)/gi)) {
    if (/(?:^|\s)(?:-g|--global)\b/.test(m[1])) continue;
    const n = m[2].replace(/(?<=[\w/])@[\w.^~*<>=-]+$/, ""); // lodash@4 is lodash
    if (NPM_NAME.test(n) && !/^(?:install|add|then|and|the|it|to|from|step|first|again|in|on|for|with|is|was)$/.test(n)) add("package", n);
  }
  for (const m of t.matchAll(/\b(?:depends\s+on|uses|requires|imports)\s+(?:the\s+)?`(@?[a-z0-9][\w./~-]*)`\s+(?:package|library|dependency|module)\b/gi)) if (NPM_NAME.test(m[1])) add("package", m[1]);
  // scripts and make targets
  for (const m of t.matchAll(/\b(?:npm|pnpm|yarn|bun)[ \t]+run[ \t]+([\w:.-]+)/gi)) add("script", m[1]);
  for (const m of t.matchAll(/\b(?:npm|pnpm|yarn|bun)[ \t]+(test|start|build|lint|dev|typecheck|format)\b/gi)) add("script", m[1].toLowerCase());
  for (const m of t.matchAll(/\bmake[ \t]+([a-z][\w.-]*)\b/g)) if (!/^(?:sure|sense|it|a|the|this|that|sure|changes|use|your|an)$/.test(m[1])) add("make", m[1]);
  // branches
  for (const m of t.matchAll(/\bbranch\s+[`'"]([\w./-]{1,60})[`'"]/gi)) add("branch", m[1]);
  return [...out.values()];
}

/** What the checks ask of the working tree. Built once per run; every lookup is lazy. */
export class RepoFacts {
  readonly files: string[] = []; // repository-relative, "/" separated
  private lowerSet: Set<string> | null = null;
  private corpus: string | null = null;
  private pkgs: Array<{ scripts: Record<string, unknown>; deps: Set<string> }> | null = null;
  private make: Set<string> | null | undefined;
  private termCache = new Map<string, boolean>();
  private gitCalls = 0;
  constructor(readonly root: string) {
    const walk = (dir: string, depth: number): void => {
      if (this.files.length >= FILE_LIMIT || depth > 12) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(full, depth + 1);
        } else this.files.push(relative(root, full).split(sep).join("/"));
      }
    };
    walk(root, 0);
  }

  /** The path exists, or a file whose path ends with it does (a note that left out the leading folder). */
  hasFile(rel: string): boolean {
    const p = rel.replace(/^\.\//, "");
    if (existsSync(join(this.root, p))) return true;
    this.lowerSet ??= new Set(this.files.map((f) => f.toLowerCase()));
    const lp = p.toLowerCase();
    if (this.lowerSet.has(lp)) return true;
    const tail = "/" + lp;
    return this.files.some((f) => ("/" + f.toLowerCase()).endsWith(tail));
  }

  private text(): string {
    if (this.corpus !== null) return this.corpus;
    let total = 0;
    const parts: string[] = [];
    for (const f of this.files) {
      if (!TEXT_EXT.test(f)) continue;
      try {
        const full = join(this.root, f);
        if (statSync(full).size > ONE_FILE) continue;
        const s = readFileSync(full, "utf8");
        total += s.length;
        if (total > TOTAL_TEXT) break;
        parts.push(s);
      } catch {
        /* unreadable: skipped */
      }
    }
    return (this.corpus = parts.join("\n"));
  }

  /** `term` appears as a whole word in some text file of the tree. */
  mentions(term: string): boolean {
    const hit = this.termCache.get(term);
    if (hit !== undefined) return hit;
    const re = new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
    const r = re.test(this.text());
    this.termCache.set(term, r);
    return r;
  }

  private packages(): Array<{ scripts: Record<string, unknown>; deps: Set<string> }> {
    if (this.pkgs) return this.pkgs;
    this.pkgs = [];
    for (const f of this.files.filter((x) => x === "package.json" || /^[^/]+\/package\.json$/.test(x) || /^[^/]+\/[^/]+\/package\.json$/.test(x)).slice(0, 40)) {
      try {
        const j = JSON.parse(readFileSync(join(this.root, f), "utf8")) as Record<string, unknown>;
        const deps = new Set<string>();
        for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const d = j[k];
          if (d && typeof d === "object") for (const n of Object.keys(d)) deps.add(n);
        }
        const scripts = j.scripts && typeof j.scripts === "object" ? (j.scripts as Record<string, unknown>) : {};
        this.pkgs.push({ scripts, deps });
      } catch {
        /* a package.json that does not parse: not used */
      }
    }
    return this.pkgs;
  }
  hasPackageJson(): boolean {
    return this.packages().length > 0;
  }
  hasDependency(name: string): boolean {
    return this.packages().some((p) => p.deps.has(name));
  }
  hasScript(name: string): boolean {
    return this.packages().some((p) => Object.hasOwn(p.scripts, name));
  }
  /** Targets of the root Makefile, or null when there is none. */
  makeTargets(): Set<string> | null {
    if (this.make !== undefined) return this.make;
    const f = ["Makefile", "makefile", "GNUmakefile"].find((n) => existsSync(join(this.root, n)));
    if (!f) return (this.make = null);
    const set = new Set<string>();
    for (const m of readFileSync(join(this.root, f), "utf8").matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)) set.add(m[1]);
    return (this.make = set);
  }

  private git(args: string[]): string | null {
    if (this.gitCalls++ > 60) return null;
    try {
      return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args], { cwd: this.root, encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  }
  /** true/false for a local or origin branch; null when this is not a git checkout. */
  hasBranch(name: string): boolean | null {
    if (this.git(["rev-parse", "--git-dir"]) === null) return null;
    return this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null || this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]) !== null;
  }
  /** Short hash of the newest commit that deleted `rel`, or "" when git knows of none. */
  removedIn(rel: string): string {
    return this.git(["log", "-1", "--diff-filter=D", "--format=%h", "--", rel]) ?? "";
  }
}

/** What is wrong with one claim ("" = it holds). */
export function checkClaim(c: Claim, f: RepoFacts): string {
  switch (c.kind) {
    case "file": {
      if (f.hasFile(c.value)) return "";
      const gone = f.removedIn(c.value);
      return `mentions ${printable(c.value, 100)} which no longer exists${gone ? ` (removed in commit ${gone})` : ""}`;
    }
    case "port":
      return f.mentions(c.value) ? "" : `says port ${c.value}, which appears nowhere in the repository's files`;
    case "env":
      return f.mentions(c.value) ? "" : `names the environment variable ${printable(c.value, 80)}, which nothing in the repository uses`;
    case "package":
      if (!f.hasPackageJson()) return "";
      return f.hasDependency(c.value) ? "" : `names the package ${printable(c.value, 80)}, which is not in package.json`;
    case "script":
      if (!f.hasPackageJson()) return `runs "npm run ${printable(c.value, 60)}" but the repository has no package.json`;
      return f.hasScript(c.value) ? "" : `runs the script "${printable(c.value, 60)}", which package.json does not have`;
    case "make": {
      const t = f.makeTargets();
      if (t === null) return ""; // no Makefile: "make sure ..." and friends are prose; not judged
      return t.has(c.value) ? "" : `runs "make ${printable(c.value, 60)}", which the Makefile does not have`;
    }
    case "branch": {
      const has = f.hasBranch(c.value);
      return has === false ? `names the branch ${printable(c.value, 60)}, which this repository does not have` : "";
    }
  }
}

/** Every disagreement between these notes and the repository, in note order. */
export function findDrift(notes: ReadonlyArray<{ id: number; title: string; body: string; namespace: string }>, facts: RepoFacts): { disagreements: Disagreement[]; claims: number } {
  const disagreements: Disagreement[] = [];
  let claims = 0;
  for (const n of notes) {
    for (const c of extractClaims(`${n.title}\n${n.body}`)) {
      claims++;
      const problem = checkClaim(c, facts);
      if (problem) disagreements.push({ id: n.id, title: printable(n.title, 80), namespace: n.namespace, kind: c.kind, claim: c.value, problem });
    }
  }
  return { disagreements, claims };
}
