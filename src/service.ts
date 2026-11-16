// `monomem service install|status|uninstall` (1.5.0, U-16): keep the server running in the background after you sign in.
// Explicit only: setup never calls it. Each OS gets its native per-user mechanism, launching the absolute node binary with
// the absolute cli.js (nothing depends on PATH, a .ps1/.cmd shim or nvm's shell setup):
//   Windows  a Task Scheduler task at logon (schtasks /XML), restarted if it stops; cmd.exe (ComSpec) sets the settings, then runs node.exe
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
  /** Run before install with failures ignored: stops a server that is already running, so a re-install (after an upgrade) restarts it. */
  preInstall: string[][];
  /** Set when this machine's paths cannot be put in the service safely: install refuses with these words. */
  refuse?: string;
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
    // A task action cannot hold settings, so cmd.exe sets them and then runs node.exe (release-gate S1: without this the
    // task used the default data folder). `set "K=V"` keeps & and spaces literal; % expands even in quotes, so such a
    // value is left out and the note says to save it with setx. /v:off: ! stays literal too.
    // The first set is always there so the line after /c never starts with a quote: cmd /c strips the first and last
    // quote of such a line, which breaks a quoted node.exe followed by a quoted cli.js path (all settings skipped).
    const sets: string[] = ['set "MONOMEM_SERVICE=1"&& '];
    const skipped: string[] = [];
    for (const [k, v] of carried(e)) {
      if (/[%"]/.test(v)) skipped.push(k);
      else sets.push(`set "${k}=${v}"&& `);
    }
    // node and cli.js are always quoted: outside quotes cmd.exe reads & as "next command" and ^ as an escape (a user folder
    // named R&D broke the task). % expands even inside quotes and a quote cannot be escaped, so such a path is refused.
    const odd = [e.node, e.cli].find((x) => /[%"]/.test(x));
    const refuse = odd
      ? `The Windows task cannot run Monomem from a path that contains % or a quote (${odd}). Install Node.js and Monomem in a folder without them, then run monomem service install again.`
      : undefined;
    const cmdArgs = `/d /v:off /c ${sets.join("")}"${e.node}" "${e.cli}" ${args.slice(1).join(" ")}`;
    // The task belongs to this user: a logon trigger with no user means "any user", which needs an administrator to register.
    const user = e.env.USERNAME?.trim();
    const domain = e.env.USERDOMAIN?.trim();
    const userId = user ? `<UserId>${xml(domain ? `${domain}\\${user}` : user)}</UserId>` : "";
    const text = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo><Description>Monomem memory server (monomem service install)</Description></RegistrationInfo>",
      // RestartOnFailure covers only a task that fails to START; a crash or a closed console window is not a failure to
      // Task Scheduler. The 5-minute repeat (with IgnoreNew) starts it again then, and does nothing while it runs.
      `  <Triggers><LogonTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled>${userId}</LogonTrigger></Triggers>`,
      `  <Principals><Principal id="Author">${userId}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
      "  </Settings>",
      '  <Actions Context="Author">',
      `    <Exec><Command>${xml(e.env.ComSpec?.trim() || "C:\\Windows\\System32\\cmd.exe")}</Command><Arguments>${xml(cmdArgs)}</Arguments><WorkingDirectory>${xml(e.dataDir)}</WorkingDirectory></Exec>`,
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
    return {
      file: { path, text, utf16: true },
      ...(refuse ? { refuse } : {}),
      // /End first: with IgnoreNew, /Run does nothing while the old version still runs.
      preInstall: [["schtasks", "/End", "/TN", TASK_NAME]],
      install: [["schtasks", "/Create", "/TN", TASK_NAME, "/XML", path, "/F"], ["schtasks", "/Run", "/TN", TASK_NAME]],
      status: [["schtasks", "/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]],
      uninstall: [["schtasks", "/End", "/TN", TASK_NAME], ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"]],
      notes: [
        "It starts when you sign in to Windows, in a console window. Minimise that window: closing it stops Monomem (Task Scheduler starts it again within 5 minutes).",
        `It uses the data folder ${e.dataDir} and the MONOMEM_* settings set in this terminal now; a key never goes into the task.`,
        ...skipped.map((k) => `${k} contains % or a quote, which the task cannot carry: save it for your user instead (setx ${k} "<value>").`),
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
      // bootstrap fails on an agent that is already loaded: take the old one out first (fails harmlessly when absent).
      preInstall: [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]],
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
    preInstall: [],
    // restart, not enable --now: it starts a stopped unit and restarts a running one (the new version after an upgrade).
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", SYSTEMD_UNIT], ["systemctl", "--user", "restart", SYSTEMD_UNIT]],
    status: [["systemctl", "--user", "status", SYSTEMD_UNIT, "--no-pager"]],
    uninstall: [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]],
    notes: [
      "It starts when you log in and systemd restarts it if it stops. To keep it running while you are logged out: loginctl enable-linger",
    ],
  };
}

const shown = (cmd: string[]): string => cmd.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");

function runCmd(cmd: string[], quiet = false): boolean {
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

/** Runs one command (true when it worked) and waits; tests pass stubs, so nothing is ever registered from a test. */
export interface ServiceDeps {
  run?: (cmd: string[], quiet?: boolean) => boolean;
  sleep?: (ms: number) => void;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** `monomem service <install|status|uninstall> [--print]`. --print shows the file and the commands and changes nothing. */
export function serviceCmd(action: string | undefined, print: boolean, e: ServiceEnv, deps: ServiceDeps = {}): number {
  const run = deps.run ?? runCmd;
  const sleep = deps.sleep ?? sleepSync;
  if (action !== "install" && action !== "status" && action !== "uninstall") {
    console.error("Usage: monomem service install|status|uninstall [--print]   (--print shows what would be done and changes nothing)");
    return 1;
  }
  const plan = servicePlan(e);
  if (action === "install" && plan.refuse) {
    console.error(plan.refuse);
    return 1;
  }
  if (print) {
    if (action === "install") console.log(`Would write ${plan.file.path}:\n\n${plan.file.text}`);
    if (action === "uninstall") console.log(`Would remove ${plan.file.path}`);
    const cmds = action === "install" ? [...plan.preInstall, ...plan.install] : plan[action];
    console.log(`Would run:\n${cmds.map((c) => "  " + shown(c)).join("\n")}`);
    return 0;
  }
  if (action === "status") {
    if (!existsSync(plan.file.path) && e.platform !== "win32") {
      console.log(`Not installed (no ${plan.file.path}). Install it: monomem service install`);
      return 1;
    }
    for (const c of plan.status) {
      try {
        const out = execFileSync(c[0], c.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        if (out.trim()) console.log(out.trimEnd());
      } catch (err) {
        // The service manager's own words ("cannot find the file specified") read like a Monomem fault: say what it means.
        const said = (((err as { stderr?: string }).stderr ?? "") || (err as Error).message).trim().split("\n")[0];
        // Simply absent: the plain words are the whole story (same answer and exit code as the no-file case above).
        if (/cannot find|could not (be )?find|could not be found|not found|does not exist|no such/i.test(said)) {
          console.log("Not installed. Install it: monomem service install");
          return 1;
        }
        console.log(`The background service is not installed or not running (${shown(c)} said: ${said}). Install it: monomem service install`);
        return 1;
      }
    }
    return 0;
  }
  if (action === "install") {
    mkdirSync(dirname(plan.file.path), { recursive: true });
    writeFileSync(plan.file.path, plan.file.utf16 ? Buffer.from(String.fromCharCode(0xfeff) + plan.file.text, "utf16le") : plan.file.text);
    for (const c of plan.preInstall) run(c, true); // nothing running yet is fine
    // macOS: bootstrap right after bootout can fail ("Bootstrap failed: 5") while the old job is still exiting: retry once after 1 s.
    const runInstall = (c: string[]): boolean => {
      if (e.platform !== "darwin" || c[1] !== "bootstrap") return run(c);
      if (run(c, true)) return true;
      sleep(1000);
      return run(c);
    };
    if (!plan.install.every(runInstall)) {
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
