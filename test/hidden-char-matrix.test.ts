// Class 5 of the 2026-11-23 attack expansion: what the real write path does with each hidden or special character, per field.
// kept = stored exactly as sent (the scanners look at a normalised copy, so the text is not changed), altered = the store replaced
// it (NUL and a lone surrogate half become U+FFFD), refused = the write was rejected, held = the write waited in quarantine.
// Pinned so a change in what is stripped, folded, flagged or passed shows up as a failing test. Fields: title, body, tags, source.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { QuarantinedError } from "../src/errors.js";
import { HIDDEN_CHARS } from "../src/attack-sets/data-probes.js";

type Cell = "kept" | "altered" | "refused" | "held";
const EXPECTED: Record<string, [Cell, Cell, Cell, Cell]> = {
  "zero-width-space": ["kept", "kept", "kept", "kept"],
  "zero-width-non-joiner": ["kept", "kept", "kept", "kept"],
  "zero-width-joiner": ["kept", "kept", "kept", "kept"],
  "word-joiner": ["kept", "kept", "kept", "kept"],
  "invisible-times": ["kept", "kept", "kept", "kept"],
  "invisible-separator": ["kept", "kept", "kept", "kept"],
  "invisible-plus": ["kept", "kept", "kept", "kept"],
  "soft-hyphen": ["kept", "kept", "kept", "kept"],
  "bom-zwnbsp": ["kept", "kept", "kept", "kept"],
  "bidi-lre": ["kept", "kept", "refused", "kept"],
  "bidi-rlo": ["kept", "kept", "refused", "kept"],
  "bidi-isolate-lri": ["kept", "kept", "refused", "kept"],
  "bidi-isolate-pdi": ["kept", "kept", "refused", "kept"],
  "left-to-right-mark": ["kept", "kept", "refused", "kept"],
  "arabic-letter-mark": ["kept", "kept", "kept", "kept"],
  "hangul-filler-3164": ["kept", "kept", "kept", "kept"],
  "hangul-filler-115f": ["kept", "kept", "kept", "kept"],
  "braille-blank": ["kept", "kept", "kept", "kept"],
  "mongolian-vs-180e": ["kept", "kept", "kept", "kept"],
  "variation-selector-15": ["kept", "kept", "kept", "kept"],
  "variation-selector-1": ["kept", "kept", "kept", "kept"],
  "ideographic-variation-e0100": ["kept", "kept", "kept", "kept"],
  "tag-letter-e0041": ["held", "held", "held", "held"],
  "tag-cancel-e007f": ["held", "held", "held", "held"],
  "combining-acute": ["kept", "kept", "kept", "kept"],
  "combining-grapheme-joiner": ["kept", "kept", "kept", "kept"],
  "nul": ["altered", "altered", "refused", "kept"],
  "escape-1b": ["kept", "kept", "refused", "kept"],
  "delete-7f": ["kept", "kept", "refused", "kept"],
  "c1-control-85": ["kept", "kept", "refused", "kept"],
  "line-separator-2028": ["kept", "kept", "refused", "kept"],
  "paragraph-separator-2029": ["kept", "kept", "refused", "kept"],
  "private-use": ["kept", "kept", "kept", "kept"],
  "object-replacement": ["kept", "kept", "kept", "kept"],
  "lone-surrogate-high": ["altered", "altered", "kept", "altered"],
};

function run(s: Store, i: number, fields: { title?: string; body?: string; tags?: string[]; source?: string }, same: (n: { title: string; body: string; tags?: string[]; source?: string }) => boolean): Cell {
  try {
    const note = s.create({ namespace: "mx", ...fields, title: fields.title ?? `T${i}` });
    return same(note) ? "kept" : "altered";
  } catch (e) {
    return e instanceof QuarantinedError ? "held" : "refused";
  }
}

test("every hidden character, in every field, behaves as pinned", () => {
  const s = new Store(":memory:");
  try {
    let i = 0;
    assert.deepEqual(Object.keys(EXPECTED), HIDDEN_CHARS.map(([n]) => n));
    for (const [name, ch] of HIDDEN_CHARS) {
      const w = `a${ch}b`;
      const got: Cell[] = [
        run(s, ++i, { title: `Plain ${w} title`, body: "ordinary body" }, (x) => x.title === `Plain ${w} title`),
        run(s, ++i, { body: `Plain ${w} body text` }, (x) => x.body === `Plain ${w} body text`),
        run(s, ++i, { body: "ordinary body", tags: [`t${ch}x`] }, (x) => (x.tags ?? []).includes(`t${ch}x`)),
        run(s, ++i, { body: "ordinary body", source: `src${ch}x` }, (x) => x.source === `src${ch}x`),
      ];
      // Node 22's built-in SQLite cuts a text value at a NUL byte (Node 24 keeps it), so the source field reads "altered" there.
      const want = name === "nul" && Number(process.versions.node.split(".")[0]) < 24 ? ["altered", "altered", "refused", "altered"] : EXPECTED[name];
      assert.deepEqual(got, want, name);
    }
  } finally {
    s.close();
  }
});
