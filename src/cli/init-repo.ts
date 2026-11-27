// `monomem init repo [--files AGENTS.md,CLAUDE.md,cursor] [--yes] [--undo]`: the managed memory-loop block (init-block.ts) in this
// repository's rules files. Shows the diff and stops unless --yes. `monomem init` alone is still the app-wiring helper.
import { relative } from "node:path";
import { parseFlags, str } from "./shared.js";

export async function initDispatch(cliPath: string): Promise<void> {
  if (process.argv[3] === "repo") return initRepoCmd(process.argv.slice(4));
  await (await import("./connect.js")).init(cliPath);
}

export async function initRepoCmd(args: string[], cwd: string = process.cwd()): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["files"], bools: ["yes", "undo", "dry-run"] });
  const B = await import("../init-block.js");
  const named = str(flags.files)?.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = [...(named ?? []), ...rest].filter((f) => !(B.INIT_FILES as readonly string[]).includes(f));
  if (bad.length) {
    console.error(`Usage: monomem init repo [--files ${B.INIT_FILES.join(",")}] [--yes] [--undo]   (unknown: ${bad.join(", ")})`);
    process.exitCode = 1;
    return;
  }
  const root = B.findRepoRoot(cwd);
  if (!root) {
    console.error("Refused: run this inside a git repository; it writes only that repository's rules files.");
    process.exitCode = 1;
    return;
  }
  const mode = flags.undo === true ? "undo" : "install";
  const plans = B.chooseFiles(root, named, mode).map((f) => B.planInitFile(root, f, mode));
  const { lineDiff } = await import("../line-diff.js");
  for (const p of plans) {
    if (p.refused) console.log(`REFUSED  ${p.refused}`);
    else if (p.action === "none") console.log(`nothing to do in ${p.rel}${mode === "undo" ? " (no Monomem block)" : ""}`);
    else if (p.action === "unchanged") console.log(`up to date  ${p.rel}`);
    else {
      console.log(`${p.action.toUpperCase()}  ${relative(root, p.abs) || p.rel}`);
      for (const l of lineDiff(p.before ?? "", p.after ?? "", 40, 160)) console.log(`    ${l}`);
    }
  }
  const refused = plans.some((p) => p.refused);
  const changes = plans.filter((p) => !p.refused && ["add", "update", "remove"].includes(p.action));
  if (refused) process.exitCode = 1;
  if (!changes.length) return;
  if (flags.yes !== true || flags["dry-run"] === true) {
    console.log(`\nNothing written. Run again with --yes to ${mode === "undo" ? "remove" : "write"} ${changes.length === 1 ? "this change" : "these changes"}.`);
    return;
  }
  const done = B.applyInitPlans(plans);
  console.log(`\n${mode === "undo" ? "Removed the block from" : "Wrote the block to"}: ${done.join(", ")}${mode === "install" ? "\nTake it out again: monomem init repo --undo --yes" : ""}`);
}
