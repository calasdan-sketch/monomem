// The undo record of `monomem check --setup --fix`: an append-only file of JSON lines. A step is written BEFORE the change it
// can undo, so a crash, Ctrl+C or a failure half way still leaves the way back; a later run adds lines and never rewrites the
// earlier ones; undo marks each step as undone the moment it is, so running it twice does nothing the second time.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInside } from "./folder-guard.js";

export const FIX_LOG = "doctor-fix-log.jsonl";

export interface UndoStep {
  kind: "acl-restore" | "move-back";
  /** acl-restore: the saved permissions file; move-back: the moved file. */
  a: string;
  /** acl-restore: the folder to restore into; move-back: the file's old place. */
  b: string;
}
export type FixLogLine = { rec: "step"; seq: number; at: string; fix: string; step: UndoStep } | { rec: "undone"; seq: number; at: string };
export interface PendingStep { seq: number; fix: string; step: UndoStep }

export function appendLine(fixDir: string, line: FixLogLine): void {
  mkdirSync(fixDir, { recursive: true });
  appendFileSync(join(fixDir, FIX_LOG), JSON.stringify(line) + "\n", { mode: 0o600 });
}

/** Every line that parses; the number of lines that did not (a half-written last line after a crash). */
export function readLog(fixDir: string): { lines: FixLogLine[]; bad: number } {
  const file = join(fixDir, FIX_LOG);
  if (!existsSync(file)) return { lines: [], bad: 0 };
  const lines: FixLogLine[] = [];
  let bad = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw) as FixLogLine;
      if ((o.rec === "step" && typeof o.seq === "number" && o.step && typeof o.step.a === "string" && typeof o.step.b === "string") || (o.rec === "undone" && typeof o.seq === "number")) lines.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

/** The next free step number. */
export const nextSeq = (fixDir: string): number => readLog(fixDir).lines.reduce((m, l) => Math.max(m, l.seq), 0) + 1;

/** Steps not undone yet, newest first (undo runs backwards). */
export function pendingSteps(fixDir: string): { steps: PendingStep[]; bad: number } {
  const { lines, bad } = readLog(fixDir);
  const done = new Set(lines.filter((l) => l.rec === "undone").map((l) => l.seq));
  const steps = lines.flatMap((l) => (l.rec === "step" && !done.has(l.seq) ? [{ seq: l.seq, fix: l.fix, step: l.step }] : [])).reverse();
  return { steps, bad };
}

const same = (x: string, y: string): boolean => isInside(x, y) && isInside(y, x);

/** A recorded step is trusted only when its paths lie where this tool puts them: the saved or moved file in the fix folder, the target in a Monomem folder. */
export function stepPathsOk(s: UndoStep, fixDir: string, dataDir: string, roots: string[]): boolean {
  if (!isInside(fixDir, s.a)) return false;
  return s.kind === "acl-restore" ? same(s.b, dirname(dataDir)) : roots.some((r) => isInside(r, s.b));
}
