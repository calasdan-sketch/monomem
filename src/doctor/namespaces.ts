// doctor: server-side namespace resolution (spaces config).

import type { Doctor } from "./report.js";

/** The spaces config is valid, its paths exist, and what this folder resolves to. */
export async function namespaceCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { DATA_DIR } = await import("../config.js");
  // Server-side namespace resolution (opt-in): validate the spaces config
  // and report this directory's resolved namespace.
  const {
    loadNamespaceConfig,
    namespaceConfigSource,
    validateSpacePaths,
    resolveNamespace,
  } = await import("../namespace.js");
  const nsSource = namespaceConfigSource();
  if (nsSource) {
    const nsWhere = nsSource === "env" ? "MONOMEM_SPACES" : `${DATA_DIR}/spaces.json`;
    const nsCfg = loadNamespaceConfig();
    if (!nsCfg) {
      warn(`namespace config present (${nsWhere}) but invalid -- resolution disabled`);
    } else {
      const n = Object.keys(nsCfg.spaces).length;
      const missing = validateSpacePaths(nsCfg);
      if (missing.length === 0) {
        ok(`namespace resolution: ${n} space(s) configured, all paths exist`);
      }
      for (const p of missing) {
        warn(
          `namespace space path missing on disk: ${p} — create the directory, ` +
            `or remove the space from ${nsWhere}`
        );
      }
      try {
        const here = resolveNamespace(process.cwd(), nsCfg);
        ok(`namespace resolution: this directory -> "${here}"`);
      } catch (e) {
        warn("namespace resolution: " + (e as Error).message);
      }
    }
  }
}
