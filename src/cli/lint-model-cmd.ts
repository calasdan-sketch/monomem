// `monomem check --model [--hold] [--ns <namespace>] [--limit N] [--json]`: ask the local model (lint-model.ts) about every stored note.
// Without --hold it only prints. With --hold it prints the summary first, then a person at a terminal types "yes" before the
// flagged notes are held (flagged, never edited or deleted; `monomem review keep <id>` puts one back).
import readline from "node:readline";
import { parseFlags } from "./shared.js";

export async function lintModelCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["namespace", "ns", "limit"], bools: ["json", "hold"] });
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (rest.length || (limit !== undefined && !(Number.isInteger(limit) && limit > 0))) {
    console.error("Usage: monomem check --model [--hold] [--ns <namespace>] [--limit N] [--json]");
    process.exit(1);
  }
  const { modelLintConfig } = await import("../lint-model.js");
  const cfg = modelLintConfig();
  if (!cfg) {
    console.error("The model second opinion is off. Turn it on with MONOMEM_LINT_MODEL=on, MONOMEM_LINT_MODEL_URL (a server on this PC, e.g. http://localhost:11434) and MONOMEM_LINT_MODEL_NAME (the model). See docs/memory-linter.md.");
    process.exit(1);
  }
  const hold = Boolean(flags.hold);
  if (hold && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error("Refused: --hold needs a person at a terminal to type a confirmation (an agent's shell tool, a script or a pipe is not one). Run the same command in a terminal.");
    process.exit(1);
  }
  const ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const { auditNotes, holdAudit } = await import("../lint-model-run.js");
  const { printable } = await import("../security.js");
  const store = new Store(DB_PATH);
  try {
    const rows = await auditNotes(store, cfg, {
      namespace: ns,
      limit,
      onProgress: (d, t) => {
        if (!flags.json && process.stderr.isTTY) process.stderr.write(`\r  asked the model about ${d} of ${t} notes`);
      },
    });
    if (!flags.json && process.stderr.isTTY) process.stderr.write("\n");
    const flagged = rows.filter((r) => r.verdict?.verdict === "instruction_like");
    const noVerdict = rows.filter((r) => r.verdict === null).length;
    if (flags.json) {
      console.log(JSON.stringify({ model: cfg.model, checked: rows.length, no_verdict: noVerdict, flagged, note: "second opinion from a local model: best-effort, can be wrong or fooled" }, null, 2));
    } else {
      console.log(`Second opinion from a local model (${printable(cfg.model, 60)}), best-effort, can be wrong or fooled. It only ever adds a hold, never clears one.`);
      console.log(`Asked about ${rows.length} note${rows.length === 1 ? "" : "s"}; ${noVerdict} got no usable answer (the model was slow, down or answered badly); ${flagged.length} look instruction-like.`);
      for (const r of flagged.slice(0, 50)) {
        console.log(`  note #${r.id} "${r.title}": ${printable(r.verdict?.reason ?? "", 140)} (${{ hold: "would be held", skip: "pinned, confirmed or already flagged: left as is", none: "" }[r.action]}${r.lintHit ? "; the pattern linter matches it too" : ""})`);
      }
      if (flagged.length > 50) console.log(`  ... and ${flagged.length - 50} more (--json lists all)`);
    }
    const toHold = rows.filter((r) => r.action === "hold").length;
    if (!hold) {
      if (toHold && !flags.json) console.log(`Nothing was changed. Run with --hold to hold ${toHold} of them (you will be asked to confirm).`);
      return;
    }
    if (!toHold) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => rl.question(`Hold ${toHold} note${toHold === 1 ? "" : "s"} (they stay stored and unedited, they just stop going into session start)? Type "yes" to continue: `, resolve));
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.error("Not confirmed; nothing changed.");
      process.exit(1);
    }
    console.log(`Held ${holdAudit(store, rows)} for your review: look with "monomem review", keep one with "monomem review keep <id>".`);
  } finally {
    store.close();
  }
}
