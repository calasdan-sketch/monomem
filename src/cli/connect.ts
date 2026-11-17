// `monomem connect`, `open`, `init` and `setup`: wiring apps to Monomem. Moved out of cli.ts unchanged, except that the
// path of cli.js (which these write into app settings or start) is passed in, since this file is not cli.js.

import { requireOperator } from "../operator-gate.js";
import { didYouMean } from "../suggest.js";
import { parseFlags, str, terminalIO } from "./shared.js";
import { selfCommand, selfFacts } from "../self.js";
import { EXTRA_CLIENT_IDS } from "../setup/targets.js";

const CONNECT_APPS = ["claude-code", "claude-desktop", "cursor", "codex", "gemini", "muse", "vscode", "zed", ...EXTRA_CLIENT_IDS] as const;
/** Apps whose config takes a key-based (HTTP) entry setup can write (setup.ts HTTP_CAPABLE); the rest get a paste-in block. */
const HTTP_WRITABLE = ["claude-code", "cursor", "vscode"];

const APP_ALIASES: Record<string, string> = { claude: "claude-code", "claudecode": "claude-code", desktop: "claude-desktop", "claude desktop": "claude-desktop", code: "vscode", "vs-code": "vscode", "visual-studio-code": "vscode", gemini_cli: "gemini", "codex-cli": "codex", copilot: "copilot-cli", "github-copilot": "copilot-cli", "qwen-code": "qwen", "kilo-code": "kilo", kilocode: "kilo", "cline-cli": "cline" };

// `monomem connect <app> [--max level] [--restricted] [--print]`: wire one app, optionally with its own key and limit.
export async function connectCmd(cliPath: string): Promise<void> {
  const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["max", "db", "name"], bools: ["restricted", "print", "dry-run", "yes"] });
  const raw = (rest[0] ?? "").toLowerCase();
  const app = APP_ALIASES[raw] ?? raw;
  if (!app) {
    console.error(`Say which app to connect, for example:  monomem connect claude-code\nApps I know: ${CONNECT_APPS.join(", ")}`);
    process.exit(1);
  }
  if (!(CONNECT_APPS as readonly string[]).includes(app)) {
    const guess = didYouMean(app, CONNECT_APPS);
    console.error(`I do not know an app called "${rest[0]}".${guess ? ` Did you mean "${guess}"?` : ""}\nApps I know: ${CONNECT_APPS.join(", ")}`);
    process.exit(1);
  }
  const restricted = flags.restricted === true || str(flags.max) !== undefined;
  const t = await import("../tokens-admin.js");
  if (!restricted && flags.print !== true) {
    process.argv.splice(2, process.argv.length - 2, "setup", "--only", app, ...(flags["dry-run"] === true ? ["--dry-run"] : []), ...(flags.yes === true ? ["--yes"] : []), "--no-hook", "--no-capture", "--no-path", "--terse", "--no-test-note", "--no-embeddings");
    await setupCmd(cliPath);
    if (!process.exitCode && flags["dry-run"] === true) console.log(`\nDry run: run the same command without --dry-run to connect ${app}.`);
    else if (!process.exitCode) console.log(`\nConnected ${app}. This app can read every note, including private ones. To keep it away from private notes: monomem connect ${app} --restricted`);
    return;
  }
  // Restricted: the app gets its own key and a limit, over the HTTP server.
  const dry = flags["dry-run"] === true;
  const named = str(flags.name)?.trim();
  let label = named || app;
  if (named && t.listApps().some((a) => a.label.toLowerCase() === named.toLowerCase())) {
    console.error(`A key labelled "${named}" already exists. Pick another --name, or see them with: monomem keys list`);
    process.exit(1);
  }
  for (let n = 2; t.listApps().some((a) => a.label.toLowerCase() === label.toLowerCase()); n++) label = `${app}-${n}`;
  let made: { app: ReturnType<typeof t.listApps>[number]; token: string; ceilingWasDefault: boolean } | undefined;
  // R1-08: a new write key is a credential: a person at a terminal types yes first (an agent's shell cannot mint one). A dry run makes none.
  if (!dry) await requireOperator(`connect ${app} (a new write key "${label}")`);
  try {
    // A dry run must not create anything: no key is made, a placeholder stands in for it.
    made = dry
      ? { app: { label, scope: "write", max_sensitivity: (str(flags.max) as never) ?? "internal", source: "tokens" } as never, token: "<a new key would be made here>", ceilingWasDefault: str(flags.max) === undefined }
      : t.addApp({ label, scope: "write", ...(str(flags.max) !== undefined ? { max: str(flags.max)! } : {}) });
  } catch (e) {
    if (e instanceof t.TokenAdminError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { API_PORT, MCP_HTTP_PORT, PACKAGE_VERSION } = await import("../config.js");
  const url = `http://127.0.0.1:${MCP_HTTP_PORT}/mcp`;
  void API_PORT;
  console.log(dry ? `[dry run] Would make a key for "${label}" and nothing has been created. ${t.describeAccess(made.app)}` : `Made a key for "${label}". ${t.describeAccess(made.app)}`);
  if (made.ceilingWasDefault) console.log("(Limit: internal, because you did not choose one. Change it with --max public|internal|private.)");
  if (flags.print === true || !HTTP_WRITABLE.includes(app)) {
    console.log(`\nI am not writing this app's settings file for you (${flags.print === true ? "you asked for --print" : "its format for key-based connections is not one I can check"}). Paste this into its MCP settings:\n`);
    console.log(t.connectionSnippet(made.token));
    console.log(`\nStart the server when you use it:  monomem start`);
    return;
  }
  // Anything that goes wrong from here on removes the key again: no working key is left that nothing uses.
  let code = 1;
  try {
    const { runSetup, realEnv, DEFAULT_OPTIONS } = await import("../setup.js");
    const e = realEnv(PACKAGE_VERSION, cliPath);
    code = await runSetup(e, terminalIO(), {
      ...DEFAULT_OPTIONS,
      yes: flags.yes === true,
      dryRun: dry,
      hook: "no",
      capture: "no",
      noTestNote: true,
      noDoctor: true,
      terse: true,
      only: [app],
      httpEntry: { url, headers: { Authorization: `Bearer ${made.token}` } },
    });
  } catch (e) {
    console.error(`Setting up ${app} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = code;
  if (code === 0) {
    if (!dry) console.log(`\nDone. ${app} now connects with its own key. Start the server so it has something to talk to:  monomem start\nTake access away any time:  monomem keys remove "${label}"`);
  } else if (!dry) {
    t.removeApp(label);
    console.error(`Nothing was connected, so the key for "${label}" was removed again.`);
  }
}

// `monomem open`: start the server if it is not running, then open the dashboard already signed in.
export async function openCmd(cliPath: string): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(3), { values: [], bools: ["print"] });
  const { API_PORT, resolveToken } = await import("../config.js");
  const base = `http://127.0.0.1:${API_PORT}`;
  const up = async (): Promise<boolean> => {
    try {
      return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };
  if (!(await up()) && flags.print !== true) {
    console.log("Starting Monomem in the background...");
    const { spawn } = await import("node:child_process");
    const self = selfCommand(["start", "--log"], { ...selfFacts(), cliPath });
    const child = spawn(self.command, self.args, { detached: true, stdio: "ignore", windowsHide: true }); // no terminal: output goes to server.log
    child.unref();
    const { DB_PATH } = await import("../config.js");
    if (child.pid) (await import("./stop.js")).recordServerPid(DB_PATH, child.pid, API_PORT); // for `monomem stop`
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await up())) {
      console.error(`Monomem did not start. Run  monomem check --setup  to see why, or start it yourself with  monomem start  and look at what it prints.`);
      process.exit(1);
    }
  }
  // The address carries a one-time code (good for 60 seconds), not the key: the key would end up in browser history and in
  // the list of running programs. The dashboard swaps the code for the key.
  const { mintLoginCode } = await import("../login-code.js");
  void resolveToken;
  const url = `${base}/#code=${mintLoginCode()}`;
  if (flags.print === true) {
    console.log(url);
    console.log("(This address works once, for 60 seconds.)");
    return;
  }
  const { spawn } = await import("node:child_process");
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/%/g, "%%").replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => console.log(`I could not open a browser. Open this address yourself:\n${url.replace(/#.*/, "")}  (then paste your key; run monomem check --setup to see where it is kept)`)).unref();
    console.log(`Opened the dashboard: ${base}`);
  } catch {
    console.log(`Open this address in your browser: ${base}`);
  }
}

export async function init(cliPath: string): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || process.argv.includes("--print")) {
    // Not at a keyboard (or --print): just show how to wire an app by hand.
    // `monomem mcp` (the installed bin), not an absolute path into the package: that path changes on every update.
    console.log("Wire monomem into your agent (local, over stdio):\n");
    console.log("Claude Code:");
    console.log("  claude mcp add monomem -- monomem mcp\n");
    console.log("Claude Desktop / Cursor — add to the MCP config:");
    console.log(JSON.stringify({ mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } }, null, 2));
    console.log("\nVS Code / Copilot (.vscode/mcp.json):");
    console.log(JSON.stringify({ servers: { monomem: { type: "stdio", command: "monomem", args: ["mcp"] } } }, null, 2));
    console.log("\nNot installed globally? Use npx instead: command \"npx\", args [\"-y\", \"monomem\", \"mcp\"].");
    console.log("Easier: run  monomem init  in a terminal and I will do it with you, or  monomem connect <app>.");
    console.log("See INSTALL.md for every client, and INFRA.md to reach your phone.");
    return;
  }
  const { detectClients, realEnv } = await import("../setup.js");
  const { PACKAGE_VERSION } = await import("../config.js");
  const e = realEnv(PACKAGE_VERSION, cliPath);
  const here = detectClients(e).filter((c) => c.present && c.id !== "project");
  console.log("Welcome to Monomem. It gives your AI apps one shared memory that lives on this computer.\n");
  if (here.length === 0) {
    console.log("I did not find any supported app on this computer. That is fine:");
    console.log("  - Install one (for example Claude Code or Cursor) and run  monomem init  again, or");
    console.log("  - Run  monomem connect claude-code  (or another app name) to create its settings anyway.");
    console.log("  - Not sure what is wrong? Run  monomem check --setup.");
    return;
  }
  console.log("Apps I found:");
  here.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
  const answer = (await terminalIO().ask("\nWhich ones should use Monomem? Type numbers separated by commas, or press Enter for all: ")).trim();
  let chosen = here;
  if (answer) {
    const picks = new Set(answer.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= here.length));
    if (picks.size === 0) {
      console.log("I did not understand that, so nothing was changed. Run  monomem init  again and type, for example,  1,2");
      return;
    }
    chosen = here.filter((_, i) => picks.has(i + 1));
  }
  const keep = (await terminalIO().ask("Should any of these apps be kept away from your private notes? (y/N) ")).trim().toLowerCase().startsWith("y");
  const restrictedIds = new Set<string>();
  if (keep) {
    const { HTTP_CAPABLE } = await import("../setup.js");
    const names = (await terminalIO().ask(`Which ones? Type numbers from the list above (${chosen.map((c) => here.indexOf(c) + 1).join(", ")}): `)).trim();
    for (const n of names.split(/[,\s]+/).map(Number)) {
      const c = here[n - 1];
      if (c && chosen.includes(c)) restrictedIds.add(c.id);
    }
    for (const id of restrictedIds) if (!HTTP_CAPABLE.includes(id)) console.log(`(${id}: I cannot write a limited connection into its settings automatically; I will show you what to paste instead.)`);
  }
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[]): number => {
    const self = selfCommand(args, { ...selfFacts(), cliPath });
    return spawnSync(self.command, self.args, { stdio: "inherit" }).status ?? 1;
  };
  for (const c of chosen) {
    console.log(`\n--- ${c.label} ---`);
    if (restrictedIds.has(c.id)) run(["connect", c.id, "--restricted", "--yes"]);
    else run(["connect", c.id, "--yes"]);
  }
  console.log("\nAll set.");
  console.log("  Try it:  in one app say \"remember that I like green tea\", then in another ask \"what do I like to drink?\"");
  console.log("  See it:  monomem open        (opens your notes in the browser)");
  console.log("  Undo it: monomem uninstall reverses every app; monomem setup --undo reverses only the last one");
}

// `monomem setup`: see setup.ts.
export async function setupCmd(cliPath: string): Promise<void> {
  const { runSetup, realEnv, DEFAULT_OPTIONS } = await import("../setup.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["only", "db", "command"],
    bools: ["dry-run", "yes", "undo", "hook", "no-hook", "capture", "no-capture", "project", "no-test-note", "no-doctor", "force-empty", "terse", "no-embeddings", "path", "no-path", "taint-gate"],
  });
  const command = str(flags.command) ?? "auto";
  if (!["auto", "node", "npx"].includes(command)) {
    console.error("--command must be auto, node or npx");
    process.exit(1);
  }
  if (flags.hook === true && flags["no-hook"] === true) {
    console.error("Choose one of --hook and --no-hook");
    process.exit(1);
  }
  if (flags.path === true && flags["no-path"] === true) {
    console.error("Choose one of --path and --no-path");
    process.exit(1);
  }
  if (flags.capture === true && flags["no-capture"] === true) {
    console.error("Choose one of --capture and --no-capture");
    process.exit(1);
  }
  const { PACKAGE_VERSION } = await import("../config.js");
  const e = realEnv(PACKAGE_VERSION, cliPath);
  process.exitCode = await runSetup(e, terminalIO(), {
    ...DEFAULT_OPTIONS,
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    undo: flags.undo === true,
    hook: flags.hook === true ? "yes" : flags["no-hook"] === true ? "no" : "ask",
    capture: flags.capture === true ? "yes" : flags["no-capture"] === true ? "no" : "ask",
    path: flags.path === true ? "yes" : flags["no-path"] === true ? "no" : "ask",
    project: flags.project === true,
    noTestNote: flags["no-test-note"] === true,
    noDoctor: flags["no-doctor"] === true,
    forceEmpty: flags["force-empty"] === true,
    terse: flags.terse === true,
    taintGate: flags["taint-gate"] === true,
    only: str(flags.only)?.split(",").map((x) => x.trim()).filter(Boolean),
    db: str(flags.db),
    command: command as "auto" | "node" | "npx",
    // C22: offered only when a local Ollama already has nomic-embed-text; --no-embeddings and --undo skip the probe.
    embeddings: flags["no-embeddings"] !== true && flags.undo !== true && (await (await import("../embeddings-offer.js")).localEmbeddingsAvailable(process.env)),
  });
}
