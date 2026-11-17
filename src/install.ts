// The standalone download's home on this computer, and its "Monomem" entry where apps live. Per user, no admin rights:
//   Windows  %LOCALAPPDATA%\Programs\Monomem          Start menu: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Monomem.lnk
//   macOS    ~/Applications/Monomem                   Applications: ~/Applications/Monomem.app (made here, so no quarantine)
//   Linux    ~/.local/share/monomem ($XDG_DATA_HOME)  menu: ~/.local/share/applications/monomem.desktop
// `setup` run from the unpacked download copies the folder here first, so every app setting and hook names a path that
// never moves (updates swap the contents in place: update.ts). The entry runs `monomem open` (the dashboard).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { swapIn } from "./update.js";

export interface PlaceEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Where the standalone Monomem folder lives for this user. */
export function installDir(e: PlaceEnv): string {
  if (e.platform === "win32") return join(e.env.LOCALAPPDATA?.trim() || join(e.home, "AppData", "Local"), "Programs", "Monomem");
  if (e.platform === "darwin") return join(e.home, "Applications", "Monomem");
  return join(e.env.XDG_DATA_HOME?.trim() || join(e.home, ".local", "share"), "monomem");
}

/** The folder of a bundled copy: <root>/dist/src/cli.js. */
export function bundleRoot(cliPath: string): string {
  return resolve(cliPath, "..", "..", "..");
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const n = (p: string): string => resolve(p).replace(/[\\/]+$/, "");
  return platform === "win32" || platform === "darwin" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** A path inside `from` moved to the same place inside `to`. */
export function rebase(p: string, from: string, to: string): string {
  return join(to, relative(from, p));
}

/**
 * Copy the unpacked download into its home. An older copy already there is replaced with update's rename-aside swap
 * (its node may be running an app's MCP server right now).
 */
export function copyToInstall(from: string, to: string): void {
  // An earlier update's leftovers inside the download folder are not copied.
  const filter = (p: string): boolean => p === from || !/[\\/]\.(old|update)-[^\\/]*$/.test(p);
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, filter });
    return;
  }
  const staged = join(to, `.update-copy-${Date.now()}`);
  cpSync(from, staged, { recursive: true, filter });
  try {
    swapIn(to, staged, join(to, `.old-${Date.now()}`));
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export interface ShortcutPlan {
  /** The file setup creates (the .lnk, the .desktop file, the .app's program). */
  file: string;
  /** A folder setup creates around it, removed with it by undo (macOS: the .app). */
  createdDir?: string;
  /** Where it shows up, in plain words. */
  where: string;
  /** Text files: the exact content. The Windows .lnk is binary and made by Windows itself (shell link API). */
  text?: string;
  /** Windows: what the .lnk starts. */
  lnk?: { target: string; args: string; dir: string };
}

const q = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/** The "Monomem" entry that opens the dashboard, for the copy at `root`. */
export function shortcutPlan(e: PlaceEnv, root: string): ShortcutPlan {
  const node = join(root, "runtime", e.platform === "win32" ? "node.exe" : "node");
  const cli = join(root, "dist", "src", "cli.js");
  if (e.platform === "win32") {
    const programs = join(e.env.APPDATA?.trim() || join(e.home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
    return { file: join(programs, "Monomem.lnk"), where: "Start menu", lnk: { target: node, args: `"${cli}" open`, dir: root } };
  }
  if (e.platform === "darwin") {
    const app = join(e.home, "Applications", "Monomem.app");
    return { file: join(app, "Contents", "MacOS", "Monomem"), createdDir: app, where: "Applications (~/Applications)", text: `#!/bin/sh\nexec ${q(node)} ${q(cli)} open\n` };
  }
  const apps = join(e.env.XDG_DATA_HOME?.trim() || join(e.home, ".local", "share"), "applications");
  const exec = (s: string): string => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;
  return {
    file: join(apps, "monomem.desktop"),
    where: "the applications menu",
    text: ["[Desktop Entry]", "Type=Application", "Name=Monomem", "Comment=Open your Monomem notes", `Exec=${exec(node)} ${exec(cli)} open`, "Terminal=false", "Categories=Utility;", ""].join("\n"),
  };
}

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Monomem</string>
<key>CFBundleIdentifier</key><string>io.monomem.open</string>
<key>CFBundleExecutable</key><string>Monomem</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;

/** Create the entry. Returns the SHA-256 of the created file as read back (setup's undo removes it only if unchanged). */
export function createShortcut(p: ShortcutPlan, platform: NodeJS.Platform): string {
  mkdirSync(dirname(p.file), { recursive: true });
  if (p.lnk) {
    // Values travel in environment variables, so no path is ever pasted into the PowerShell text.
    const script = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:MM_LNK);$s.TargetPath=$env:MM_TARGET;$s.Arguments=$env:MM_ARGS;$s.WorkingDirectory=$env:MM_DIR;$s.WindowStyle=7;$s.Description='Open Monomem';$s.Save()";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, MM_LNK: p.file, MM_TARGET: p.lnk.target, MM_ARGS: p.lnk.args, MM_DIR: p.lnk.dir },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      timeout: 30_000,
    });
  } else {
    writeFileSync(p.file, p.text ?? "");
    if (platform === "darwin") {
      chmodSync(p.file, 0o755);
      writeFileSync(join(p.createdDir!, "Contents", "Info.plist"), MAC_PLIST);
    }
  }
  return createHash("sha256").update(readFileSync(p.file, "utf8")).digest("hex");
}


// ---- the launcher folder on the user's PATH ---------------------------------------------------------------------------------
// setup (bundle mode) offers to put the install folder (monomem.cmd / monomem live at its root) on PATH, so `monomem` works in
// a new terminal. Windows: the per-user Path value in HKCU\Environment, read and written raw (REG_EXPAND_SZ kept, no setx and so
// no 1024-character cut), then WM_SETTINGCHANGE so new windows see it. macOS / Linux: one marked line in the shell's rc file.
// Undo takes out exactly what was added and leaves every other entry, including ones added since.

/** The Windows per-user Path value. Injected in tests: they never touch the real registry or PATH. */
export interface UserPathIO {
  /** null: there is no Path value at all (not even an empty one). */
  get(): string | null;
  /** null removes the value. */
  set(value: string | null): void;
}

export interface PathEntry {
  kind: "registry" | "rc";
  dir: string;
  /** Where, in plain words. */
  where: string;
  /** rc: the file and the exact line added. */
  file?: string;
  line?: string;
  /** registry, recorded when added: the value did not exist ("none"), or ended in ";" ("trailing"); undo restores that. */
  before?: "none" | "trailing";
}

const RC_MARK = "# added by monomem setup";
/** Escaped for the inside of a double-quoted shell (and fish) string. */
const inDq = (s: string): string => s.replace(/(["\\$`])/g, "\\$1");
const expandWin = (p: string, env: NodeJS.ProcessEnv): string => p.replace(/%([^%]+)%/g, (m, k: string) => env[k] ?? env[k.toUpperCase()] ?? m);

/** The PATH step for `dir`, or null when it is already there (this shell's PATH, the user Path value, or the rc line). */
export function pathPlan(e: PlaceEnv, dir: string, reg?: UserPathIO): PathEntry | null {
  const win = e.platform === "win32";
  const has = (v: string | undefined): boolean =>
    (v ?? "").split(win ? ";" : ":").some((p) => p.trim() !== "" && samePath(win ? expandWin(p.trim(), e.env) : p.trim(), dir, e.platform));
  if (has(e.env.PATH ?? e.env.Path)) return null;
  if (win) {
    if (!reg || has(reg.get() ?? undefined)) return null;
    return { kind: "registry", dir, where: "your user PATH (HKCU\\Environment)" };
  }
  const shell = (e.env.SHELL ?? "").split("/").pop();
  const file =
    shell === "zsh" ? join(e.home, ".zshrc")
    : shell === "bash" ? join(e.home, e.platform === "darwin" ? ".bash_profile" : ".bashrc")
    : shell === "fish" ? join(e.home, ".config", "fish", "config.fish")
    : join(e.home, ".profile");
  const line = shell === "fish" ? `set -gx PATH "${inDq(dir)}" $PATH ${RC_MARK}` : `export PATH="${inDq(dir)}:$PATH" ${RC_MARK}`;
  if (existsSync(file) && readFileSync(file, "utf8").split(/\r?\n/).includes(line)) return null;
  return { kind: "rc", dir, where: file, file, line };
}

/** Add the entry; returns the step to record (for the user Path value: what it looked like, so undo is exact). */
export function addToPath(p: PathEntry, reg?: UserPathIO): PathEntry {
  if (p.kind === "registry") {
    if (!reg) throw new Error("no access to the user PATH");
    const was = reg.get();
    const cur = (was ?? "").replace(/;+$/, "");
    reg.set(cur ? `${cur};${p.dir}` : p.dir);
    return was === null ? { ...p, before: "none" } : /;$/.test(was) ? { ...p, before: "trailing" } : p;
  }
  const cur = existsSync(p.file!) ? readFileSync(p.file!, "utf8") : "";
  mkdirSync(dirname(p.file!), { recursive: true });
  writeFileSync(p.file!, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${p.line}\n`);
  return p;
}

/** Take out exactly the entry `addToPath` added (the last one equal to it). False when it is not there any more. */
export function removeFromPath(p: PathEntry, reg?: UserPathIO): boolean {
  if (p.kind === "registry") {
    if (!reg) throw new Error("no access to the user PATH");
    const parts = (reg.get() ?? "").split(";");
    const i = parts.map((x) => x.trim().toLowerCase()).lastIndexOf(p.dir.toLowerCase());
    if (i < 0) return false;
    parts.splice(i, 1);
    // Ours was last and the value ended in ";" before: that ";" comes back. A value setup created goes again when empty.
    const next = parts.join(";") + (p.before === "trailing" && i === parts.length && i > 0 ? ";" : "");
    reg.set(p.before === "none" && next === "" ? null : next);
    return true;
  }
  if (!existsSync(p.file!)) return false;
  const lines = readFileSync(p.file!, "utf8").split("\n");
  const i = lines.map((l) => l.replace(/\r$/, "")).lastIndexOf(p.line!);
  if (i < 0) return false;
  lines.splice(i, 1);
  writeFileSync(p.file!, lines.join("\n"));
  return true;
}

const PS_READ =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment');" +
  "if($k -and ($k.GetValueNames() -contains 'Path')){[Console]::Out.Write('='+$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))}";
const PS_WRITE =
  "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');$t=[Microsoft.Win32.RegistryValueKind]::ExpandString;" +
  "if($k.GetValueNames() -contains 'Path' -and $k.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::String){$t=[Microsoft.Win32.RegistryValueKind]::String};" +
  "if($env:MM_PATH_DELETE -eq '1'){$k.DeleteValue('Path',$false)}else{$k.SetValue('Path',$env:MM_PATH,$t)};$k.Close();" +
  "Add-Type -Namespace MM -Name W -MemberDefinition '[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);';" +
  "$r=[UIntPtr]::Zero;[void][MM.W]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)";

/** The real per-user Path value (Windows only). Values travel in an environment variable, never inside the script text. */
export function windowsUserPath(): UserPathIO {
  const ps = (script: string, env: NodeJS.ProcessEnv = {}): string =>
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  // The read prints "=" before the value, so an empty value and no value at all differ.
  return {
    get: () => {
      const out = ps(PS_READ);
      return out.startsWith("=") ? out.slice(1) : null;
    },
    set: (v) => void ps(PS_WRITE, v === null ? { MM_PATH_DELETE: "1" } : { MM_PATH: v, MM_PATH_DELETE: "" }),
  };
}
