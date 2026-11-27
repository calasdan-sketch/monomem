// Imported FIRST by retrieval.ts (before anything that loads config.js): point MONOMEM_HOME at a fresh temp folder
// so the retrieval benchmark can never open or write your real data. Every other MONOMEM_* variable is removed
// (lint policy, staleness, tokens...), except the embedding settings the hybrid run needs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) {
  if (k.startsWith("MONOMEM_") && !k.startsWith("MONOMEM_EMBED") && !k.startsWith("MONOMEM_LOCAL_EMBED")) delete process.env[k];
}
export const BENCH_HOME = mkdtempSync(join(tmpdir(), "monomem-retrieval-"));
process.env.MONOMEM_HOME = BENCH_HOME;
process.on("exit", () => rmSync(BENCH_HOME, { recursive: true, force: true }));
