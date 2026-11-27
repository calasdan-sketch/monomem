// Round 3, 06-F6: setup locks an existing Windows data folder (best effort) and --undo gives the inherited permissions back.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockDataFolder, restoreDataFolderLock } from "../src/setup/lock-data-folder.js";

const win = { platform: "win32" as const, env: { USERNAME: "me", USERDOMAIN: "PC" } as NodeJS.ProcessEnv, user: "me" };
const BS = String.fromCharCode(92);
const WIDE = `PC${BS}me:(F)\nBUILTIN${BS}Users:(OI)(CI)(RX)\n`;
const PRIVATE = `PC${BS}me:(F)\n`;

function folder(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mm-acl-"));
  const dir = join(root, "data");
  mkdirSync(dir);
  writeFileSync(join(dir, "state.db"), ""); // the Monomem marker the lockdown requires
  return { root, dir };
}

test("a folder open to Users is noted, then locked to the owner and SYSTEM", () => {
  const { root, dir } = folder();
  const calls: string[][] = [];
  const msg = lockDataFolder(win, dir, (a) => (calls.push(a), a.length === 1 ? WIDE : ""));
  assert.match(msg, /Locked the data folder/);
  assert.ok(calls[1].includes("/inheritance:r") && calls[1].includes("SYSTEM:(OI)(CI)F"));
  assert.match(readFileSync(join(root, "data.setup-acl-backup.txt"), "utf8"), /Users:/);
  rmSync(root, { recursive: true, force: true });
});

test("an already private folder, a missing folder, another OS and MONOMEM_NO_CHMOD change nothing", () => {
  const { root, dir } = folder();
  let n = 0;
  const run = (a: string[]): string => (n++, a.length === 1 ? PRIVATE : "");
  assert.equal(lockDataFolder(win, dir, run), "");
  assert.equal(n, 1);
  assert.equal(lockDataFolder(win, join(root, "none"), run), "");
  assert.equal(lockDataFolder({ ...win, platform: "linux" }, dir, run), "");
  assert.equal(lockDataFolder({ ...win, env: { ...win.env, MONOMEM_NO_CHMOD: "1" } }, dir, () => WIDE), "");
  rmSync(root, { recursive: true, force: true });
});

test("30-F4: a folder with no Monomem file in it is never locked", () => {
  const { root, dir } = folder();
  rmSync(join(dir, "state.db"));
  const calls: string[][] = [];
  const msg = lockDataFolder(win, dir, (a) => (calls.push(a), WIDE));
  assert.match(msg, /Did not change the permissions.*does not look like a Monomem data folder/);
  assert.equal(calls.length, 0, "icacls was not even asked");
  rmSync(root, { recursive: true, force: true });
});

test("an icacls failure is a message, never an exception", () => {
  const { root, dir } = folder();
  assert.match(lockDataFolder(win, dir, () => { throw new Error("icacls missing"); }), /Could not lock the data folder.*icacls missing/);
  rmSync(root, { recursive: true, force: true });
});

test("undo turns inheritance back on, once", () => {
  const { root, dir } = folder();
  const note = join(root, "data.setup-acl-backup.txt");
  writeFileSync(note, "x");
  const calls: string[][] = [];
  assert.match(restoreDataFolderLock(win, dir, (a) => (calls.push(a), "")), /inherited permissions back/);
  assert.deepEqual(calls[0], [dir, "/inheritance:e"]);
  assert.equal(existsSync(note), false);
  assert.equal(restoreDataFolderLock(win, dir, () => ""), "");
  rmSync(root, { recursive: true, force: true });
});

test("31-M10: the note of the old permissions is on disk BEFORE the first change", () => {
  const { root, dir } = folder();
  const backup = join(root, "data.setup-acl-backup.txt");
  let sawBackupAtChange = false;
  lockDataFolder(win, dir, (a) => {
    if (a.includes("/inheritance:r")) sawBackupAtChange = existsSync(backup);
    return a.length === 1 ? WIDE : "";
  });
  assert.equal(sawBackupAtChange, true);
  rmSync(root, { recursive: true, force: true });
});
