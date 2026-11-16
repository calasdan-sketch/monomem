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

/**
 * `monomem` with no command: in a terminal (stdin and stdout both a TTY) the help; launched with no terminal (the Start
 * menu entry, Explorer via monomem.cmd's double-click check, Finder, a desktop launcher) the dashboard. The Welcome screen
 * for a first run hooks in at `open`.
 */
export function defaultCommand(stdinTTY: boolean, stdoutTTY: boolean): "help" | "open" {
  return stdinTTY && stdoutTTY ? "help" : "open";
}

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

