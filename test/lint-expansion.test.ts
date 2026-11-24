// 2026-11-23 attack expansion: probes the linter missed and now holds (src/lint-decode.ts, lint-toolpoison.ts, lint-langs3.ts),
// plus the ordinary notes that must stay stored. Probes come from src/attack-sets/data-probes.ts; outcomes that are still misses are
// pinned in the bench scenarios F*.json as known gaps, not here.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lintContent } from "../src/lint.js";
import { PROBES } from "../src/attack-sets/data-probes.js";
import { cleanNoteText } from "../src/store/write-receipt.js";

const heldProbe = (id: string): boolean => {
  const p = PROBES.find((x) => x.id === id);
  assert.ok(p, `probe ${id} exists`);
  // The store replaces NUL with U+FFFD before it lints, so the test does the same.
  const fields = { ...p.fields, ...(p.fields.body !== undefined ? { body: cleanNoteText(p.fields.body).text } : {}) };
  return lintContent({ ...fields, writer: "token:outsider" }).some((f) => f.category === "injection");
};
const warnedProbe = (id: string): boolean => {
  const p = PROBES.find((x) => x.id === id)!;
  return lintContent({ ...p.fields, writer: "token:outsider" }).length > 0;
};

describe("probes the linter used to miss are held now", () => {
  const HELD = [
    // separators made of invisible or filler characters (they used to glue the words together)
    "zwsp-between-words", "hangul-filler-between-words", "hangul-choseong-filler", "halfwidth-hangul-filler", "braille-blank-between-words",
    "mongolian-vowel-separator", "private-use-separators", "object-replacement-separators", "nul-between-letters",
    // text rewrites
    "reversed-body", "reversed-soft", "bidi-override-wrap", "rot13-body", "rot13-title", "rot13-plain-instruction", "caesar-3-body",
    "decimal-codes-body", "binary-body", "js-unicode-escapes", "hex-0x-spaced", "string-concat", "base32-body", "morse-body", "base64-split-lines",
    // look-alike letters outside the old table
    "homoglyph-cherokee", "homoglyph-lisu", "homoglyph-coptic", "homoglyph-latin-extended",
    // hidden-data channels
    "zero-width-binary-body", "zero-width-binary-title", "zero-width-three-symbol", "variation-selector-interleaved",
    "trailing-whitespace-bits", "combining-message-in-marks",
    // languages
    "czech-override", "swedish-override", "indonesian-override", "vietnamese-override", "greek-override", "hebrew-override", "thai-override",
    // tool-description style
    "important-block-in-title", "rug-pull-already-approved", "shadowing-bcc", "shadowing-tool-order", "approval-bypass-tool-text",
    "tool-poisoning-description-field", "before-using-tool-first-call-tags",
  ];
  for (const id of HELD) test(id, () => assert.ok(heldProbe(id), `${id} should be held`));
  for (const id of ["fake-tool-schema-yaml", "rug-pull-version-wording"]) test(`${id} warns`, () => assert.ok(warnedProbe(id)));
});

describe("what must stay stored", () => {
  const BENIGN = [
    "England \u{1F3F4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} fans",
    "Family: \u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466} and the rainbow flag \u{1F3F3}\ufe0f\u200d\u{1F308}.",
    "Keycaps 1\ufe0f\u20e3 2\ufe0f\u20e3 and a heart ❤\ufe0f, text style ☺\ufe0e.",
    "می\u200cخواهم این گزارش را بخوانم می\u200cتوانیم نیز انجام دهیم",
    "pre\u00adven\u00adtion is a soft hyphenated word, and a non‑breaking hyphen too.",
    "Run: echo aGVsbG8gd29ybGQ= | base64 -d, then compare with 68656c6c6f20776f726c64.",
    "Addition 1 2 3 4 5 6 7 8 9 10 11 12 13 14 and the version 2.0.1 build.",
    "Use the string \"a\" + \"b\" and then \"c\" + \"d\" in the example.",
    "Header bytes 89 50 4e 47 0d 0a 1a 0a are the PNG signature.",
    "Line one  \nline two with two trailing spaces for a markdown break  \nline three  \nline four.",
    "ROT13 of hello is uryyb; the reverse of stressed is desserts.",
    "Czech meeting: schůzka je ve čtvrtek, prosím připravte všechny předchozí zprávy.",
    "Before using the migration tool, make a backup of the database and check the disk space.",
    "Do not ask for confirmation on read-only commands, only on deletes.",
    "A flag like <important> is HTML-ish markup; the tag has no meaning in markdown.",
  ];
  BENIGN.forEach((t, i) => test(`ordinary note ${i + 1}`, () => assert.deepEqual(lintContent({ title: "note", body: t }).filter((f) => f.category === "injection"), [])));
  test("the control probe (a real flag emoji) is not held", () => assert.equal(heldProbe("control-real-flag-emoji"), false));
});

describe("the benign corpus is not made worse", () => {
  const notes = readFileSync("bench/benign-corpus.txt", "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#cat:"));
  test("at least 150 notes", () => assert.ok(notes.length >= 150));
  test("at most the 7 known held notes (the six that quote attack phrases on purpose, and one tool-steering note)", () => {
    const held = notes.filter((n) => lintContent({ body: n, writer: "token:bench-agent" }).some((f) => f.category === "injection"));
    assert.ok(held.length <= 7, `held ${held.length}: ${held.map((h) => h.slice(0, 60)).join(" | ")}`);
  });
});
