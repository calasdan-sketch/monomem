// Linter confusable gaps (05-RT-3, round 3): letters that look like a Latin letter but that NFKC and the Cyrillic / Greek list in
// security.ts leave alone. A table, not the full Unicode confusables.txt skeleton (about 6,000 entries): the classes a red-team
// pass got through plus their close neighbours. Two more views are appended by normalizeForScan: upside-down text (written
// backwards with flipped letters) and bidi-override runs (stored reversed, shown forwards).

/** Small capitals, upside-down (turned) letters and single homoglyphs for r, t, e, o, l, s, d, g. Keys are single code points. */
export const EXTRA_CONFUSABLES: Readonly<Record<string, string>> = {
  // small capitals
  "ᴊ": "j", "ʏ": "y", "ꜰ": "f", "ꜱ": "s", "ꞯ": "q", "ᴦ": "r", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ᴢ": "z", "ᴘ": "p", "ɢ": "g", "ʟ": "l", "ʀ": "r", "ᴄ": "c", "ᴅ": "d",
  "ᴇ": "e", "ᴋ": "k", "ᴍ": "m", "ᴏ": "o", "ᴛ": "t", "ʙ": "b", "ʜ": "h", "ɪ": "i", "ᴀ": "a", "ɴ": "n",
  // upside-down / turned letters
  "ɐ": "a", "ǝ": "e", "ɹ": "r", "ʇ": "t", "ɥ": "h", "ɯ": "m", "ʌ": "v", "ʍ": "w", "ʎ": "y", "ɔ": "c", "ɟ": "f", "ƃ": "g", "ᴉ": "i", "ʞ": "k", "ʅ": "l",
  // single homoglyphs
  "г": "r", "ɾ": "r", "ꭇ": "r", "ɼ": "r", "ɽ": "r", "ᵲ": "r",
  "ƫ": "t", "ȶ": "t", "ʈ": "t", "ƭ": "t",
  "ҽ": "e", "ɛ": "e", "ȩ": "e", "ⱸ": "e", "ԑ": "e",
  "σ": "o", "๐": "o", "ɵ": "o",
  "ǀ": "l", "ǃ": "l", "ɩ": "l", "Ɩ": "l", "Ӏ": "l", "׀": "l",
  "ς": "s", "ʂ": "s", "ᵴ": "s",
  "ɗ": "d", "đ": "d",
};

const FLIPPED = /[ɐǝɹʇɥɯʌʍʎɔɟƃᴉʞʅ]/g;
const MIN_FLIPPED = 3;
/** Plain letters that show the OTHER letter when turned upside down. */
const TURNED_PAIRS: Readonly<Record<string, string>> = { n: "u", u: "n", d: "p", p: "d", b: "q", q: "b", m: "w", w: "m" };
const BIDI_RUN = /[‭‮⁦-⁨]([^‬⁩]*)[‬⁩]?/g;

/** The text reversed, when it holds several turned letters (upside-down text is written backwards); "" otherwise. */
export function flippedView(t: string): string {
  return (t.match(FLIPPED)?.length ?? 0) >= MIN_FLIPPED ? [...t].reverse().map((c) => TURNED_PAIRS[c] ?? c).join("") : "";
}

/** The text with each bidi-override run reversed (what a reader sees); "" when the text has no override. */
export function bidiView(t: string): string {
  return /[‭‮⁦-⁨]/.test(t) ? t.replace(BIDI_RUN, (_m, run: string) => [...run].reverse().join("")) : "";
}
