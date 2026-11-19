// doctor: the main key, tokens.json, the app keys and what each may see, and the distrust rules.

import type { Doctor } from "./report.js";

/** Distrust rules only help when agents do not hold the admin key. */
export async function distrustCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  if (dr.distrustCount > 0) {
    // include_distrusted is an ADMIN switch, and the primary token is always admin: an agent wired with it can ask for the
    // notes the policy hides (e.g. after a hostile note talks it into it). Agents should hold a write or read token.
    try {
      const { resolveTokens } = await import("../config.js");
      const scoped = resolveTokens().filter((t) => t.scope !== "admin");
      if (scoped.length === 0) {
        warn(
          `${dr.distrustCount} distrust rule(s) exist, but the only token is the primary one, which is always admin: an agent holding it can pass include_distrusted ` +
            "and read the hidden notes. Give agents a write or read token (MONOMEM_TOKENS / tokens.json, see docs/token-namespaces.md) and keep the primary token off them."
        );
      } else {
        ok(`${dr.distrustCount} distrust rule(s); ${scoped.length} non-admin key(s) configured (keep the main app key off agents)`);
      }
    } catch {
      /* token configuration unreadable: reported below */
    }
  }
}

/** The main key is there (or was just created). */
export async function tokenCheck(dr: Doctor): Promise<void> {
  const { ok, fail } = dr;
  const { resolveToken, TOKEN_FILE } = await import("../config.js");
  const { existsSync } = await import("node:fs");
  if (!existsSync(TOKEN_FILE) && !process.env.MONOMEM_TOKEN?.trim()) {
    dr.ok("no main app key yet. It is made the first time you run monomem setup or monomem start (checking does not create it)");
    return;
  }
  try {
    resolveToken();
    ok(
      `main app key present (${process.env.MONOMEM_TOKEN?.trim() ? "MONOMEM_TOKEN" : TOKEN_FILE})${dr.keyJustCreated ? " - created just now, because this was the first run" : ""}`
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (!dr.dataDirWritable || /EACCES|EPERM|EROFS|permission/i.test(msg)) {
      if (dr.dataDirWritable) fail("token: " + msg, "This looks like a permissions problem with " + TOKEN_FILE + ". Make it readable and writable for your user.");
    } else {
      fail("token: " + msg, "Set MONOMEM_TOKEN to a long random value (monomem keys new prints one), or delete the token file and let Monomem make one.");
    }
  }
}

/** tokens.json can be read. */
export async function tokensFileCheck(dr: Doctor): Promise<void> {
  const { fail } = dr;
  const { DATA_DIR } = await import("../config.js");
  // tokens.json: a file that cannot be read means the apps listed in it do not work (and removing one by hand does nothing).
  try {
    const { existsSync: ex, readFileSync: rf } = await import("node:fs");
    const { join: j } = await import("node:path");
    const tf = j(DATA_DIR, "tokens.json");
    if (ex(tf)) {
      try {
        const parsed = JSON.parse(rf(tf, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("it should hold a list");
      } catch (e) {
        fail(`${tf} cannot be read (${(e as Error).message}), so the apps listed in it cannot connect, and a running server keeps its old list.`, `Open ${tf}, fix or delete it, then run monomem check --setup again. (A backup of the previous version may be at ${tf}.bak.)`);
      }
    }
  } catch {
    /* nothing to check */
  }
}

/** Which apps may connect, and what each may see. */
export async function appKeysCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  // Which apps may connect, and what each may see.
  try {
    const { resolveTokens } = await import("../config.js");
    const apps = resolveTokens().filter((t) => t.label !== "primary");
    const limited = apps.filter((t) => t.max_sensitivity !== undefined);
    ok(`${apps.length} app key(s) besides the main one; ${limited.length} with a limit on what they can see`);
    // An administrator key is trusted by definition, so it is not nagged. A normal key with no limit reads private notes.
    const open = apps.filter((t) => t.max_sensitivity === undefined && t.scope !== "admin");
    if (open.length > 0 && dr.hasLabelled) {
      warn(
        `${open.map((t) => `"${t.label || "(unnamed)"}"`).join(", ")} can read your private notes (no limit is set on ${open.length === 1 ? "its key" : "their keys"}), and you have notes labelled other than internal.`,
        `give each a limit: monomem keys remove <name>, then monomem keys add <name> --max internal   (see docs/give-an-app-limited-access.md)`
      );
    }
    // Apps connected without a key (stdio) can read everything, whatever limits other apps have.
    if (dr.hasPrivate) {
      const { detectClients, realEnv } = await import("../setup.js");
      const { readFileSync } = await import("node:fs");
      const { PACKAGE_VERSION } = await import("../config.js");
      const wired = detectClients(realEnv(PACKAGE_VERSION, dr.cliPath)).filter((c) => {
        try {
          if (!c.exists) return false;
          const t = readFileSync(c.file, "utf8");
          return /"monomem"|\[mcp_servers\.monomem\]/.test(t) && !/Authorization/i.test(t);
        } catch {
          return false;
        }
      });
      if (wired.length) {
        warn(
          `${wired.map((c) => c.label).join(", ")} ${wired.length === 1 ? "is" : "are"} connected without a key, so it can read your private notes (a limit only applies to apps that connect with their own key).`,
          `monomem connect ${wired[0].id} --max internal   (then restart that app). If that app is fine to see everything, ignore this.`
        );
      }
    }
  } catch {
    /* token configuration unreadable: reported above */
  }
}
