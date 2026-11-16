// The standalone download (bundle mode: the official node + Monomem's code in one folder): its home on this computer, the
// Start menu / Applications entry setup adds, `monomem update` (checksum, rename-aside swap with rollback, offline-safe)
// and the no-command launch. Everything runs in temp folders with injected network and process calls.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as renameReal, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assetName, cleanupOld, isNewer, parseSums, runUpdate, swapIn, targetOf, type UpdateDeps } from "../src/update.js";
import { bundleRoot, copyToInstall, defaultCommand, installDir, samePath, shortcutPlan } from "../src/install.js";
import { DEFAULT_OPTIONS, readHistory, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const REPO = join(HERE, "..", "..");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), "mm-dist-"));
  roots.push(r);
  return r;
};
const put = (p: string, s: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
/** A fake unpacked Monomem folder: what update and setup look at (no real runtime needed). */
const fakeBundle = (root: string, version: string, platform: NodeJS.Platform = "linux"): string => {
  put(join(root, "runtime", platform === "win32" ? "node.exe" : "node"), `node for ${version}`);
  put(join(root, "dist", "src", "cli.js"), `// monomem ${version}`);
  put(join(root, "package.json"), JSON.stringify({ name: "monomem", version }));
  put(join(root, "docs", "a.md"), version);
  return root;
};

describe("names and versions", () => {
  test("download targets and archive names match the build script", async () => {
    assert.equal(targetOf("win32", "x64"), "win-x64");
    assert.equal(targetOf("darwin", "arm64"), "darwin-arm64");
    assert.equal(targetOf("linux", "x64"), "linux-x64");
    assert.equal(targetOf("linux", "arm64"), null);
    const build = (await import(pathToFileURL(join(REPO, "scripts", "build-bundle.mjs")).href)) as { archiveName(v: string, t: string): string; TARGETS: string[] };
    for (const t of build.TARGETS) assert.equal(assetName("1.6.0", t), build.archiveName("1.6.0", t));
    assert.equal(assetName("1.6.0", "win-x64"), "monomem-1.6.0-win-x64.zip");
    assert.equal(assetName("1.6.0", "linux-x64"), "monomem-1.6.0-linux-x64.tar.gz");
  });
  test("SHA256SUMS lines and version order", () => {
    const h = "a".repeat(64);
    const m = parseSums(`${h}  monomem-1.6.0-win-x64.zip\r\n${"B".repeat(64)} *monomem-1.6.0-linux-x64.tar.gz\nnot a line\n`);
    assert.equal(m.get("monomem-1.6.0-win-x64.zip"), h);
    assert.equal(m.get("monomem-1.6.0-linux-x64.tar.gz"), "b".repeat(64));
    assert.equal(m.size, 2);
    assert.ok(isNewer("1.6.0", "1.5.9") && isNewer("1.10.0", "1.9.0") && isNewer("v2.0.0", "1.99.99"));
    assert.ok(!isNewer("1.6.0", "1.6.0") && !isNewer("1.5.0", "1.6.0"));
    assert.ok(isNewer("1.6.0", "1.6.0-rc.1") && !isNewer("1.6.0-rc.1", "1.6.0"));
  });
});

describe("home folder and the app entry", () => {
  test("per user, no admin rights, one per platform", () => {
    assert.equal(installDir({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } }), join("C:\\Users\\a\\AppData\\Local", "Programs", "Monomem"));
    assert.equal(installDir({ platform: "darwin", home: "/Users/a", env: {} }), join("/Users/a", "Applications", "Monomem"));
    assert.equal(installDir({ platform: "linux", home: "/home/a", env: {} }), join("/home/a", ".local", "share", "monomem"));
    assert.equal(installDir({ platform: "linux", home: "/home/a", env: { XDG_DATA_HOME: "/data" } }), join("/data", "monomem"));
    assert.equal(bundleRoot(join("/x", "Monomem", "dist", "src", "cli.js")), resolve("/x", "Monomem"));
  });
  test("the entry opens the dashboard through the installed runtime", () => {
    const lin = shortcutPlan({ platform: "linux", home: "/home/a", env: {} }, "/home/a/.local/share/monomem");
    assert.equal(lin.file, join("/home/a", ".local", "share", "applications", "monomem.desktop"));
    assert.match(lin.text!, /^Exec=".*runtime[\\/]+node" ".*cli\.js" open$/m);
    assert.match(lin.text!, /^Terminal=false$/m);
    const mac = shortcutPlan({ platform: "darwin", home: "/Users/a", env: {} }, "/Users/a/Applications/Monomem");
    assert.equal(mac.createdDir, join("/Users/a", "Applications", "Monomem.app"));
    assert.match(mac.text!, /^#!\/bin\/sh\nexec ".*runtime[\\/]+node" ".*cli\.js" open\n$/);
    const win = shortcutPlan({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }, "C:\\Users\\a\\AppData\\Local\\Programs\\Monomem");
    assert.match(win.file, /Start Menu[\\/]Programs[\\/]Monomem\.lnk$/);
    assert.match(win.lnk!.target, /runtime[\\/]node\.exe$/);
    assert.match(win.lnk!.args, /^".*cli\.js" open$/);
  });
  test("samePath ignores case on Windows and macOS only", () => {
    assert.ok(samePath("C:\\A\\b", "c:\\a\\B\\", "win32"));
    assert.ok(!samePath("/a/B", "/a/b", "linux"));
  });
});

const makeIO = (answers: string[] = []): SetupIO & { all: () => string } => {
  const lines: string[] = [];
  return { interactive: true, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => answers.shift() ?? "", all: () => lines.join("\n") };
};

describe("setup from the unpacked download", () => {
  const sandbox = () => {
    const root = scratch();
    const home = join(root, "home");
    const dl = fakeBundle(join(root, "Downloads", "Monomem"), "1.7.0");
    put(join(home, ".claude.json"), "{}\n");
    const e: SetupEnv = {
      home,
      platform: "linux",
      env: { HOME: home, MONOMEM_HOME: join(root, "data") },
      cwd: root,
      nodeVersion: "26.13.1",
      execPath: join(dl, "runtime", "node"),
      cliPath: join(dl, "dist", "src", "cli.js"),
      mode: "bundle",
      version: "1.7.0",
      now: () => new Date("2026-11-16T12:00:00Z"),
    };
    return { root, home, dl, e, inst: join(home, ".local", "share", "monomem"), entry: join(home, ".local", "share", "applications", "monomem.desktop") };
  };
  const o = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, hook: "no" as const, capture: "no" as const };

  test("dry run: lists the copy home and the menu entry, and the settings already name the home", async () => {
    const s = sandbox();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, { ...o, dryRun: true }), 0);
    const out = io.all();
    assert.match(out, /Copy Monomem from .*Downloads.* to .*share.monomem/);
    assert.match(out, /Add a "Monomem" entry to the applications menu/);
    assert.match(out, /Built-in runtime \(Node 26\.13\.1\): OK/);
    assert.ok(out.includes(JSON.stringify(join(s.inst, "runtime", "node")).slice(1, -1)), "the diff names the installed runtime");
    assert.ok(!out.replace(/Copy Monomem from [^\n]*/, "").includes("Downloads"), "nothing but the copy step names the download folder");
    assert.ok(!existsSync(s.inst) && !existsSync(s.entry), "a dry run changes nothing");
  });

  test("for real: copies home, writes settings naming the home, adds the entry; --undo removes the entry", async () => {
    const s = sandbox();
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    assert.ok(existsSync(join(s.inst, "runtime", "node")) && existsSync(join(s.inst, "dist", "src", "cli.js")));
    const cc = JSON.parse(readFileSync(join(s.home, ".claude.json"), "utf8"));
    assert.equal(cc.mcpServers.monomem.command, join(s.inst, "runtime", "node"));
    assert.deepEqual(cc.mcpServers.monomem.args, [join(s.inst, "dist", "src", "cli.js"), "mcp"]);
    assert.match(readFileSync(s.entry, "utf8"), /open$/m);
    assert.ok(readHistory(s.e).at(-1)!.changes.some((c) => c.client === "shortcut" && c.file === s.entry));
    const undo = makeIO();
    assert.equal(await runSetup(s.e, undo, { ...o, undo: true }), 0);
    assert.ok(!existsSync(s.entry), undo.all());
  });

  test("macOS: undo removes the whole Monomem.app it created", async () => {
    const s = sandbox();
    const e = { ...s.e, platform: "darwin" as const };
    assert.equal(await runSetup(e, makeIO(["y"]), o), 0);
    const app = join(s.home, "Applications", "Monomem.app");
    assert.ok(existsSync(join(app, "Contents", "Info.plist")) && existsSync(join(app, "Contents", "MacOS", "Monomem")));
    assert.equal(await runSetup(e, makeIO(), { ...o, undo: true }), 0);
    assert.ok(!existsSync(app));
  });

  test("run again from the installed copy: no second copy, no second entry", async () => {
    const s = sandbox();
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    const io = makeIO();
    const e2 = { ...s.e, execPath: join(s.inst, "runtime", "node"), cliPath: join(s.inst, "dist", "src", "cli.js") };
    assert.equal(await runSetup(e2, io, { ...o, dryRun: true }), 0);
    assert.doesNotMatch(io.all(), /Copy Monomem|Add a "Monomem" entry/);
  });

  test("an older copy at home is replaced (rename-aside), not merged", () => {
    const root = scratch();
    const home = fakeBundle(join(root, "home"), "1.6.0");
    put(join(home, "docs", "gone.md"), "old only");
    copyToInstall(fakeBundle(join(root, "dl"), "1.7.0"), home);
    assert.equal(readFileSync(join(home, "dist", "src", "cli.js"), "utf8"), "// monomem 1.7.0");
    assert.ok(!existsSync(join(home, "docs", "gone.md")));
    assert.ok(!readdirSync(home).some((n) => n.startsWith(".update-")));
  });
});

describe("rename-aside swap", () => {
  test("moves every entry in and the old ones aside", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0");
    swapIn(root, staged, join(root, ".old-1.6.0"));
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), JSON.stringify({ name: "monomem", version: "1.7.0" }));
    assert.equal(readFileSync(join(root, ".old-1.6.0", "runtime", "node"), "utf8"), "node for 1.6.0");
  });
  test("a failure half way puts every file back", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const before = readFileSync(join(root, "dist", "src", "cli.js"), "utf8");
    const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0");
    let n = 0;
    const flaky = (a: string, b: string): void => {
      if (++n === 4) throw Object.assign(new Error("disk said no"), { code: "EIO" });
      renameReal(a, b);
    };
    assert.throws(() => swapIn(root, staged, join(root, ".old-1.6.0"), flaky), /disk said no/);
    assert.equal(readFileSync(join(root, "dist", "src", "cli.js"), "utf8"), before);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    assert.equal(readFileSync(join(staged, "runtime", "node"), "utf8"), "node for 1.7.0");
  });
  test("Windows: works while the folder's node.exe is running (it is renamed, never overwritten)", { skip: process.platform !== "win32" }, async () => {
    const root = scratch();
    fakeBundle(root, "1.6.0", "win32");
    copyFileSync(process.execPath, join(root, "runtime", "node.exe"));
    const child = spawn(join(root, "runtime", "node.exe"), ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0", "win32");
      swapIn(root, staged, join(root, ".old-1.6.0"));
      assert.equal(readFileSync(join(root, "runtime", "node.exe"), "utf8"), "node for 1.7.0");
      assert.ok(existsSync(join(root, ".old-1.6.0", "runtime", "node.exe")));
    } finally {
      const gone = new Promise((r) => child.once("exit", r));
      child.kill();
      await gone;
    }
  });
  test("cleanupOld removes earlier leftovers only", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    put(join(root, ".old-1.5.0", "x"), "x");
    put(join(root, ".update-1.6.0", "y"), "y");
    cleanupOld(root);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".")), []);
    assert.ok(existsSync(join(root, "runtime", "node")));
  });
});

describe("monomem update", () => {
  const ARCHIVE = Buffer.from("pretend this is a tar.gz");
  const sha = createHash("sha256").update(ARCHIVE).digest("hex");
  const release = (sums = `${sha}  monomem-1.7.0-linux-x64.tar.gz\n`) => ({
    tag_name: "v1.7.0",
    assets: [
      { name: "monomem-1.7.0-linux-x64.tar.gz", browser_download_url: "https://dl/archive" },
      { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
    ],
    sums,
  });
  const deps = (root: string, rel: ReturnType<typeof release> | null, over: Partial<UpdateDeps> = {}) => {
    const lines: string[] = [];
    const runs: string[][] = [];
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (!rel) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
      if (u.includes("/releases/latest")) return new Response(JSON.stringify(rel));
      if (u === "https://dl/sums") return new Response(rel.sums);
      if (u === "https://dl/archive") return new Response(ARCHIVE);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const d: UpdateDeps = {
      mode: "bundle",
      root,
      version: "1.6.0",
      platform: "linux",
      arch: "x64",
      env: {},
      fetch: fakeFetch,
      out: (l) => void lines.push(l),
      err: (l) => void lines.push(l),
      unpack: (_a, into) => void fakeBundle(join(into, "Monomem"), "1.7.0"),
      run: (cmd, args) => {
        runs.push([cmd, ...args]);
        return { status: 0, stdout: args.includes("--version") ? readFileSync(cmd, "utf8").replace("node for ", "") + "\n" : "" };
      },
      ...over,
    };
    return { d, lines, runs, all: () => lines.join("\n") };
  };

  test("downloads, checks the SHA-256, swaps in place, then the new copy finishes (migration + service)", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release());
    assert.equal(await runUpdate({ check: false }, t.d), 0, t.all());
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.7.0");
    assert.match(t.all(), new RegExp(`SHA-256 checked: ${sha}`));
    const fin = t.runs.at(-1)!;
    assert.deepEqual(fin, [join(root, "runtime", "node"), join(root, "dist", "src", "cli.js"), "update", "--finish", "1.6.0"]);
    assert.ok(!existsSync(join(root, ".update-1.7.0")), "the download is cleaned up");
  });

  test("a checksum mismatch changes nothing and says so", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release(`${"0".repeat(64)}  monomem-1.7.0-linux-x64.tar.gz\n`));
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /does not match its checksum.*Nothing was changed/s);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    assert.ok(!existsSync(join(root, ".update-1.7.0")));
  });

  test("offline: a clear error, exit 1, nothing changed", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, null);
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /Could not reach github\.com to look for an update \(fetch failed.*\)\. Nothing was changed/);
  });

  test("a new copy that does not start is never swapped in", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release(), { run: () => ({ status: 1, stdout: "" }) });
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /did not start properly/);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
  });

  test("--check only asks; up to date says so; npm installs get the npm command", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const c = deps(root, release());
    assert.equal(await runUpdate({ check: true }, c.d), 0);
    assert.match(c.all(), /Monomem 1\.7\.0 is out \(you have 1\.6\.0\)/);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    const same = deps(root, release(), { version: "1.7.0" });
    assert.equal(await runUpdate({ check: false }, same.d), 0);
    assert.match(same.all(), /1\.7\.0 is the newest version/);
    const npm = deps(root, null, { mode: "npm" });
    assert.equal(await runUpdate({ check: false }, npm.d), 0);
    assert.match(npm.all(), /npm i -g monomem@latest/);
  });

  test("the CLI knows `update` and never runs it from a hook", () => {
    const r = spawnSync(process.execPath, [CLI, "update", "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: monomem update \[--check\]/);
    const hookSrc = readFileSync(join(REPO, "src", "hook.ts"), "utf8") + readFileSync(join(REPO, "src", "recall.ts"), "utf8");
    assert.doesNotMatch(hookSrc, /update\.js|runUpdate/);
  });
});

describe("no command", () => {
  test("a terminal gets the help; a launch with no terminal (Start menu, Explorer, Finder) opens the dashboard", () => {
    assert.equal(defaultCommand(true, true), "help");
    assert.equal(defaultCommand(false, false), "open");
    assert.equal(defaultCommand(true, false), "open");
    // The CLI uses it (cli.ts runs main() on import, so it is checked in the source, not spawned: open would start a server).
    assert.match(readFileSync(join(REPO, "src", "cli.ts"), "utf8"), /process\.argv\[2\] \|\| \(await import\("\.\/install\.js"\)\)\.defaultCommand\(/);
  });
});
