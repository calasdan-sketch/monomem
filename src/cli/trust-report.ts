// `monomem report [--out report.html]`: runs the benchmark and the attack replay now, reads the store's history, writes one HTML file.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DrillFacts, TrustInput } from "../trust-report.js";

export async function collectTrustInput(dbPath: string): Promise<TrustInput> {
  const { runBench } = await import("../bench/index.js");
  const { runDrill, DESIGNED_MISSES } = await import("../drill.js");
  const { PACKAGE_VERSION } = await import("../config.js");
  const { assetsRoot } = await import("../self.js");
  const t = await import("../trust-report.js");
  const { existsSync } = await import("node:fs");
  const { report } = await runBench({});
  let drill: DrillFacts | null = null;
  if (existsSync(dbPath)) {
    const d = await runDrill({ dbPath });
    const n = (v: string): number => d.rows.filter((r) => r.verdict === v).length;
    drill = { attacks: d.attacks, held: n("held"), blocked: n("blocked"), warned: n("warned"), reached: n("reached"), known_misses: d.reached.filter((r) => r.known_miss).map((r) => `${r.id} ${DESIGNED_MISSES[r.id] ?? r.title}`) };
  }
  const root = assetsRoot();
  return { version: PACKAGE_VERSION, date: new Date().toISOString().slice(0, 10), node: process.version, platform: process.platform, bench: report, drill, store: t.readStoreFacts(dbPath), testFiles: t.countTestFiles(root), readmeLimits: t.readReadmeLimits(root) };
}

export async function reportMain(args: string[]): Promise<number> {
  let out = "monomem-report.html";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) out = args[++i];
    else if (args[i].startsWith("--out=")) out = args[i].slice(6);
    else {
      console.error(`Unknown option: ${args[i]}\nusage: monomem report [--out report.html]`);
      return 2;
    }
  }
  try {
    const { DB_PATH } = await import("../config.js");
    const { renderTrustReport } = await import("../trust-report.js");
    console.log("Running the benchmark and the attack replay (about a minute)...");
    const html = renderTrustReport(await collectTrustInput(DB_PATH));
    writeFileSync(resolve(out), html);
    console.log(`Wrote ${resolve(out)}  (one file, no scripts, no note text).`);
    return 0;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
}
