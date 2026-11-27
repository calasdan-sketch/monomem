// Prompt-injection evasions the English patterns in lint.ts miss (expert round 1, 2026-11-18). Three families:
//
//   1. the same "ignore previous instructions" / "do not tell the user" in Spanish, French, German and Portuguese;
//   2. a base64 or hex blob that DECODES to text the injection patterns hold (one level of decoding only);
//   3. a paraphrased standing instruction aimed at the agent ("from now on, whenever the user asks X, first do Y and do not
//      mention it", "always ... without telling the user"). A standing marker alone is NOT enough: "always run tests before
//      commit" is an ordinary project rule. It is held only when the same stretch of text also tells the agent to hide
//      something from the user, to send data to an outside address, or to run code fetched from a remote address.
//
// Pattern matching, not understanding. Still missed (published in SECURITY.md): other languages, rot13 / percent-encoding /
// double encoding / base64 split across lines, a persistent instruction that never says to hide or send anything,
// and anything paraphrased past these word lists. Text arrives here already run through normalizeForScan (NFKC, invisible
// characters dropped, confusable Cyrillic / Greek / small-capital letters folded to Latin, one whitespace character per run).
// Every window is bounded, so the cost stays linear in the text length.

/** Accents off, \u00df -> ss, so "pr\u00e9c\u00e9dentes" / "fr\u00fcheren" / "instru\u00e7\u00f5es" match plain-ASCII patterns. */
export function stripAccents(t: string): string {
  return t.normalize("NFD").replace(/\p{M}+/gu, "").replace(/\u00df/g, "ss");
}

const Q = (words: string) => String.raw`(?:(?:${words})\s+){0,3}`;
/** verb + optional quantifier/determiner words + (adjective noun | noun adjective). */
function override(verbs: string, quant: string, adjs: string, nouns: string): RegExp {
  return new RegExp(
    String.raw`\b(?:${verbs})\s+${Q(quant)}(?:(?:${adjs})\s+(?:${nouns})|(?:${nouns})\s+(?:${adjs}))\b`,
    "i"
  );
}

const OVERRIDE_BY_LANGUAGE: RegExp[] = [
  // Spanish
  override(
    "ignora|ignore|ignorad|olvida|olvide|omite|descarta|desobedece|salta|saltate",
    "todas?|todo|cualquier|cada|las|los|tus|sus|mis|estas?|esas?",
    "anteriores|previas?|previos?|precedentes|originales|de\\s+arriba|del\\s+sistema",
    "instrucciones|indicaciones|ordenes|reglas|directrices|directivas|restricciones|mensajes|prompts?"
  ),
  /\b(?:ignora|olvida|descarta|omite)\s+todo\s+lo\s+(?:anterior|que\s+(?:te\s+)?(?:dijeron|dijo|han\s+dicho|te\s+han\s+dicho))\b/i,
  // French
  override(
    "ignore|ignores|ignorez|oublie|oubliez|neglige|negligez",
    "toutes?|tous|les|des|tes|vos|ces|ses|l'ensemble\\s+des",
    "precedentes?|anterieures?|prealables?|ci-dessus|d'origine|du\\s+systeme",
    "instructions?|consignes?|regles?|directives?|ordres|messages|prompts?|restrictions"
  ),
  /\b(?:ignore|ignores|ignorez|oublie|oubliez)\s+tout\s+ce\s+(?:qui\s+(?:precede|a\s+ete\s+dit)|que\s+(?:l'on\s+|on\s+)?(?:t'a|vous\s+a|t'ont|vous\s+ont)\s+(?:dit|ete\s+dit))\b/i,
  // German (word endings vary: vorherigen / vorherige; "Systemanweisungen")
  override(
    "ignoriere|ignorier|ignorieren|ignoriert|vergiss|vergesse|vergessen|missachte|missachten|ubergehe|uberspringe",
    "alle|alles|die|deine|diese|samtliche|jegliche|samtlichen|jegliches",
    "vorherigen|vorherige|vorigen|vorige|fruheren|fruhere|bisherigen|bisherige|obigen|obige|vorangegangenen|vorangegangene|vorangehenden|vorhergehenden|ursprunglichen|ursprungliche",
    "(?:system)?anweisungen?|instruktionen|befehle|befehlen|regeln|vorgaben|richtlinien|anordnungen|hinweise|hinweisen|(?:system)?prompts?"
  ),
  /\b(?:vergiss|vergesse|ignoriere)\s+(?:alles|alle)\s+(?:davor|zuvor|vorher|bisherige\w*)\b/i,
  // Portuguese
  override(
    "ignore|ignora|ignorar|ignorem|esqueca|esquece|desconsidere|desconsidera|desconsiderar|descarte|descarta|despreze|desobedeca",
    "todas?|todos|as|os|suas|tuas|seus|teus|minhas|essas|estas|quaisquer|qualquer",
    "anteriores|previas?|previos|precedentes|originais|acima|do\\s+sistema",
    "instrucoes|instrucao|orientacoes|ordens|regras|diretrizes|diretivas|restricoes|mensagens|prompts?|comandos"
  ),
  /\b(?:ignore|ignora|esqueca|esquece|desconsidere)\s+tudo\s+(?:o\s+)?que\s+(?:foi\s+dito|esta\s+acima|te\s+disseram|lhe\s+disseram)\b/i,
];

const HIDE_BY_LANGUAGE: RegExp[] = [
  // Spanish: "no le digas nada al usuario", "sin avisar al usuario"
  /\bno\s+(?:le\s+|les\s+|se\s+lo\s+)?(?:digas|diga|cuentes|cuente|menciones|mencione|informes|informe|avises|avise|reveles|revele)\s+(?:nada\s+)?(?:al|a\s+la|a\s+los)\s+(?:usuario|usuaria|persona|propietario|dueno|duena)\b/i,
  /\bsin\s+(?:decirle|avisar|informar|notificar|contarle|decir)(?:le)?\s+(?:nada\s+)?(?:al|a\s+la)\s+(?:usuario|usuaria|propietario|dueno)\b/i,
  // French: "ne dis rien \u00e0 l'utilisateur", "sans en informer l'utilisateur"
  /\bne\s+(?:le\s+|lui\s+|leur\s+)?(?:dis|dites|dire|mentionne|mentionnez|revele|revelez|signale|signalez|informe|informez)\s+(?:rien|pas|jamais)\s+(?:a|au|aux)\s+(?:l['\u2019]\s?|la\s+|les\s+)?(?:utilisat\w+|personne|proprietaire)/i,
  /\bsans\s+(?:en\s+|le\s+)?(?:informer|avertir|prevenir|notifier|dire)(?:\s+a)?\s+(?:l['\u2019]\s?|la\s+)?(?:utilisat\w+|proprietaire)/i,
  // German: "sage dem Benutzer nichts", "ohne den Benutzer zu informieren"
  /\b(?:sage|sag|erzahle|erzahl|verrate|erwahne|informiere)\s+(?:es\s+|dies\s+|das\s+)?(?:dem\s+|den\s+)?(?:benutzer|nutzer|anwender|user)\w*\s+(?:nichts|nicht|kein)/i,
  /\bohne\s+(?:(?:den|dem)\s+)?(?:benutzer|nutzer|anwender|user)\w*\s+(?:zu\s+)?(?:informieren|benachrichtigen|bescheid|warnen|sagen|verstandigen)/i,
  // Portuguese: "n\u00e3o diga nada ao usu\u00e1rio", "sem avisar o usu\u00e1rio"
  /\bnao\s+(?:lhe\s+|se\s+lo\s+)?(?:diga|conte|mencione|informe|avise|revele)\s+(?:nada\s+)?(?:ao|a|para\s+o)\s+(?:usuario|utilizador|dono|proprietario)\b/i,
  /\bsem\s+(?:avisar|informar|dizer|notificar|contar)\s+(?:ao|o|a)\s+(?:usuario|utilizador|dono)\b/i,
];

/** Label for a non-English override or hide-from-the-user instruction, or null. */
export function scanMultilingual(normalized: string): string | null {
  const t = stripAccents(normalized);
  for (const re of OVERRIDE_BY_LANGUAGE) if (re.test(t)) return "instruction override";
  for (const re of HIDE_BY_LANGUAGE) if (re.test(t)) return "tool-call coercion";
  return null;
}
// ---- Standing instruction + concealment / exfiltration / remote code -------------------------------------------------
const STANDING = String.raw`(?:from\s+now\s+on|going\s+forward|henceforth|hereafter|for\s+the\s+rest\s+of\s+(?:this|the|our)\s+\w+|whenever|every\s+time|each\s+time|any\s+time|always|never|in\s+(?:all\s+|any\s+)?(?:future|later|subsequent|upcoming)\s+(?:sessions?|conversations?|chats?|runs?|tasks?|requests?))`;
// Tells the agent to keep the person in the dark. "don't mention it" counts only as a clause end or "...to the user", so
// "don't mention it in the PR title" does not.
const HIDE = String.raw`(?:without\s+(?:ever\s+)?(?:telling|informing|notifying|alerting|warning|asking|letting)\s+(?:the\s+|your\s+)?(?:user|human|owner|operator|person|anyone)|without\s+(?:ever\s+)?mentioning\s+(?:it|this|that|these)(?:\s+to\s+(?:the\s+|your\s+)?(?:user|human|owner|anyone))?|(?:do\s+not|don'?t|never|no\s+need\s+to|must\s+not|mustn'?t|should\s+not|shouldn'?t)\s+(?:ever\s+)?(?:mention|reveal|disclose|report|surface|say|show)\s+(?:it|this|that|these|any\s+of\s+(?:it|this|that))(?:\s+step)?(?=\s*(?:[.,;!)]|$|\band\b|to\s+(?:the\s+|your\s+)?(?:user|human|owner|anyone|them)\b))|(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|alert)\s+(?:the\s+|your\s+)?(?:user|human|owner|operator|anyone)|hide\s+(?:this|it|that|the\s+\w+)\s+from\s+(?:the\s+|your\s+)?(?:user|human|owner)|keep\s+(?:this|it|that)\s+(?:a\s+)?(?:secret|hidden|between\s+us)|so\s+(?:that\s+)?the\s+user\s+(?:does\s+not|doesn'?t|will\s+not|won'?t|cannot|can'?t)\s+(?:see|notice|know|find\s+out)|(?:silently|secretly|covertly|stealthily|quietly)\s+(?:send|forward|email|upload|post|transmit|exfiltrate|leak|run|execute|install|download|delete)\b)`;
const OUTSIDE = String.raw`(?:https?:\/\/\S+|\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+|\b(?:an?\s+)?(?:external|remote|outside|third[\s-]party)\s+(?:server|url|address|endpoint|host|service|webhook|site)|\bwebhook\b|\bpastebin\b|\bmy\s+server\b)`;
const SENDVERB = String.raw`(?:send|forward|email|e-mail|upload|post|transmit|exfiltrate|leak|share|copy|pipe|submit|append|include)`;
const SENSITIVE = String.raw`(?:secrets?|credentials?|passwords?|tokens?|api[\s_-]?keys?|keys?|\.env|env(?:ironment)?\s+(?:vars?|variables?|files?)|ssh|cookies?|conversations?|chat\s+(?:history|logs?)|history|transcripts?|contents?|files?|code|messages?|data|memor(?:y|ies)|notes?|prompts?|context|everything|(?:the\s+)?user'?s?\s+\w+)`;
const REMOTE_CODE = String.raw`(?:(?:download|fetch|pull|retrieve)\b[^.!?\n]{0,60}?\b(?:script|payload|binary|installer|executable|shell|code|command)s?\b[^.!?\n]{0,60}?\b(?:and|then)(?:\s+then)?\s+(?:run|execute|eval|source)\b|\b(?:run|execute|eval|source)\s+(?:the\s+|this\s+|that\s+|a\s+)?(?:script|command|code|payload|installer|binary|file)\s+(?:from|at)\s+https?:\/\/)`;

// Send-out plus hide in one note needs no standing marker: "should forward every customer email to a@evil.example ... must not mention this step".
const SEND_AND_HIDE = new RegExp(String.raw`\b${SENDVERB}\b[^.!?\n]{0,100}?\b(?:to|at|into|via|through)\s+${OUTSIDE}[^\n]{0,200}?${HIDE}`, "i");

const STANDING_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b${STANDING}\b[^\n]{0,240}?\b${HIDE}`, "i"),
  new RegExp(String.raw`\b${STANDING}\b[^\n]{0,240}?\b${SENDVERB}\b[^.!?\n]{0,80}?\b${SENSITIVE}\b[^.!?\n]{0,80}?\b(?:to|at|into|via|with|through)\s+${OUTSIDE}`, "i"),
  new RegExp(String.raw`\b${STANDING}\b[^\n]{0,240}?\b${REMOTE_CODE}`, "i"),
];

/** "standing order" when a standing instruction also hides something from the user, sends data out, or runs remote code. */
export function scanStandingInstruction(normalized: string): string | null {
  if (SEND_AND_HIDE.test(normalized)) return "standing order";
  if (!/\b(?:from\s+now\s+on|going\s+forward|henceforth|hereafter|for\s+the\s+rest|whenever|every\s+time|each\s+time|any\s+time|always|never|in\s+(?:all\s+|any\s+)?(?:future|later|subsequent|upcoming))\b/i.test(normalized)) return null;
  for (const re of STANDING_PATTERNS) if (re.test(normalized)) return "standing order";
  return null;
}

// ---- Encoded blobs ----------------------------------------------------------------------------------------------------
const B64_RE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const HEX_RE = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2}){14,}(?![0-9A-Za-z])/g;
const MAX_CANDIDATES = 24;
const MAX_DECODED = 65_536;

/** Decoded bytes that read as text (UTF-8, at least 90% printable, some letters and a space), or null: images and keys stay out. */
function asText(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const s = buf.subarray(0, MAX_DECODED).toString("utf8");
  if (s.includes("\ufffd")) return null;
  let printable = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{S}\s]/u.test(ch) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ch)) printable++;
  if (printable / [...s].length < 0.9 || !/\s/.test(s) || (s.match(/\p{L}/gu)?.length ?? 0) < 8) return null;
  return s;
}

/** Decoded text of each long base64 / hex run in `t` (at most MAX_CANDIDATES runs). */
export function decodeBlobs(t: string): string[] {
  const out: string[] = [];
  let n = 0;
  if (/[A-Za-z0-9+/_-]{24}/.test(t)) {
    for (const m of t.matchAll(B64_RE)) {
      if (++n > MAX_CANDIDATES) break;
      const raw = m[0].replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
      if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) continue; // handled as hex below
      const s = asText(Buffer.from(raw, "base64"));
      if (s) out.push(s);
    }
  }
  if (/[0-9a-fA-F]{28}/.test(t)) {
    for (const m of t.matchAll(HEX_RE)) {
      if (++n > MAX_CANDIDATES) break;
      const s = asText(Buffer.from(m[0], "hex"));
      if (s) out.push(s);
    }
  }
  return out;
}

/** Label for an encoded blob whose decoded text the given scanner holds, or null. One level of decoding only. */
export function scanEncodedBlob(rawText: string, scan: (decoded: string) => string | null): string | null {
  for (const d of decodeBlobs(rawText)) if (scan(d)) return "encoded instruction";
  return null;
}
