// doctor: the opt-in action guard (action-guard.ts). A guard that cannot fire (no capture hooks) or that let an action through
// on an error must not look fine (r4 ease N7, silent L1).

import type { Doctor } from "./report.js";

export async function actionGuardCheck(dr: Doctor): Promise<void> {
  try {
    const { realEnv } = await import("../setup.js");
    const { PACKAGE_VERSION, DATA_DIR } = await import("../config.js");
    const { actionGuardStatus } = await import("../action-guard-setup.js");
    for (const l of actionGuardStatus(realEnv(PACKAGE_VERSION, dr.cliPath), DATA_DIR)) {
      if (l.kind === "warn") dr.warn(l.text, l.fix);
      else if (l.kind === "ok") dr.ok(l.text);
      else console.log(`  [info] ${l.text}`);
    }
  } catch {
    /* Claude Code's settings could not be inspected: claudeHookCheck already says so */
  }
}
