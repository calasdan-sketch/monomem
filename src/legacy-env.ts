// Side-effect module: this package has been renamed twice, and each rename left settings behind in people's
// shells, shell profiles and MCP client configs.
//
//   claude-bridge  ->  CLAUDE_BRIDGE_*
//   OneMemory      ->  ONEMEMORY_*
//   Monomem        ->  MONOMEM_*        (current)
//
// Anyone who upgrades with an old variable still set would otherwise start on an EMPTY database without a word,
// which for a memory tool is the worst possible failure. So every CLAUDE_BRIDGE_<NAME> and ONEMEMORY_<NAME> is
// read as MONOMEM_<NAME>. The newest name always wins when more than one is set. Nothing is ever written back to
// the environment of other programs: this only fills in missing MONOMEM_* values for this process.
//
// The chain is applied oldest-first so a shell that still has CLAUDE_BRIDGE_DB_PATH set, and nothing newer,
// still lands on MONOMEM_DB_PATH.
//
// Imported first by every entry point and by config.ts, before anything reads process.env.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The data folder under a home directory when MONOMEM_HOME is not set: ~/.onememory (the store from when this package
 * was called OneMemory) IF it holds a state.db and ~/.monomem does not, else ~/.monomem. config.ts (the runtime) and
 * setup.ts both use this, so setup pins exactly the folder the server would open.
 */
export function homeDataDir(home: string, exists: (p: string) => boolean = existsSync): { dir: string; why: "home" | "legacy-home" } {
  const newHome = join(home, ".monomem");
  const oldHome = join(home, ".onememory");
  return !exists(join(newHome, "state.db")) && exists(join(oldHome, "state.db")) ? { dir: oldHome, why: "legacy-home" } : { dir: newHome, why: "home" };
}

/** The name in use now. */
const CURRENT_PREFIX = "MONOMEM_";
/** Retired names, NEWEST FIRST: when someone has both set, the later one wins. */
const LEGACY_PREFIXES = ["ONEMEMORY_", "CLAUDE_BRIDGE_"] as const;

/**
 * Copy each retired <PREFIX><NAME> to MONOMEM_<NAME> where that is unset.
 * Returns the retired names that were actually used (for `doctor`).
 *
 * Each legacy name maps STRAIGHT to the current one rather than hopping along
 * the chain. Hopping would set the intermediate ONEMEMORY_* as a side effect
 * and report a variable as "used" even when the current name was already set
 * and won -- which is misleading in `doctor`, since nothing was taken from it.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const mapped: string[] = [];
  for (const from of LEGACY_PREFIXES) {
    for (const key of Object.keys(env)) {
      if (!key.startsWith(from) || key.length === from.length) continue;
      const value = env[key];
      if (value === undefined || value === "") continue;
      const next = CURRENT_PREFIX + key.slice(from.length);
      if (env[next] === undefined || env[next] === "") {
        env[next] = value;
        mapped.push(key);
      }
    }
  }
  return mapped;
}

/** The old names that were mapped in this process (for `doctor`). */
export const MAPPED_LEGACY_ENV: readonly string[] = applyLegacyEnv();
