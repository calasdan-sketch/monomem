// Supply-chain guards that run in CI: what `npm pack` would publish (an allowlist, no secrets, no machine paths, no
// internal docs) and what the workflows are allowed to do (every action pinned by SHA, provenance on, no broad token).
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";

function packedFiles(): string[] {
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const [cmd, pre] = existsSync(npmCli) ? [process.execPath, [npmCli]] : ["npm", []];
  const out = execFileSync(cmd, [...pre, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.ok(entry?.files, "unexpected npm pack --json shape");
  return entry.files.map((f) => f.path.replace(/\\/g, "/"));
}

const ALLOWED = [
  /^dist\/src\//, /^bench\/scenarios\/[^/]+\.json$/, /^docs\/[^/]+\.(md|png|gif|svg)$/, /^skills\/[^/]+\/SKILL\.md$/,
  /^(README|INSTALL|INFRA|SECURITY|THIRD_PARTY_NOTICES|SKILL|CHANGELOG)\.md$/, /^LICENSE$/, /^package\.json$/,
];
const FORBIDDEN_NAME = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|token|db|db-shm|db-wal|sqlite|log|map)|tokens\.json|id_rsa[^/]*|\.npmrc)$/i;
const INTERNAL_DOC = /(^|\/)(internal|plans)\/|RUNNER|LAUNCH|security-audit|redteam|adaptive-attacker|ROADMAP|COMPETITOR/i;
// A path from the build machine: a drive letter plus a Windows folder, or a Unix home folder of a person.
const MACHINE_PATH = /\bD:\\(?!a\\)[A-Za-z]|\\Users\\danie|\/Users\/danie|security-lab|new-repos|onememory-wt|lab3[\\/]|calas-vault|OneDrive\\Desktop/i;
const SECRET_SHAPE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{32,}|\bgh[pousr]_[A-Za-z0-9]{36,}|\bAKIA[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b/;

test("npm pack ships only allowlisted paths: no secret file names, no internal docs", () => {
  const files = packedFiles();
  assert.ok(files.length > 50, "sanity: the package has files");
  const unlisted = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
  const secretNames = files.filter((f) => FORBIDDEN_NAME.test(f));
  const internal = files.filter((f) => INTERNAL_DOC.test(f));
  assert.deepEqual(unlisted, [], `files outside the allowlist: ${unlisted.join(", ")}`);
  assert.deepEqual(secretNames, [], `secret-looking file names: ${secretNames.join(", ")}`);
  assert.deepEqual(internal, [], `internal docs in the tarball: ${internal.join(", ")}`);
});

test("no packed text file holds a build-machine path or a secret-shaped string", () => {
  const hits: string[] = [];
  for (const f of packedFiles().filter((x) => /\.(js|json|md|svg|mmd)$/.test(x))) {
    const text = readFileSync(join(PROJECT_ROOT, f), "utf8");
    if (MACHINE_PATH.test(text)) hits.push(`${f}: machine path`);
    // bench/scenarios hold deliberate fake keys (AWS's documented example key) that the redaction scenarios feed in
    if (!f.startsWith("bench/scenarios/") && SECRET_SHAPE.test(text)) hits.push(`${f}: secret-shaped string`);
  }
  assert.deepEqual(hits, []);
});

const WF_DIR = join(PROJECT_ROOT, ".github", "workflows");
const workflows = () => readdirSync(WF_DIR).filter((f) => f.endsWith(".yml")).map((f) => [f, readFileSync(join(WF_DIR, f), "utf8")] as const);

test("every workflow action is pinned to a full commit SHA", () => {
  const loose: string[] = [];
  for (const [name, text] of workflows()) {
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      const ref = m[1];
      if (ref.startsWith("./")) continue; // a workflow in this repository
      if (!/@[0-9a-f]{40}$/.test(ref)) loose.push(`${name}: ${ref}`);
    }
  }
  assert.deepEqual(loose, [], `unpinned actions: ${loose.join("; ")}`);
});

test("publish.yml: npm provenance on, no workflow-level id-token, audit signatures gate, release gets attestations", () => {
  const publish = readFileSync(join(WF_DIR, "publish.yml"), "utf8");
  const bundle = readFileSync(join(WF_DIR, "bundle.yml"), "utf8");
  assert.match(publish, /npm stage publish [^\n]*--provenance/);
  assert.match(publish, /npm audit signatures/);
  const topLevel = publish.match(/^permissions:\n((?:[ ]{2}\S.*\n)+)/m)?.[1] ?? "";
  assert.match(topLevel, /contents: read/);
  assert.doesNotMatch(topLevel, /id-token|write/, "the workflow-level token must stay read-only");
  assert.match(bundle, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(bundle, /make-sbom\.mjs/);
  assert.match(bundle, /sha256sum monomem-\* > SHA256SUMS/);
});

test("scorecard workflow, CODEOWNERS and dependabot are present", () => {
  assert.ok(existsSync(join(WF_DIR, "scorecard.yml")));
  assert.match(readFileSync(join(PROJECT_ROOT, ".github", "CODEOWNERS"), "utf8"), /^\*\s+@\S+/m);
  const dep = readFileSync(join(PROJECT_ROOT, ".github", "dependabot.yml"), "utf8");
  for (const eco of ["npm", "github-actions", "docker"]) assert.match(dep, new RegExp(`package-ecosystem: "${eco}"`));
});

test("make-sbom.mjs writes a CycloneDX file that lists every runtime package of the lockfile and no dev package", () => {
  const out = join(process.env.MONOMEM_HOME ?? PROJECT_ROOT, "sbom-test.cdx.json");
  execFileSync(process.execPath, [join(PROJECT_ROOT, "scripts", "make-sbom.mjs"), out], { cwd: PROJECT_ROOT, stdio: "ignore" });
  const bom = JSON.parse(readFileSync(out, "utf8")) as { bomFormat: string; metadata: { component: { name: string } }; components: { name: string; version: string }[] };
  const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, { dev?: boolean; version?: string }> };
  const runtime = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev).map(([k]) => k.split("node_modules/").pop());
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.metadata.component.name, "monomem");
  const names = new Set(bom.components.map((c) => c.name));
  for (const n of runtime) assert.ok(names.has(n as string), `SBOM lacks ${n}`);
  assert.ok(!names.has("typescript"), "a dev dependency leaked into the SBOM");
});
