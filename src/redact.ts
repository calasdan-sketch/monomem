// What the capture hooks remove before anything they record reaches the database.
//
//  - stripPrivate: everything between <private> and </private> is dropped (case-insensitive, attributes allowed).
//    Nested blocks are dropped as one; an unclosed <private> drops everything after it (the safe reading: the writer
//    meant to hide the rest); a stray </private> is dropped on its own.
//  - redactSecrets: every credential the memory linter would refuse is replaced with [REDACTED:<label>]. The pattern
//    list is security.ts's (single source of truth), plus the high-entropy heuristic, which the linter only warns on
//    but capture redacts: nobody reviews a captured event before it is stored.
//  - bare random tokens (capture only, the linter does not refuse these): a printed key with no prefix and no name= in
//    front of it, e.g. `cat .token`.
//      REDACTED  a standalone run of 32 or more hex digits (one case, at least one digit and one letter), except exactly 40;
//                a base62/base64url token ([A-Za-z0-9_-], 32+ chars) with upper, lower and digits that flips case at least
//                every 4 characters and has >= 4.3 bits/char of entropy (random keys do; identifiers and words do not).
//      KEPT      git object ids (exactly 40 hex, the length of a commit SHA), abbreviated SHAs and any hex shorter than 32,
//                content digests written sha1:/sha256:/sha384:/sha512: (or with = or -) in front, UUIDs (their dashed
//                groups are short), numbers (digits only), identifiers and joined words (My_Project_v2_Final), paths.
//      Known cost: other 32+ hex ids with no digest prefix (an MD5 checksum, a 64-hex docker container id) are redacted too.
import { SECRET_PATTERNS, hasOpenAiAnthropicKey, hasJwt, hasHighEntropyToken, HIGH_ENTROPY_LABEL, caseFlips, shannonEntropy, ENTROPY_MIN_BITS } from "./security.js";

const PRIVATE_TAG = /<(\/?)private\b[^>]*>/gi;

export function stripPrivate(text: string): string {
  if (!text || !/<\/?private\b/i.test(text)) return text;
  let out = "";
  let depth = 0;
  let last = 0;
  for (const m of text.matchAll(PRIVATE_TAG)) {
    const at = m.index ?? 0;
    if (m[1] === "/") {
      if (depth === 0) {
        out += text.slice(last, at); // a stray close: drop just the tag
      } else if (--depth > 0) {
        continue;
      }
      last = at + m[0].length;
    } else {
      if (depth++ === 0) out += text.slice(last, at);
      last = at + m[0].length;
    }
  }
  return depth > 0 ? out : out + text.slice(last);
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** Candidate tokens for the shape-checked detectors (sk- keys, JWTs, random-looking tokens). */
const TOKEN = /[A-Za-z0-9_.+=/-]{20,}/g;

/** A standalone hex run of 32+ (one case), not preceded by a digest name such as sha256: (see the header for what is kept). */
const BARE_HEX = /(?<![0-9A-Za-z])(?<!sha(?:1|256|384|512)[:=-])(?:[0-9a-f]{32,512}|[0-9A-F]{32,512})(?![0-9A-Za-z])/g;
const RANDOM_TOKEN_LABEL = "random token";
/** A base62/base64url token that looks random as a whole (even when - or _ split it into runs too short for the entropy check). */
function isRandomB64(tok: string): boolean {
  return tok.length >= 32 && /^[A-Za-z0-9_-]+$/.test(tok) && /[A-Z]/.test(tok) && /[a-z]/.test(tok) && /[0-9]/.test(tok) && caseFlips(tok) >= tok.length / 4 && shannonEntropy(tok) >= ENTROPY_MIN_BITS;
}

export interface Redacted {
  text: string;
  /** Labels of what was replaced (empty when nothing was). */
  labels: string[];
}

export function redactSecrets(text: string): Redacted {
  const labels = new Set<string>();
  if (!text) return { text, labels: [] };
  const mark = (label: string): string => {
    labels.add(label);
    return `[REDACTED:${label}]`;
  };
  let t = text.replace(PRIVATE_KEY_BLOCK, () => mark("private key block"));
  for (const [label, re] of SECRET_PATTERNS) {
    if (label === "private key block") continue;
    t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), () => mark(label));
  }
  // Passwords have no shape, so the patterns above miss them. Capture is never reviewed, so here a
  // credential-named value is redacted even when short; the name is kept so the event still reads.
  for (const [re, label] of PASSWORD_PATTERNS) t = t.replace(re, (_m, keep: string) => keep + mark(label));
  t = t.replace(TOKEN, (tok) => {
    if (hasOpenAiAnthropicKey(tok)) return mark("OpenAI/Anthropic key");
    if (hasJwt(tok)) return mark("JWT");
    if (hasHighEntropyToken(tok)) return mark(HIGH_ENTROPY_LABEL);
    if (isRandomB64(tok)) return mark(RANDOM_TOKEN_LABEL);
    return tok;
  });
  t = t.replace(BARE_HEX, (h) => (h.length === 40 || !/[0-9]/.test(h) || !/[a-f]/i.test(h) ? h : mark(RANDOM_TOKEN_LABEL)));
  return { text: t, labels: [...labels] };
}

// Values that are references, not secrets: $VAR, <...>, your_..., xxx, ***, example, placeholder, changeme, already redacted.
const NOT_PLACEHOLDER = String.raw`(?!\$|<|\[REDACTED|your[_-]|xxx|\*\*\*|example|placeholder|changeme)`;
const LITERAL_SECRET = String.raw`(?=[^\s"'\`<>]{0,200}\d)(?=[^\s"'\`<>]{0,200}[A-Za-z])(?![^\s"'\`<>]{0,200}[()])`;
// The prefix also covers names with no separator: PGPASSWORD, dbPassword, clientSecret.
const CRED_NAME = String.raw`(?:[A-Za-z0-9]{1,30}[_-]){0,4}[A-Za-z0-9]{0,30}?(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)`;
// Every repetition is bounded, so hostile input cannot make these slow (see the ReDoS test in lint tests).
const PASSWORD_PATTERNS: [RegExp, string][] = [
  // scheme://user:PASSWORD@host. The user may be empty (redis://:pw@host); the password runs to the
  // LAST @ before the host, so one containing @ is covered whole.
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{0,64}:)[^\s/]{1,128}(?=@[^\s/@]{1,253}(?:[/\s:?#]|$))/gi, "URL password"],
  // Authorization: Bearer/Basic VALUE. A real value has a digit or mixed case; prose
  // ("basic configuration", "bearer responsibilities") has neither.
  // Not /i: the mixed-case test must see real case. The keyword is spelled out in its usual cases instead.
  [/(\b(?:[Bb]earer|[Bb]asic|BEARER|BASIC)[ \t]{1,4})(?:(?=[A-Za-z0-9._~+/=-]{0,400}\d)|(?=[A-Za-z0-9._~+/=-]{0,400}[A-Z])(?=[A-Za-z0-9._~+/=-]{0,400}[a-z]))[A-Za-z0-9._~+/=-]{12,400}/g, "auth header"],
  // curl -u user:PASSWORD / --user user:PASSWORD
  [/((?:^|\s)(?:-u|--user)[ \t]{1,4}[^\s:]{1,64}:)[^\s]{1,128}/g, "password"],
  // --password VALUE / --password=VALUE
  [new RegExp(String.raw`(--?(?:password|passwd|pass|pwd)[ =])` + NOT_PLACEHOLDER + String.raw`[^\s"'\`]{1,200}`, "gi"), "password"],
  // NAME: VALUE / NAME=VALUE (DB_PASS=..., api_key: ...)
  // The value must look like a literal secret: letters AND digits, no call parens. That keeps code
  // (`token = getToken(ctx)`, `apiKey: options.apiKey`) and settings (`max_token=4096`) intact.
  [new RegExp(String.raw`((?<![A-Za-z0-9])` + CRED_NAME + String.raw`["'\`]?[ \t]{0,4}[:=][ \t]{0,4}["'\`]?)` + NOT_PLACEHOLDER + LITERAL_SECRET + String.raw`[^\s"'\`<>]{4,200}`, "gi"), "password"],
  // "my password is VALUE": only when the value has a digit, so "password is required" stays.
  [new RegExp(String.raw`((?<![A-Za-z0-9])(?:pass(?:word|wd|phrase)?|pwd)[ \t]{1,4}is[ \t]{1,4})` + NOT_PLACEHOLDER + String.raw`(?=[^\s]{0,200}\d)[^\s"'\`<>]{4,200}`, "gi"), "password"],
];

/** stripPrivate, then redactSecrets: the one call the capture path makes on every recorded field. */
export function redact(text: string): Redacted {
  return redactSecrets(stripPrivate(text));
}
