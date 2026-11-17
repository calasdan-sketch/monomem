// f5/download: the no-Node download should feel like an ordinary app without code signing.
//   - the bundled runtime is runtime\monomem-node.exe on Windows (Node's signed node.exe, renamed: the signature does not
//     cover the file name), and every launcher, the update and the smoke test use that name; update still accepts a
//     folder whose runtime is called node.exe
//   - the Start menu / Applications / menu entry carries the Monomem icon (built from docs/brand/favicon-64.png)
//   - setup's copy into the home folder drops Windows' download mark, as an installer's files have none
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLED_NODE_WIN, bundledNode } from "../src/self.js";
import { copyToInstall, createShortcut, shortcutPlan } from "../src/install.js";
import { runUpdate, type UpdateDeps } from "../src/update.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), "mm-feel-"));
  roots.push(r);
  return r;
};
const put = (p: string, s: string | Buffer): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const text = (...p: string[]): string => readFileSync(join(REPO, ...p), "utf8");

describe("the bundled runtime's name", () => {
  test("Windows: monomem-node.exe; macOS and Linux keep runtime/node", () => {
    assert.equal(BUNDLED_NODE_WIN, "monomem-node.exe");
    assert.equal(bundledNode("C:\\M", "win32", () => false), join("C:\\M", "runtime", "monomem-node.exe"));
    assert.equal(bundledNode("/m", "linux", () => true), join("/m", "runtime", "node"));
  });
  test("a folder from before the rename (runtime\\node.exe only) is still found", () => {
    const has = (p: string): boolean => p.endsWith("node.exe") && !p.endsWith(BUNDLED_NODE_WIN);
    assert.equal(bundledNode("C:\\M", "win32", has), join("C:\\M", "runtime", "node.exe"));
  });
  test("the build, the launcher, the smoke test and CI all name the same file", () => {
    assert.match(text("scripts", "build-bundle.mjs"), /"monomem-node\.exe"/);
    assert.match(text("installer", "monomem.cmd"), /runtime\\monomem-node\.exe/);
    assert.doesNotMatch(text("installer", "monomem.cmd"), /runtime\\node\.exe/);
    assert.match(text("scripts", "smoke-bundle.mjs"), /monomem-node\.exe/);
    assert.match(text(".github", "workflows", "bundle.yml"), /runtime\/monomem-node\.exe/);
    assert.doesNotMatch(text(".github", "workflows", "bundle.yml"), /runtime\/node\.exe/);
  });
  test("the Start menu entry starts monomem-node.exe", () => {
    const win = shortcutPlan({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }, "C:\\Users\\a\\AppData\\Local\\Programs\\Monomem");
    assert.match(win.lnk!.target, /runtime[\\/]monomem-node\.exe$/);
  });
});

describe("monomem update and the runtime's name (Windows)", () => {
  const ARCHIVE = Buffer.from("pretend this is a zip");
  const sha = createHash("sha256").update(ARCHIVE).digest("hex");
  const run = async (newName: string) => {
    const root = scratch();
    put(join(root, "runtime", "node.exe"), "node for 1.6.0"); // an install from before the rename
    put(join(root, "dist", "src", "cli.js"), "// 1.6.0");
    const runs: string[][] = [];
    const d: UpdateDeps = {
      mode: "bundle", root, version: "1.6.0", platform: "win32", arch: "x64", env: {}, out: () => {}, err: () => {},
      fetch: (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v1.7.0", assets: [{ name: "monomem-1.7.0-win-x64.zip", browser_download_url: "https://dl/a" }, { name: "SHA256SUMS", browser_download_url: "https://dl/s" }] }));
        return new Response(u === "https://dl/s" ? `${sha}  monomem-1.7.0-win-x64.zip\n` : ARCHIVE);
      }) as typeof fetch,
      unpack: (_a, into) => {
        put(join(into, "Monomem", "runtime", newName), "node for 1.7.0");
        put(join(into, "Monomem", "dist", "src", "cli.js"), "// 1.7.0");
      },
      run: (cmd, args) => {
        runs.push([cmd, ...args]);
        return { status: 0, stdout: args.includes("--version") ? readFileSync(cmd, "utf8").replace("node for ", "") + "\n" : "" };
      },
      rename: undefined,
      remove: undefined,
    };
    return { code: await runUpdate({ check: false }, d), root, runs };
  };
  test("an old install takes a new folder whose runtime is monomem-node.exe, and the new runtime finishes", async () => {
    const r = await run("monomem-node.exe");
    assert.equal(r.code, 0);
    assert.equal(readFileSync(join(r.root, "runtime", "monomem-node.exe"), "utf8"), "node for 1.7.0");
    assert.equal(r.runs.at(-1)![0], join(r.root, "runtime", "monomem-node.exe"));
  });
  test("a release whose runtime is still node.exe is accepted too", async () => {
    const r = await run("node.exe");
    assert.equal(r.code, 0);
    assert.equal(r.runs.at(-1)![0], join(r.root, "runtime", "node.exe"));
  });
});

describe("the Monomem icon", () => {
  const png = readFileSync(join(REPO, "docs", "brand", "favicon-64.png"));
  test("the build turns the brand PNG into a Windows .ico and a macOS .icns that hold it unchanged", async () => {
    const b = (await import(pathToFileURL(join(REPO, "scripts", "build-bundle.mjs")).href)) as { icoFromPng(p: Buffer): Buffer; icnsFromPng(p: Buffer): Buffer };
    const ico = b.icoFromPng(png);
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 1], "ICONDIR: reserved, type icon, one image");
    assert.equal(ico[6], 64, "width");
    assert.equal(ico.readUInt32LE(6 + 8), png.length, "image size");
    assert.equal(ico.readUInt32LE(6 + 12), 22, "image offset");
    assert.ok(ico.subarray(22).equals(png));
    const icns = b.icnsFromPng(png);
    assert.equal(icns.toString("latin1", 0, 4), "icns");
    assert.equal(icns.readUInt32BE(4), icns.length);
    assert.equal(icns.toString("latin1", 8, 12), "icp6", "64x64 PNG entry");
    assert.ok(icns.subarray(16).equals(png));
  });
  test("each platform's entry names the icon shipped in the folder", () => {
    const win = shortcutPlan({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }, "C:\\M");
    assert.equal(win.icon, join("C:\\M", "dist", "monomem.ico"));
    const lin = shortcutPlan({ platform: "linux", home: "/home/a", env: {} }, "/home/a/.local/share/monomem");
    assert.ok(lin.text!.split("\n").includes(`Icon=${join("/home/a/.local/share/monomem", "dist", "monomem.png")}`), lin.text);
    const mac = shortcutPlan({ platform: "darwin", home: "/Users/a", env: {} }, "/Users/a/Applications/Monomem");
    assert.equal(mac.icon, join("/Users/a/Applications/Monomem", "dist", "monomem.icns"));
  });
  test("macOS: the .app gets the icon in Contents/Resources and names it in Info.plist", () => {
    const root = scratch();
    const inst = join(root, "Applications", "Monomem");
    put(join(inst, "dist", "monomem.icns"), "ICNS");
    const p = shortcutPlan({ platform: "darwin", home: root, env: {} }, inst);
    createShortcut(p, "darwin");
    assert.equal(readFileSync(join(p.createdDir!, "Contents", "Resources", "monomem.icns"), "utf8"), "ICNS");
    assert.match(readFileSync(join(p.createdDir!, "Contents", "Info.plist"), "utf8"), /<key>CFBundleIconFile<\/key><string>monomem<\/string>/);
  });
  test("Windows: the Start menu .lnk carries the icon", { skip: process.platform !== "win32" }, () => {
    const root = scratch();
    const inst = join(root, "Monomem");
    put(join(inst, "dist", "monomem.ico"), Buffer.from([0, 0, 1, 0]));
    const p = shortcutPlan({ platform: "win32", home: root, env: { APPDATA: join(root, "Roaming") } }, inst);
    createShortcut(p, "win32");
    const icon = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject WScript.Shell).CreateShortcut($env:MM_LNK).IconLocation"], { env: { ...process.env, MM_LNK: p.file }, encoding: "utf8" }).trim();
    assert.equal(icon.toLowerCase(), `${join(inst, "dist", "monomem.ico")},0`.toLowerCase());
  });
});

describe("Windows download mark", () => {
  test("setup's copy into the home folder carries no Zone.Identifier (an installer's files have none)", { skip: process.platform !== "win32" }, () => {
    const root = scratch();
    const dl = join(root, "Downloads", "Monomem");
    put(join(dl, "runtime", BUNDLED_NODE_WIN), "node");
    put(join(dl, "dist", "src", "cli.js"), "// cli");
    for (const f of [join(dl, "runtime", BUNDLED_NODE_WIN), join(dl, "dist", "src", "cli.js")]) writeFileSync(`${f}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
    assert.ok(existsSync(`${join(dl, "dist", "src", "cli.js")}:Zone.Identifier`), "the test can see the mark");
    const home = join(root, "Programs", "Monomem");
    copyToInstall(dl, home);
    assert.ok(!existsSync(`${join(home, "runtime", BUNDLED_NODE_WIN)}:Zone.Identifier`));
    assert.ok(!existsSync(`${join(home, "dist", "src", "cli.js")}:Zone.Identifier`));
    assert.ok(existsSync(`${join(dl, "dist", "src", "cli.js")}:Zone.Identifier`), "the download itself is left as it was");
    // An older copy at home is replaced the same way (the staged copy is cleared before the swap).
    copyToInstall(dl, home);
    assert.ok(!existsSync(`${join(home, "dist", "src", "cli.js")}:Zone.Identifier`));
  });
});
