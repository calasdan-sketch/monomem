// doctor: the session-start hook works and is wired, and the connected apps' entries point at a real install.

import type { Doctor } from "./report.js";

/** Run the real session-start path against this database, within its time budget. */
export async function recallHookCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { DB_PATH } = await import("../config.js");
  // Recall hook smoke test: run the real SessionStart path against this
  // database and check the payload shape. Also budget-check it: the hook
  // blocks session start, so a slow recall is worth knowing about.
  // No database yet: running recall would create it (and its keys). Say so instead; setup or start makes it.
  if (DB_PATH !== ":memory:" && !(await import("node:fs")).existsSync(DB_PATH)) {
    ok("recall hook smoke test skipped: there is no database yet (it is made by monomem setup or monomem start)");
    return;
  }
  try {
    const { runRecall } = await import("../recall.js");
    const t0 = Date.now();
    // The hook prints its own failure to stderr; doctor reports it in its own words below.
    const origErr = console.error;
    console.error = (): void => {};
    let out: string;
    try {
      out = await runRecall({ budgetMs: 800, limit: 1, dbPath: DB_PATH });
    } finally {
      console.error = origErr;
    }
    const elapsed = Date.now() - t0;
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string };
    };
    if (dr.dbProblem) {
      // The hook fails silent by design, so its "success" proves nothing here.
      warn("recall hook smoke test FAILED: the database could not be opened (see the database problem above); the hook only looks healthy because it fails silent");
    } else if (parsed?.hookSpecificOutput?.hookEventName === "SessionStart") {
      ok(`recall hook smoke test passed (${elapsed}ms)`);
    } else {
      warn("recall hook returned an unexpected payload shape");
    }
    if (elapsed > 800) {
      warn(`recall hook took ${elapsed}ms — over the 800ms soft budget`);
    }
  } catch (e) {
    warn("recall hook smoke test failed: " + (e as Error).message);
  }
}

/** Whether Claude Code has the session-start and capture hooks. */
export async function claudeHookCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  // Is the hook actually wired into Claude Code? A working `recall` that never fires is the common silent failure.
  // Only worth saying when Claude Code is on this computer, and only a warning if the person has already chosen the hook.
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const { detectClients, realEnv } = await import("../setup.js");
    const { PACKAGE_VERSION } = await import("../config.js");
    const cc = detectClients(realEnv(PACKAGE_VERSION, dr.cliPath)).find((c) => c.id === "claude-code");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let parsed: { hooks?: { SessionStart?: unknown } } = {};
    let haveSettings = true;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof parsed;
    } catch {
      haveSettings = false;
    }
    if (!cc?.present && !haveSettings) {
      console.log("  [info] Claude Code was not found on this computer, so the start-of-session hook was not checked (what it is: https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md)");
    } else {
      const entries = parsed?.hooks?.SessionStart;
      const wired =
        Array.isArray(entries) &&
        /(monomem|onememory|cli\.js)[\s\S]{0,60}\b(recall|hook session-start)\b/.test(JSON.stringify(entries));
      if (wired && /npx\s+(?:-y\s+)?onememory-mcp\b/.test(JSON.stringify(entries))) {
        warn("SessionStart hook is the old onememory-mcp one: old hook, run `monomem setup --hook` to update it");
      } else if (wired) {
        ok("SessionStart hook wired in ~/.claude/settings.json");
      } else {
        console.log(
          "  [info] Claude Code has no monomem start-of-session hook (optional: it shows Claude your recent notes when a session starts; add it with  monomem setup --hook, details: https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md)"
        );
      }
      const captureWired = /(monomem|onememory|cli\.js)[\s\S]{0,60}\bhook post-tool\b/.test(JSON.stringify(parsed?.hooks ?? {}));
      console.log(`  [info] ${captureWired ? "automatic memory hooks wired" : "automatic memory hooks not installed (monomem setup --capture)"}`);
    }
  } catch {
    /* settings could not be inspected: not a problem with Monomem */
  }
}

/** App entries that point at a removed install, and which apps are connected. */
export async function appEntriesCheck(dr: Doctor): Promise<void> {
  const { warn } = dr;
  // An app entry or hook that points at a removed install, or launches another version with npx.
  try {
    const { appEntryProblems, connectedApps, realEnv } = await import("../setup.js");
    const { PACKAGE_VERSION } = await import("../config.js");
    const env = realEnv(PACKAGE_VERSION, dr.cliPath);
    for (const p of appEntryProblems(env)) warn(p, "run monomem setup");
    // The commonest real failure, "my assistant does not see Monomem", must show up here (final3 EASE-SF4).
    const apps = connectedApps(env);
    if (apps.connected.length) console.log(`  [info] connected apps: ${apps.connected.join(", ")}`);
    else if (apps.found.length) warn(`no app is connected to Monomem (found: ${apps.found.join(", ")})`, "monomem setup (or monomem connect <app>)");
    else console.log("  [info] connected apps: none found on this machine (monomem connect <app> when you install one)");
  } catch {
    /* configs could not be inspected: not a problem with Monomem */
  }
}
