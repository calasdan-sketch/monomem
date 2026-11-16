// doctor: Node, SQLite FTS5, and the data folder (where it is, can Monomem write it, old settings and old data).

import type { Doctor } from "./report.js";

/** Node new enough for the built-in SQLite, and an SQLite with FTS5. */
export async function nodeCheck(dr: Doctor): Promise<void> {
  const { ok, fail } = dr;
  const { nodeIsOk, MIN_NODE_TEXT, sqliteHasFts5 } = await import("../setup.js");
  if (nodeIsOk(process.versions.node)) {
    ok("Node " + process.versions.node);
  } else {
    fail("Node " + process.versions.node + ` is too old for the built-in SQLite (need ${MIN_NODE_TEXT} or newer; Node 23.x has no FTS5 at any version).`, "Install Node 22.16+ or 24 LTS from nodejs.org, open a new terminal, and run this again.");
  }
  // Asked, not inferred: a distro or custom build can lack FTS5 at any version,
  // and every search needs it. This is the check that cannot be wrong.
  if (sqliteHasFts5()) {
    ok("SQLite has FTS5 (search works)");
  } else {
    fail("this copy of SQLite has no FTS5, so every search will fail.", "Install Node 22.16+ or 24 LTS from nodejs.org.");
  }
}

/** Where the data folder is and whether Monomem can write to it; old-style settings and old data. */
export async function dataDirCheck(dr: Doctor): Promise<void> {
  const { ok, warn, fail } = dr;
  const { DB_PATH, DATA_DIR, DATA_DIR_SOURCE, LEGACY_DATA_DIR, insideNodeModules } = await import("../config.js");
  const { existsSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  const why =
    DATA_DIR_SOURCE === "env"
      ? "MONOMEM_HOME"
      : DATA_DIR_SOURCE === "checkout"
        ? "git checkout with an existing ./data/state.db — kept as-is; set MONOMEM_HOME to move it"
        : "default";
  ok(`data dir ${DATA_DIR} (${why})`);
  {
    const rawHome = (process.env.MONOMEM_HOME ?? process.env.ONEMEMORY_HOME ?? "").trim();
    if (rawHome && !/^~(?=$|[\\/])/.test(rawHome) && !(await import("node:path")).isAbsolute(rawHome))
      warn(`MONOMEM_HOME is a relative path (${rawHome}), so the data folder depends on where each app starts.`, "Set MONOMEM_HOME to a full path.");
  }
  try {
    const { accessSync, constants: fsc } = await import("node:fs");
    accessSync(DATA_DIR, fsc.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      dr.dataDirWritable = false;
      fail(`Monomem cannot write to its data folder (${DATA_DIR}).`, "This is a permissions problem. Make the folder writable for your user (or run Monomem as the user who owns it), or point MONOMEM_HOME at a folder you can write to.");
    }
  }
  const { MAPPED_LEGACY_ENV } = await import("../legacy-env.js");
  if (MAPPED_LEGACY_ENV.length) {
    warn(
      `old-style setting(s) ${MAPPED_LEGACY_ENV.map((k) => `${k} (from ${k.startsWith("ONEMEMORY_") ? "OneMemory" : "claude-bridge"})`).join(", ")} are being read as MONOMEM_*; they still work. ` +
        "Rename them to MONOMEM_* when convenient (`monomem setup` does this for an old claude-bridge entry)."
    );
  }
  if (insideNodeModules(DB_PATH) || insideNodeModules(DATA_DIR)) {
    warn(
      "your data is inside node_modules — npm update / npx cache cleanup will delete it. " +
        "Set MONOMEM_HOME (or MONOMEM_DB_PATH) to a directory outside the package."
    );
  }
  if (
    resolvePath(LEGACY_DATA_DIR) !== resolvePath(DATA_DIR) &&
    existsSync(`${LEGACY_DATA_DIR}/state.db`) &&
    !process.env.MONOMEM_DB_PATH
  ) {
    warn(`an old 1.0.x database is still at ${LEGACY_DATA_DIR} (migrated copy is in ${DATA_DIR}); delete it when you're happy`);
  }
}
