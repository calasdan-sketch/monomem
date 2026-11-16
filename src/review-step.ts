// 1.5.0 (R1-21): `monomem review --step` — one typed yes at the start (the operator gate, in cli.ts), then one note at a
// time: y = confirm as a person, n = skip, q = stop. Nothing else changes. Text is printed through printable().
import type { ReviewItem, Store } from "./store.js";
import { printable } from "./security.js";

export interface StepIO {
  /** One answer line; null = end of input (stops like q). */
  ask: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}
export interface StepResult {
  confirmed: number;
  skipped: number;
  left: number;
}

const PREVIEW_CHARS = 300;

export async function reviewSteps(store: Store, items: ReviewItem[], io: StepIO, source = "reviewed with monomem review --step"): Promise<StepResult> {
  const res: StepResult = { confirmed: 0, skipped: 0, left: 0 };
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const body = store.read(r.id)?.body ?? ""; // gate-ok: local CLI, the operator owns the database file
    io.print("");
    io.print(`(${i + 1} of ${items.length}) #${r.id} [${printable(r.namespace, 100)}] ${printable(r.title, 120)} (by ${printable(r.writer || "unknown", 100)})`);
    io.print(`  why: ${printable(r.why, 300)}`);
    if (body) io.print(`  text: ${printable(body.replace(/\s+/g, " "), PREVIEW_CHARS)}`);
    let answer: string | null = "";
    for (;;) {
      answer = await io.ask("Confirm this note? [y]es / [n]o, skip / [q]uit: ");
      answer = answer === null ? null : answer.trim().toLowerCase();
      if (answer === null || ["y", "yes", "n", "no", "q", "quit"].includes(answer)) break;
      io.print("Type y, n or q.");
    }
    if (answer === null || answer.startsWith("q")) {
      res.left = items.length - i;
      break;
    }
    if (answer.startsWith("n")) {
      res.skipped++;
      continue;
    }
    const c = store.confirm(r.id, { source });
    if (c?.counted) res.confirmed++;
    else {
      res.skipped++;
      if (c) io.print(`  ${printable(c.message, 300)}`);
    }
  }
  io.print(`\n${res.confirmed} confirmed, ${res.skipped} skipped, ${res.left} left.`);
  return res;
}
