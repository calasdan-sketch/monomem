// C-02 (R2-14): a plain line diff, old -> new, for the places a person decides on a change (supersede preview, a held edit).
//
// Each line is "- " (removed), "+ " (added) or "  " (unchanged, or a "... N unchanged lines" fold), so a line never starts with
// note text. Note text is untrusted: every line goes through printable() (control and direction characters become "?") and
// is cut to `width`. The output is capped at `maxLines`.
import { printable } from "./security.js";
import type { Store, QuarantineEntry } from "./store.js";

/** Lines compared per side. ponytail: plain O(n*m) LCS table, fine at this size; Myers if longer texts ever need a diff. */
const MAX_IN = 500;
/** Unchanged lines kept around a change; longer unchanged runs fold into one line. */
const CONTEXT = 1;

const lines = (s: string): string[] => (s === "" ? [] : s.split(/\r\n|\r|\n/));

/** The diff of two texts as printable lines ([] when the text is the same). */
export function lineDiff(oldText: string, newText: string, maxLines = 40, width = 160): string[] {
  const allA = lines(String(oldText ?? ""));
  const allB = lines(String(newText ?? ""));
  const a = allA.slice(0, MAX_IN);
  const b = allB.slice(0, MAX_IN);
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w); // lcs[i*w+j] = longest common run of a[i..] and b[j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const ops: Array<[" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i++]]), j++;
    else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  if (!ops.some((o) => o[0] !== " ")) return [];

  const near = ops.map((_, k) => ops.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some((o) => o[0] !== " "));
  const out: string[] = [];
  for (let k = 0; k < ops.length; ) {
    if (near[k]) {
      const [op, text] = ops[k++];
      out.push(`${op === " " ? " " : op} ${printable(text.replace(/\t/g, "    "), width)}`);
      continue;
    }
    let run = 0;
    while (k < ops.length && !near[k]) run++, k++;
    out.push(`  ... ${run} unchanged line${run === 1 ? "" : "s"}`);
  }
  if (allA.length > MAX_IN || allB.length > MAX_IN) out.push(`  ... only the first ${MAX_IN} lines were compared`);
  return out.length > maxLines ? [...out.slice(0, maxLines), `  ... ${out.length - maxLines} more lines not shown`] : out;
}

/**
 * A held edit's body change: the target note as it is now -> the held text ([] for a new note or an edit that leaves the body
 * alone). For the admin views that already show the held text in full (`quarantine show`, the dashboard's Held card); the
 * target is read through readVisible, as an admin sees it.
 */
export function heldEditDiff(store: Store, q: QuarantineEntry): string[] {
  if (q.op !== "update" || q.target_id === null || q.body === null) return [];
  const target = store.readVisible(q.target_id, { includeDistrusted: true });
  return target ? lineDiff(target.body, q.body) : [];
}
