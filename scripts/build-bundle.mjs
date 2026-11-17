#!/usr/bin/env node
// Build the standalone Monomem download: one folder (and one archive) per platform, holding
//   runtime/node, runtime/monomem-node.exe   the OFFICIAL Node build from nodejs.org, checked against SHASUMS256, bytes
//                        untouched; on Windows only its file name changes (the Authenticode signature does not cover it)
//   dist/monomem.ico|.icns|.png   the app icon (docs/brand/favicon-64.png) for the Start menu / Applications / menu entry
//   dist/src/cli.js      Monomem's code (one esbuild file by default; --js files copies the tsc output + node_modules)
//   package.json, docs, LICENSE, ...   the same files the npm package carries
//   monomem.cmd / monomem   a small launcher at the folder's root (the folder is the stable install path)
// No Node install is needed on the user's computer, and nothing in the folder is an unsigned executable: Windows Smart App
// Control blocks unsigned exes with no override, while the signed node.exe runs. src/self.ts sees a node inside the
// package folder and switches to "bundle" mode (hooks and app settings name that node by its absolute path).
//
//   node scripts/build-bundle.mjs [--target win-x64|darwin-arm64|darwin-x64|linux-x64] [--node 26.13.1]
//                                 [--out build/bundle] [--js bundle|files] [--no-archive]
// Run `npm run build` first (dist/ must exist). Output: <out>/<target>/Monomem/ and <out>/monomem-<ver>-<target>.zip|.tar.gz
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Node LTS embedded in the download. Bump deliberately: node:sqlite (and its FTS5) comes from this build. */
export const NODE_VERSION = "26.13.1";
export const TARGETS = ["win-x64", "darwin-arm64", "darwin-x64", "linux-x64"];
/** The Windows runtime's file name (src/self.ts BUNDLED_NODE_WIN): Task Manager's Details tab shows it. */
export const WIN_NODE = "monomem-node.exe";

/** The target of the machine running this script (win32 -> win). */
export function hostTarget(platform = process.platform, arch = process.arch) {
  return `${platform === "win32" ? "win" : platform}-${arch}`;
}

/** The release archive name; src/update.ts looks for exactly this name. */
export function archiveName(version, target) {
  return `monomem-${version}-${target}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Windows ships bsdtar (reads and writes zip); Git for Windows puts a GNU tar earlier on PATH that cannot. */
function tarBin() {
  return process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

function parseArgs(argv) {
  const o = { target: hostTarget(), node: NODE_VERSION, out: join(ROOT, "build", "bundle"), js: "bundle", archive: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") o.target = argv[++i];
    else if (a === "--node") o.node = argv[++i];
    else if (a === "--out") o.out = resolve(argv[++i]);
    else if (a === "--js") o.js = argv[++i];
    else if (a === "--no-archive") o.archive = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!TARGETS.includes(o.target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  if (o.js !== "bundle" && o.js !== "files") throw new Error("--js must be bundle or files");
  return o;
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** The official Node archive for this target, downloaded once into build/node-cache and checked against SHASUMS256.txt. */
async function officialNode(version, target, cacheDir) {
  const base = `node-v${version}-${target}`;
  const name = `${base}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
  const dir = join(cacheDir, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const sums = join(dir, "SHASUMS256.txt");
  if (!existsSync(sums)) await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, sums);
  const line = readFileSync(sums, "utf8").split("\n").find((l) => l.trim().endsWith(`  ${name}`));
  if (!line) throw new Error(`${name} is not listed in nodejs.org's SHASUMS256.txt for v${version}`);
  const want = line.trim().split(/\s+/)[0];
  const file = join(dir, name);
  if (!existsSync(file) || sha256(file) !== want) await download(`https://nodejs.org/dist/v${version}/${name}`, file);
  const got = sha256(file);
  if (got !== want) throw new Error(`${name}: SHA-256 ${got} does not match nodejs.org's ${want}; refusing to use it`);
  console.log(`node: ${name} matches nodejs.org SHASUMS256 (${want})`);
  return { file, base, want };
}

/** Pull node(.exe) and Node's LICENSE out of the official archive into <app>/runtime. */
function placeRuntime(archive, base, target, app) {
  const tmp = join(dirname(app), "node-extract");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const bin = target.startsWith("win-") ? `${base}/node.exe` : `${base}/bin/node`;
  execFileSync(tarBin(), ["-xf", archive, "-C", tmp, bin, `${base}/LICENSE`], { stdio: "inherit" });
  const rt = join(app, "runtime");
  mkdirSync(rt, { recursive: true });
  const exe = join(rt, target.startsWith("win-") ? WIN_NODE : "node");
  copyFileSync(join(tmp, bin), exe);
  chmodSync(exe, 0o755);
  copyFileSync(join(tmp, base, "LICENSE"), join(rt, "LICENSE"));
  rmSync(tmp, { recursive: true, force: true });
}

/** The tsc output the npm package ships (package.json "files": no runner, no competitor bench). */
function copyDist(app) {
  const src = join(ROOT, "dist", "src");
  if (!existsSync(join(src, "cli.js"))) throw new Error("dist/src/cli.js is missing: run npm run build first");
  cpSync(src, join(app, "dist", "src"), {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p).replace(/\\/g, "/");
      return !/^runner/.test(rel) && !rel.startsWith("bench/competitors") && !rel.endsWith(".d.ts") && !rel.endsWith(".map");
    },
  });
}

/**
 * All of Monomem's code and dependencies in one ESM file (dist/src/monomem-bundle.js), started by a two-line dist/src/cli.js
 * that turns on Node's compile cache first: measured on Windows, the session-start hook goes from ~150 ms (tsc files or a
 * bundle alone) to ~130 ms, and the zip shrinks by ~6 MB. self.ts finds the package root two folders up, as in npm.
 */
async function bundleJs(app, version) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error("esbuild is not installed (npm ci installs it as a devDependency), or build with --js files");
  }
  const out = join(app, "dist", "src", "monomem-bundle.js");
  await esbuild.build({
    entryPoints: [join(ROOT, "dist", "src", "cli.js")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    legalComments: "none",
    // CommonJS dependencies inside an ESM file still call require(); give them one.
    banner: { js: "import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);" },
    define: { __MONOMEM_VERSION__: JSON.stringify(version) },
  });
  writeFileSync(
    join(app, "dist", "src", "cli.js"),
    [
      "// Standalone download entry: cache compiled code (Node's default: the OS temp folder), then run the bundled Monomem.",
      'import { enableCompileCache } from "node:module";',
      "enableCompileCache?.();",
      'await import("./monomem-bundle.js");',
      "",
    ].join("\n")
  );
}

/** Production dependencies for the --js files layout, from the lockfile. */
function installDeps(app) {
  copyFileSync(join(ROOT, "package-lock.json"), join(app, "package-lock.json"));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });
  rmSync(join(app, "package-lock.json"), { force: true });
}

/** package.json, docs and licences: the files the npm package carries (minus the code, placed above). */
function copyDocs(app, version) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // Keep only what the running code reads (name, version, type) plus provenance fields; no scripts, no dev tooling.
  const slim = { name: pkg.name, version, description: pkg.description, license: pkg.license, author: pkg.author, repository: pkg.repository, homepage: pkg.homepage, type: pkg.type, dependencies: pkg.dependencies, overrides: pkg.overrides };
  writeFileSync(join(app, "package.json"), JSON.stringify(slim, null, 2) + "\n");
  for (const f of ["README.md", "INSTALL.md", "INFRA.md", "SECURITY.md", "SKILL.md", "LICENSE", "CHANGELOG.md"]) copyFileSync(join(ROOT, f), join(app, f));
  mkdirSync(join(app, "docs"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "docs"))) if (f.endsWith(".md") && f !== "RUNNER.md") copyFileSync(join(ROOT, "docs", f), join(app, "docs", f));
  for (const s of readdirSync(join(ROOT, "skills"))) {
    const f = join(ROOT, "skills", s, "SKILL.md");
    if (existsSync(f)) {
      mkdirSync(join(app, "skills", s), { recursive: true });
      copyFileSync(f, join(app, "skills", s, "SKILL.md"));
    }
  }
  cpSync(join(ROOT, "bench", "scenarios"), join(app, "bench", "scenarios"), { recursive: true, filter: (p) => statSync(p).isDirectory() || p.endsWith(".json") });
}

/** A Windows .ico holding one PNG image unchanged (PNG entries are read by Windows Vista and later). */
export function icoFromPng(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = w >= 256 ? 0 : w;
  head[7] = h >= 256 ? 0 : h;
  head.writeUInt16LE(1, 10); // colour planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // image offset
  return Buffer.concat([head, png]);
}

/** A macOS .icns holding one 64x64 PNG ("icp6") unchanged. */
export function icnsFromPng(png) {
  const head = Buffer.alloc(16);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(16 + png.length, 4);
  head.write("icp6", 8, "latin1");
  head.writeUInt32BE(8 + png.length, 12);
  return Buffer.concat([head, png]);
}

/** The icon the app entry shows, in this target's format. */
function placeIcon(app, target) {
  const png = readFileSync(join(ROOT, "docs", "brand", "favicon-64.png"));
  const dist = join(app, "dist");
  if (target.startsWith("win-")) writeFileSync(join(dist, "monomem.ico"), icoFromPng(png));
  else if (target.startsWith("darwin-")) writeFileSync(join(dist, "monomem.icns"), icnsFromPng(png));
  else writeFileSync(join(dist, "monomem.png"), png);
}

/** The launcher for this target, from installer/. */
function placeLauncher(app, target) {
  if (target.startsWith("win-")) copyFileSync(join(ROOT, "installer", "monomem.cmd"), join(app, "monomem.cmd"));
  else {
    const f = join(app, "monomem");
    copyFileSync(join(ROOT, "installer", "monomem.sh"), f);
    chmodSync(f, 0o755);
  }
}

function folderBytes(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? folderBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+/.test(version) || version === "0.0.0") throw new Error(`package.json version ${version} is not a release version`);
  const work = join(o.out, o.target);
  const app = join(work, "Monomem");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });

  const node = await officialNode(o.node, o.target, join(ROOT, "build", "node-cache"));
  placeRuntime(node.file, node.base, o.target, app);
  copyDocs(app, version);
  if (o.js === "bundle") await bundleJs(app, version);
  else {
    copyDist(app);
    installDeps(app);
  }
  placeLauncher(app, o.target);
  placeIcon(app, o.target);
  writeFileSync(join(app, "runtime", "SOURCE.txt"), `Official Node.js v${o.node} (${node.base}) from https://nodejs.org/dist/v${o.node}/, unmodified.\nSHA-256 of the nodejs.org archive: ${node.want}\n`);
  console.log(`folder: ${app} (${(folderBytes(app) / 1e6).toFixed(1)} MB)`);

  if (o.archive) {
    const name = archiveName(version, o.target);
    const file = join(o.out, name);
    rmSync(file, { force: true });
    // bsdtar picks zip from the .zip name (-a); the tar.gz keeps the launcher's and node's executable bits.
    // zip at deflate level 9: measured 40.21 -> 40.05 MB on 1.6.0 (node.exe is 38.7 MB of it, and cannot shrink).
    const args = o.target.startsWith("win-") ? ["-a", "-cf", file, "--options", "zip:compression-level=9", "-C", work, "Monomem"] : ["-czf", file, "-C", work, "Monomem"];
    execFileSync(o.target.startsWith("win-") ? tarBin() : "tar", args, { stdio: "inherit" });
    console.log(`archive: ${file} (${(statSync(file).size / 1e6).toFixed(1)} MB) sha256 ${sha256(file)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-bundle: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
