// `monomem service install|status|uninstall` (1.5.0, U-16): keep the server running in the background after you sign in.
// Explicit only: setup never calls it. Each OS gets its native per-user mechanism, launching the absolute node binary with
// the absolute cli.js (nothing depends on PATH, a .ps1/.cmd shim or nvm's shell setup):
//   Windows  a Task Scheduler task at logon (schtasks /XML), restarted if it stops
//   macOS    ~/Library/LaunchAgents/io.monomem.server.plist (RunAtLoad + KeepAlive)
//   Linux    ~/.config/systemd/user/monomem.service (systemctl --user, Restart=always)
// The server runs `start --log`, so what it prints goes to <data>/server.log.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TASK_NAME = "Monomem";
export const LAUNCHD_LABEL = "io.monomem.server";
export const SYSTEMD_UNIT = "monomem.service";
/** Settings worth carrying into the service, where the OS lets a unit hold them. Never a key: those stay in their files. */
const CARRIED_ENV = ["MONOMEM_HOME", "MONOMEM_DB_PATH", "MONOMEM_PORT", "MONOMEM_MCP_PORT", "MONOMEM_BIND", "MONOMEM_ALLOWED_HOSTS"];

export interface ServiceEnv {
  platform: NodeJS.Platform;
  node: string; // absolute path of the node binary (process.execPath)
  cli: string; // absolute path of dist/src/cli.js
  home: string;
  dataDir: string;
  uid?: number;
  env: Record<string, string | undefined>;
}

export interface ServicePlan {
  /** The file install writes (UTF-16 for the Windows task XML, as Task Scheduler writes it). */
  file: { path: string; text: string; utf16?: boolean };
  install: string[][];
  status: string[][];
  uninstall: string[][];
  /** Said after install, in plain words. */
  notes: string[];
}

/** Escape for XML element text (never used in an attribute, so quotes stay as they are: they quote paths with spaces). */
const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The service settings: the data folder in use now, plus the other MONOMEM_* settings set in this shell. */
function carried(e: ServiceEnv): Array<[string, string]> {
  const out: Array<[string, string]> = [["MONOMEM_HOME", e.dataDir]];
  for (const k of CARRIED_ENV.slice(1)) {
    const v = e.env[k]?.trim();
    if (v) out.push([k, v]);
  }
  return out;
}

export function servicePlan(e: ServiceEnv): ServicePlan {
  const args = [e.cli, "start", "--log"];
  if (e.platform === "win32") {
    const path = join(e.dataDir, "monomem-task.xml");
    const text = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo><Description>Monomem memory server (monomem service install)</Description></RegistrationInfo>",
      "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
      "  <Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
      "  </Settings>",
      '  <Actions Context="Author">',
      `    <Exec><Command>${xml(e.node)}</Command><Arguments>${xml(args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "))}</Arguments><WorkingDirectory>${xml(e.dataDir)}</WorkingDirectory></Exec>`,
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
    return {
      file: { path, text, utf16: true },
      install: [["schtasks", "/Create", "/TN", TASK_NAME, "/XML", path, "/F"], ["schtasks", "/Run", "/TN", TASK_NAME]],
      status: [["schtasks", "/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]],
      uninstall: [["schtasks", "/End", "/TN", TASK_NAME], ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"]],
      notes: [
        "It starts when you sign in to Windows, in a console window. Minimise that window: closing it stops Monomem (Task Scheduler starts it again within a minute).",
        "A Windows task cannot hold settings: it uses the MONOMEM_* variables saved for your user (setx), not ones set only in this terminal.",
      ],
    };
  }
  if (e.platform === "darwin") {
    const path = join(e.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const str = (s: string): string => `<string>${xml(s)}</string>`;
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key>${str(LAUNCHD_LABEL)}`,
      `  <key>ProgramArguments</key><array>${[e.node, ...args].map(str).join("")}</array>`,
      `  <key>EnvironmentVariables</key><dict>${carried(e).map(([k, v]) => `<key>${k}</key>${str(v)}`).join("")}</dict>`,
      `  <key>WorkingDirectory</key>${str(e.dataDir)}`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    const domain = `gui/${e.uid ?? 501}`;
    return {
      file: { path, text },
      install: [["launchctl", "bootstrap", domain, path]],
      status: [["launchctl", "print", `${domain}/${LAUNCHD_LABEL}`]],
      uninstall: [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]],
      notes: ["It starts when you log in and launchd restarts it if it stops."],
    };
  }
  // systemd --user (Linux and the other unixes that have it).
  const path = join(e.env.XDG_CONFIG_HOME?.trim() || join(e.home, ".config"), "systemd", "user", SYSTEMD_UNIT);
  const q = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const text = [
    "[Unit]",
    "Description=Monomem memory server (monomem service install)",
    "",
    "[Service]",
    ...carried(e).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    `ExecStart=${[e.node, ...args].map(q).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "TimeoutStopSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    file: { path, text },
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]],
    status: [["systemctl", "--user", "status", SYSTEMD_UNIT, "--no-pager"]],
    uninstall: [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]],
    notes: [
      "It starts when you log in and systemd restarts it if it stops. To keep it running while you are logged out: loginctl enable-linger",
    ],
  };
}

const shown = (cmd: string[]): string => cmd.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");

function run(cmd: string[], quiet = false): boolean {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (!quiet && out.trim()) console.log(out.trimEnd());
    return true;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    if (!quiet) console.error(`  ${shown(cmd)} failed: ${(err.stderr || err.message).trim()}`);
    return false;
  }
}

/** `monomem service <install|status|uninstall> [--print]`. --print shows the file and the commands and changes nothing. */
export function serviceCmd(action: string | undefined, print: boolean, e: ServiceEnv): number {
  if (action !== "install" && action !== "status" && action !== "uninstall") {
    console.error("Usage: monomem service install|status|uninstall [--print]   (--print shows what would be done and changes nothing)");
    return 1;
  }
  const plan = servicePlan(e);
  if (print) {
    if (action === "install") console.log(`Would write ${plan.file.path}:\n\n${plan.file.text}`);
    if (action === "uninstall") console.log(`Would remove ${plan.file.path}`);
    console.log(`Would run:\n${plan[action].map((c) => "  " + shown(c)).join("\n")}`);
    return 0;
  }
  if (action === "status") {
    if (!existsSync(plan.file.path) && e.platform !== "win32") {
      console.log(`Not installed (no ${plan.file.path}). Install it: monomem service install`);
      return 1;
    }
    return plan.status.every((c) => run(c)) ? 0 : 1;
  }
  if (action === "install") {
    mkdirSync(dirname(plan.file.path), { recursive: true });
    writeFileSync(plan.file.path, plan.file.utf16 ? Buffer.from(String.fromCharCode(0xfeff) + plan.file.text, "utf16le") : plan.file.text);
    if (!plan.install.every((c) => run(c))) {
      console.error(`The service was not installed. The file is at ${plan.file.path}; the commands above say what went wrong.`);
      return 1;
    }
    console.log(`Installed: Monomem now runs in the background (${e.node} ${e.cli} start --log).`);
    for (const n of plan.notes) console.log(n);
    console.log(`Its output goes to ${join(e.dataDir, "server.log")}. Check it: monomem service status. Remove it: monomem service uninstall`);
    return 0;
  }
  // uninstall: stopping a service that is not running fails harmlessly, so each step runs and only the removal is judged.
  let ok = true;
  plan.uninstall.forEach((c, i) => {
    const last = i === plan.uninstall.length - 1;
    if (!run(c, !last) && last) ok = false;
  });
  rmSync(plan.file.path, { force: true });
  if (e.platform !== "win32" && e.platform !== "darwin") run(["systemctl", "--user", "daemon-reload"], true);
  console.log(ok ? "Removed: Monomem no longer starts in the background." : "Removed the file; the service manager reported a problem (above).");
  return ok ? 0 : 1;
}
