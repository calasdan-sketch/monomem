// doctor: settings that weaken protection, where keys are kept (and who else can read them), the attestation key.

import type { Doctor } from "./report.js";

/** doctor: settings that weaken protection, plus a data folder a cloud-sync client may copy. Warnings only; the list is shared with `monomem health`. */
async function doctorSecurityChecks(dataDir: string, bindHost: string, warn: (m: string) => void): Promise<void> {
  const { securityFindings } = await import("../health.js");
  for (const f of await securityFindings(dataDir, bindHost)) if (f.status !== "info") warn(f.detail);
}

/** Settings that weaken protection (shared with `monomem health`). */
export async function securityCheck(dr: Doctor): Promise<void> {
  const { warn } = dr;
  const { BIND_HOST, DATA_DIR } = await import("../config.js");
  await doctorSecurityChecks(DATA_DIR, BIND_HOST, warn);
}

/** Where every key file is, and on Windows whether other accounts can read the data folder. */
export async function keyFilesCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { DB_PATH, DATA_DIR } = await import("../config.js");
  const { existsSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  {
    // 1.5.0 (R1-09): where an app key sits on this machine. Said once, plainly; SECURITY.md has the full list.
    const { appKeyFiles, realEnv } = await import("../setup.js");
    // Every key file that exists: the app keys, the encryption key and the signing key (1.5.0 final panel).
    const keyDir = (await import("node:path")).dirname(DB_PATH);
    const { keyPath } = await import("../crypto.js");
    const { attestKeyPath } = await import("../attest.js");
    const files = [...new Set([resolvePath(DATA_DIR, ".token"), resolvePath(DATA_DIR, "tokens.json"), resolvePath(keyPath(keyDir)), resolvePath(attestKeyPath(keyDir)), ...appKeyFiles(realEnv(""))])].filter((f) => existsSync(f));
    if (process.platform === "win32") {
      // 1.5.0 (R1-11): an existing data folder may be open to other accounts on this PC. Read once, here; never on the hot path.
      // On Windows the token file and database get the folder's inherited permissions (chmod does nothing there). Inside
      // the user profile that means "this user only"; elsewhere (D:\, a shared folder) often not. Changing ACLs
      // automatically could break backup or indexing tools, so this says how instead of doing it. One warning, one command
      // (1.5.0 U-15): what icacls reports decides; "outside your user folder" is only the fallback when it cannot be read.
      const { homedir } = await import("node:os");
      const outside = !resolvePath(DATA_DIR).toLowerCase().startsWith(resolvePath(homedir()).toLowerCase() + "\\");
      let checked = false;
      try {
        const { execFileSync } = await import("node:child_process");
        const { wideAccessGroups, lockdownArgs } = await import("../config.js");
        const wide = wideAccessGroups(execFileSync("icacls", [DATA_DIR], { encoding: "utf8", timeout: 15_000, windowsHide: true }));
        checked = true;
        const args = lockdownArgs(DATA_DIR);
        if (wide.length) warn(`the data folder${outside ? " is outside your user folder and" : ""} is also open to ${wide.join(", ")} (other accounts on this PC), so they may be able to read the keys and notes. This does not stop programs running as you.`, args ? `To limit it to you and SYSTEM, run:  icacls "${DATA_DIR}" ${args.slice(1).map((x) => `"${x}"`).join(" ")}` : "Limit the folder's permissions to your own account in its Security tab.");
      } catch {
        /* icacls missing or the folder unreadable: the fallback below */
      }
      if (!checked && outside) {
        warn(
          "the data folder is outside your user folder, so other accounts on this PC may be able to read the keys and notes.",
          `To limit it to you: icacls "${DATA_DIR}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" /remove:g *S-1-5-32-544 *S-1-5-32-545 *S-1-5-11 *S-1-1-0`
        );
      }
    }
    const plainKeys = (await import("../tokens-admin.js")).plainKeyCount();
    if (plainKeys) warn(`${plainKeys} app key(s) are stored in plain text in tokens.json.`, "Run: monomem keys harden  (the apps keep working)");
    if (files.length) ok(`keys are kept in: ${files.join(", ")}. Any program running as you can read these (SECURITY.md lists every place).`);
  }
}

/** The attestation (signing) key, when there is one. */
export async function attestKeyCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { DB_PATH } = await import("../config.js");
  try {
    const { peekSigningKey, attestKeyPath } = await import("../attest.js");
    const { dirname } = await import("node:path");
    const { statSync } = await import("node:fs");
    const kp = attestKeyPath(dirname(DB_PATH));
    if (peekSigningKey(dirname(DB_PATH))) {
      const mode = statSync(kp).mode & 0o077;
      if (process.platform !== "win32" && mode !== 0) warn(`${kp} is readable by other users (it is tightened to 0600 when the server starts)`);
      else ok(`attestation key present (${kp}); back it up with --include-attest-key if you rely on signed exports`);
    }
  } catch {
    /* no key yet */
  }
}
