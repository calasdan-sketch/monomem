// Attack expansion, 2026-11-23: more text rewrites and hidden-data checks for the write-time linter (the same best-effort pattern
// matching as lint.ts, not a security boundary). Two parts:
//
//   1. decodeVariants(): extra texts to scan with the ordinary injection patterns, built only when the text looks like it needs
//      one: invisible / filler characters read as word breaks (they used to glue words together), reversed text (also what a bidi
//      override shows), ROT13 and other Caesar shifts, decimal / binary / 0x / \u escapes of ASCII, "ig"+"nore" string joins,
//      base32, Morse, base64 broken over lines, and look-alike letters from scripts the main table does not fold.
//   2. scanHiddenData(): a payload with no readable instruction at all, only invisible structure: zero-width binary runs, variation
//      selectors after plain letters, long combining-mark stacks, trailing space / tab bit lines, bidi overrides.
//
// Still missed (published in docs/attack-expansion-2026-11-23.md): pig latin, acrostics, NATO spelling, upside-down text,
// regional-indicator letters, sparse zero-width marks (one per word), and anything reworded past the word lists.
// Every window is bounded and every regex is linear, so the cost stays linear in the text length.

import { decodeBlobs } from "./lint-evasion.js";

// ---- 1. Variants ---------------------------------------------------------------------------------------------------------------
// Characters that render as nothing or as a blank: read as a word break in this variant (the ordinary scan drops them instead).
const BREAKERS = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\u0000\u2800\u3164\uffa0\u115f\u1160\ufffc\ufff9-\ufffb\ufffd]+/gu;
// What normalizeForScan does not already drop: dropped here too, so "i<NUL>g<NUL>n..." (the store turns NUL into U+FFFD) reads as one word.
const EXTRA_DROP = /[\p{Co}\u0000\u2800\ufffc\ufff9-\ufffb\ufffd]+/gu;
const LOOKALIKES: Record<string, string> = {
  // Cherokee, Lisu, Coptic and Latin letters NFKC and the main table leave alone
  Ꭺ: "A", Ᏼ: "B", Ꮯ: "C", Ꭰ: "D", Ꭼ: "E", Ꮐ: "G", Ꮋ: "H", Ꮖ: "I", Ꭻ: "J", Ꮶ: "K", Ꮮ: "L", Ꮇ: "M", Ꮲ: "P", Ꮪ: "S", Ꭲ: "T", Ꮩ: "V", Ꮃ: "W", Ꮓ: "Z",
  ꓮ: "A", ꓐ: "B", ꓚ: "C", ꓓ: "D", ꓰ: "E", ꓝ: "F", ꓖ: "G", ꓧ: "H", ꓲ: "I", ꓙ: "J", ꓗ: "K", ꓡ: "L", ꓟ: "M", ꓠ: "N", ꓳ: "O", ꓑ: "P", ꓒ: "Q", ꓣ: "R", ꓢ: "S", ꓔ: "T", ꓴ: "U", ꓦ: "V", ꓪ: "W", ꓫ: "X", ꓬ: "Y", ꓜ: "Z",
  ⲁ: "a", ⲉ: "e", ⲟ: "o", ⲣ: "p", ⲥ: "c", ⲩ: "y", Ⲁ: "A", Ⲉ: "E", Ⲟ: "O", Ⲣ: "P", Ⲥ: "C",
  ɨ: "i", ǿ: "o", ø: "o", Ø: "O", ƒ: "f", ɓ: "b", ɗ: "d", ɠ: "g", ɦ: "h", ʝ: "j", ƙ: "k", ɱ: "m", ɲ: "n", ƥ: "p", ʂ: "s", ƭ: "t", ʋ: "v", ƴ: "y", ȥ: "z", ᵢ: "i", ᵣ: "r", ₑ: "e", ₒ: "o",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

const shift = (s: string, n: number): string => s.replace(/[a-z]/gi, (c) => { const b = c <= "Z" ? 65 : 97; return String.fromCharCode(((((c.charCodeAt(0) - b - n) % 26) + 26) % 26) + b); });
// "instruct" and "ignore" as they read after a Caesar shift of 1..25: one regex, one pass.
const SHIFTED_HINT = new RegExp(Array.from({ length: 25 }, (_, i) => ["instruct", "ignore", "the user", "previous"].map((w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + i + 1) % 26) + 97)))).flat().join("|"), "i");
const REVERSED_HINT = /erongi|tegrof|dragersid|snoitcurtsni|tcurtsni|resu eht|tpmorp metsys|edirrevo/i;

/** Decoded text when at least 90% of it is printable ASCII / letters with a space and a few letters, else null. */
function readable(s: string): string | null {
  if (s.length < 12 || s.includes("\ufffd")) return null;
  let ok = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{S}\s]/u.test(ch) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ch)) ok++;
  return ok / [...s].length >= 0.9 && /\s/.test(s) && (s.match(/\p{L}/gu)?.length ?? 0) >= 8 ? s : null;
}
const fromBytes = (bytes: number[]): string | null => readable(Buffer.from(bytes).toString("utf8"));

function numericVariants(t: string): string[] {
  const out: string[] = [];
  const dec = /(?:\b\d{2,3}[ ,;]+){7,}\d{2,3}\b/g;
  const bin = /(?:\b[01]{8}\b[ ,;]*){6,}/g;
  const hex = /(?:\b0x[0-9a-fA-F]{2}\b[ ,;]*){6,}/g;
  const esc = /(?:\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}){6,}/g;
  const take = (re: RegExp, bytes: (m: string) => number[]): void => {
    let n = 0;
    for (const m of t.matchAll(re)) {
      if (++n > 8) break;
      const s = fromBytes(bytes(m[0]));
      if (s) out.push(s);
    }
  };
  if (/\d{2,3}[ ,;]+\d{2,3}[ ,;]+\d/.test(t)) take(dec, (m) => m.match(/\d+/g)!.map(Number).filter((n) => n < 256));
  if (/[01]{8}\s*[01]{8}/.test(t)) take(bin, (m) => m.match(/[01]{8}/g)!.map((b) => parseInt(b, 2)));
  if (t.includes("0x")) take(hex, (m) => m.match(/0x([0-9a-fA-F]{2})/g)!.map((h) => parseInt(h.slice(2), 16)));
  if (t.includes("\\u") || t.includes("\\x")) take(esc, (m) => [...m.matchAll(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g)].map((x) => parseInt(x[1] ?? x[2], 16)).filter((n) => n < 256));
  return out;
}

const MORSE: Record<string, string> = Object.fromEntries(Object.entries({ a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--.." }).map(([k, v]) => [v, k]));
function morseVariants(t: string): string[] {
  const out: string[] = [];
  for (const m of [...t.matchAll(/(?:[.\-]{1,5}(?: +\/ +| +|\/)){7,}[.\-]{1,5}/g)].slice(0, 6)) {
    const s = m[0].split(/ *\/ */).map((w) => w.split(/ +/).map((c) => MORSE[c] ?? "").join("")).join(" ");
    if (s.length >= 8) out.push(s);
  }
  return out;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Variants(t: string): string[] {
  const out: string[] = [];
  for (const m of [...t.matchAll(/(?<![A-Za-z0-9])[A-Z2-7]{24,}={0,6}(?![A-Za-z0-9])/g)].slice(0, 12)) {
    let bits = "";
    for (const c of m[0].replace(/=+$/, "")) bits += B32.indexOf(c).toString(2).padStart(5, "0");
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const s = fromBytes(bytes);
    if (s) out.push(s);
  }
  return out;
}

/** Extra texts to scan with the ordinary patterns (at most about 12). A rewrite is built only when the text looks like it needs one. */
export function decodeVariants(t: string): string[] {
  const out: string[] = [];
  if (BREAKERS.test(t)) out.push(t.replace(BREAKERS, " "), t.replace(EXTRA_DROP, ""));
  BREAKERS.lastIndex = 0;
  if (REVERSED_HINT.test(t)) out.push([...t].reverse().join(""));
  const sh = SHIFTED_HINT.exec(t);
  if (sh) {
    const n = Array.from({ length: 25 }, (_, i) => i + 1).find((k) => /^(?:instruct|ignore|the user|previous)$/.test(shift(sh[0].toLowerCase(), k)));
    if (n) out.push(shift(t, n));
  }
  if (/(?:ignore|disregard|forget|override)[A-Z_]/.test(t)) out.push(t.replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (/\p{L}[*_~`]\p{L}[*_~`]\p{L}[*_~`]\p{L}[*_~`]\p{L}/u.test(t)) out.push(t.replace(/(?<=\p{L})[*_~`]+(?=[\p{L}\s]|$)/gu, ""));
  if (t.length < 4000 && /(?:ignore|disregard|forget|override)[_=:.-]/i.test(t)) out.push(t.replace(/[_=:-]+/g, " "));
  out.push(...numericVariants(t), ...morseVariants(t), ...base32Variants(t));
  if ((t.match(/["'`]\s*\+\s*["'`]/g)?.length ?? 0) >= 2) out.push(t.replace(/["'`]\s*\+\s*["'`]/g, ""));
  if (/[A-Za-z0-9+/]{12,}\r?\n[A-Za-z0-9+/]{12,}/.test(t)) out.push(t.replace(/([A-Za-z0-9+/]{12,}={0,2})\r?\n(?=[A-Za-z0-9+/]{12,})/g, "$1"));
  if (LOOKALIKE_RE.test(t)) out.push(t.replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]));
  LOOKALIKE_RE.lastIndex = 0;
  return out.slice(0, 14);
}

/** Decoded blobs (base64 / hex) of a variant: the caller scans them too. */
export const blobsOf = decodeBlobs;

// ---- 2. Hidden data --------------------------------------------------------------------------------------------------------------
const ZW_RUN = /[\u200b-\u200d\u2060-\u2064\ufeff]{8,}/gu;
const VS_ANY = /[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const VS_AFTER_LETTER = /[A-Za-z][\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
const MARK_STACK = /[\u0300-\u036f]{8,}/u;
const TRAILING_BITS = /^.*[ \t]{4,}$/gm;

/** "hidden Unicode text" when the text carries data in invisible structure, else null. */
export function scanHiddenData(t: string): string | null {
  if (/[\u202d\u202e]/.test(t)) return "hidden Unicode text";
  if (/[\u200b-\u200d\u2060-\u2064\ufeff]/.test(t)) {
    for (const m of t.matchAll(ZW_RUN)) if (new Set(m[0]).size >= 2) return "hidden Unicode text";
  }
  if (VS_ANY.test(t) && (t.match(VS_AFTER_LETTER)?.length ?? 0) >= 3) return "hidden Unicode text";
  if (MARK_STACK.test(t)) return "hidden Unicode text";
  if (/[ \t]{4}$/m.test(t) && /\t/.test(t)) {
    let bitLines = 0;
    for (const m of t.matchAll(TRAILING_BITS)) {
      const tail = /[ \t]+$/.exec(m[0])![0];
      if (tail.includes("\t") && tail.includes(" ") && ++bitLines >= 3) return "hidden Unicode text";
    }
  }
  return null;
}
