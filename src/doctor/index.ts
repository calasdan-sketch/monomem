// `monomem doctor`: a list of small checks, run in order, then a verdict. Each area has its own file; a new check is a
// function in its own file added to CHECKS below. Moved out of cli.ts (it was one 580-line function) without changing
// what it prints.

import { newDoctor, type Doctor } from "./report.js";
import { nodeCheck, dataDirCheck } from "./runtime.js";
import { databaseCheck } from "./database.js";
import { securityCheck, keyFilesCheck, attestKeyCheck } from "./keys.js";
import { preUpgradeCopiesCheck } from "./backups.js";
import { distrustCheck, tokenCheck, tokensFileCheck, appKeysCheck } from "./tokens.js";
import { namespaceCheck } from "./namespaces.js";
import { recallHookCheck, claudeHookCheck, appEntriesCheck } from "./hooks.js";
import { captureCheck } from "./capture.js";
import { serverCheck } from "./server.js";

/** The checks, in the order their lines are printed. Later checks read facts earlier ones put on `d`. */
export const CHECKS: ReadonlyArray<(d: Doctor) => Promise<void>> = [
  nodeCheck,
  dataDirCheck,
  databaseCheck,
  securityCheck,
  keyFilesCheck,
  preUpgradeCopiesCheck,
  attestKeyCheck,
  distrustCheck,
  tokenCheck,
  tokensFileCheck,
  appKeysCheck,
  namespaceCheck,
  recallHookCheck,
  claudeHookCheck,
  appEntriesCheck,
  captureCheck,
  serverCheck,
];

/** No data folder, no database and no 1.0.x data to move in: say "not set up" (exit 1) instead of creating a fresh store. */
export async function notSetUp(): Promise<boolean> {
  const { DATA_DIR, DB_PATH, LEGACY_DATA_DIR } = await import("../config.js");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (existsSync(DATA_DIR) || existsSync(DB_PATH) || existsSync(join(LEGACY_DATA_DIR, "state.db"))) return false;
  console.log("monomem doctor\n");
  console.log(`Monomem is not set up here: there is no data folder at ${DATA_DIR}. Set it up with: monomem setup`);
  console.log("(doctor created nothing.)");
  process.exitCode = 1;
  return true;
}

/** `cliPath`: the path of cli.js (app entries and hooks are checked against it). */
export async function doctor(cliPath: string): Promise<void> {
  const { BIND_HOST, API_PORT, MCP_HTTP_PORT, resolveToken, takeNewKeyNotice } = await import("../config.js");
  await import("node:fs");
  await import("node:path");
  await import("../store.js");
  const d = newDoctor(cliPath);
  // The first run of anything that needs the key creates it; doctor reports that in its own line below.
  try {
    resolveToken();
  } catch {
    /* reported below */
  }
  d.keyJustCreated = takeNewKeyNotice();
  console.log("monomem doctor\n");

  // Quiet for a person at a terminal: only the [warn] and [FAIL] lines (with their Fix lines). --verbose, or output that
  // goes to a file, a pipe or a script, prints every check as before.
  const verbose = process.argv.includes("--verbose") || !process.stdout.isTTY;
  const orig = console.log;
  let fine = 0;
  let shown = true;
  if (!verbose) {
    console.log = (...a: unknown[]): void => {
      const tagged = /^\s*(?:\x1b\[\d+m)?\[(ok|info|warn|fail)\]/i.exec(String(a[0] ?? ""));
      if (tagged) {
        shown = /warn|fail/i.test(tagged[1]);
        if (!shown) fine++;
      }
      if (shown) orig(...(a as []));
    };
  }
  try {
    for (const check of CHECKS) await check(d);
  } finally {
    console.log = orig;
  }

  const { warnings, failures } = d;
  if (verbose) console.log(`\n  bind ${BIND_HOST}   api :${API_PORT}   mcp :${MCP_HTTP_PORT}`);
  else console.log(`  ${fine} check(s) passed or are for information only (monomem check --setup --verbose lists them).`);
  console.log(
    "\n" +
      (failures > 0
        ? `Verdict: PROBLEM - ${failures} thing(s) must be fixed${warnings ? `, ${warnings} more worth a look` : ""}. Read the [fail] and [warn] lines above.`
        : warnings > 0
          ? `Verdict: works, but ${warnings} thing(s) are worth a look (see the [warn] lines above).`
          : "Verdict: All good. Nothing needs fixing.")
  );
  if (failures > 0) process.exitCode = 1;
}
