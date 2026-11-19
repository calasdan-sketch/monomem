// Linter evasions found by the round 2 red team (2026-11-18). Pattern matching again, not understanding: each family below is a
// word list or a text rewrite, and anything paraphrased past them is still missed (published in SECURITY.md).
//
//   1. Text rewrites. The same note is scanned again after: accents and compatibility forms removed (NFKD), bidi / NUL / zero-width
//      / tag characters dropped, HTML entities (&#105;gnore) and percent-escapes (%69gnore) decoded, a word broken by a hyphen at the
//      end of a line joined, letter-spaced words ("i g n o r e") closed up, and dot / underscore / hyphen separated phrases
//      ("ignore.previous.instructions") turned back into words. A rewrite is only built when the text looks like it needs one.
//   2. "ignore previous instructions" and "do not tell the user" in Italian, Dutch, Turkish, Polish, Russian, Chinese, Japanese,
//      Korean, Arabic and Hindi.
//   3. Memory-poison phrasings: "note to assistant", "the user pre-approved", "forget everything before", "stop following your
//      rules", "system override: you must ...". Each needs an instruction-shaped context, so "system override for the thermostat"
//      is an ordinary note.
//   4. Instructions hidden in an HTML comment (only when the comment talks to an AI or tells it to ignore / hide / obey).
//   5. External embeds (iframe, script, CSS @import from an outside host) and links that carry a secret-looking placeholder.
//
// Every window is bounded, so the cost stays linear in the text length.

import { stripAccents } from "./lint-evasion.js";

// ---- 1. Text rewrites ----------------------------------------------------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", sol: "/", colon: ":", period: ".", hyphen: "-", lowbar: "_", comma: ",", excl: "!", semi: ";", lpar: "(", rpar: ")", newline: "\n", tab: "\t",
};
// NUL and other control characters (not tab / line breaks), bidi marks and overrides / isolates, zero-width and joiner characters, the soft
// hyphen, the byte-order mark and the whole TAG block.
const DROP_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿\u{e0000}-\u{e007f}]/gu;

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z]{2,8});)/g, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex as string, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

function decodePercent(s: string): string {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9a-fA-F]{2}){1,64}/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m; // not valid UTF-8: leave as written
    }
  });
}

/** One rewrite of `raw`: controls and invisible characters dropped, entities and percent-escapes decoded (twice, for double
 *  encoding), hyphen-broken words joined, accents and compatibility forms removed. Returns raw itself when nothing changed. */
export function deobfuscate(raw: string): string {
  let s = raw.replace(DROP_RE, "");
  s = decodePercent(decodeEntities(s));
  s = decodePercent(decodeEntities(s));
  s = s.replace(/(\p{L})[-‐‑‒]\s*\r?\n\s*(\p{L})/gu, "$1$2");
  s = s.normalize("NFKD").replace(/\p{M}+/gu, "");
  return s === raw ? raw : s;
}

// Runs of single letters / digits closed up: "i g n o r e". A single separator is dropped; two or more are a word break.
const SPACED_RE = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][ \t._*\-]{1,3}){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;
const COMPACT = /ignore(?:all|any|the|your|my)*(?:previous|prior|above|earlier|preceding|original|system)(?:instructions?|prompts?|rules|directions|guidelines|messages)|disregard(?:all|any|the|your)*(?:previous|prior|above|system)(?:instructions?|prompts?|rules)|donottelltheuser|forgeteverythingbefore/i;

function closeUpSpaced(s: string): { text: string; compact: boolean } {
  let compact = false;
  const text = s.replace(SPACED_RE, (run) => {
    const joined = run.replace(/[ \t._*\-]+/g, (sep) => (sep.length >= 2 ? " " : ""));
    if (COMPACT.test(run.replace(/[ \t._*\-]+/g, ""))) compact = true;
    return joined;
  });
  return { text, compact };
}

const SEPARATED_SEED = /(?:ignore|disregard|forget|override|bypass|system|developer|note|stop|reveal|assistant|agent|auto)[._-]\p{L}/iu;

/** Extra texts to scan with the ordinary patterns. A rewrite is built only when the text looks like it needs one. At most 4. */
export function evasionVariants(raw: string): { variants: string[]; compactHit: boolean } {
  const out: string[] = [];
  let compactHit = false;
  const deob = deobfuscate(raw);
  if (deob !== raw) out.push(deob);
  const base = deob;
  if (/[\p{L}\p{N}][ \t._*\-]{1,3}[\p{L}\p{N}][ \t._*\-]{1,3}[\p{L}\p{N}][ \t._*\-]{1,3}[\p{L}\p{N}]/u.test(base)) {
    const r = closeUpSpaced(base);
    if (r.compact) compactHit = true;
    if (r.text !== base) out.push(r.text);
  }
  if (SEPARATED_SEED.test(base)) out.push(base.replace(/(?<=\p{L}{2})[._-](?=\p{L}{2})/gu, " "));
  return { variants: out, compactHit };
}

// ---- 3. Memory-poison phrasings -----------------------------------------------------------------------------------------------
const AIMED = String.raw`(?:you\s+(?:must|should|will|shall|may\s+now|are\s+now|can\s+now)|ignore\s+(?:all|any|the|your|previous|prior)|disregard|obey|approve\s+(?:all|every|any)|do\s+not\s+(?:tell|ask|warn|mention))`;
const POISON: RegExp[] = [
  // "note to assistant:", "message for the AI", "reminder to future agents" (but not "assistant manager")
  /\b(?:note|message|memo|reminder|instruction|instructions|attention|attn)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+|future\s+|next\s+|other\s+)*(?:assistants?|agents?|ai|llms?|claude|gpt|chatbots?|copilot|language\s+models?)\b(?!\s+(?:manager|director|professor|coach|principal|editor|teacher|supervisor|team|project|group|lab|company|startup|course|tools?|ethics|safety|act|policy))/i,
  // "system override: you must ...", "[SYSTEM OVERRIDE] ignore ..." -- the override must talk to the agent
  new RegExp(String.raw`\bsystem\s+override\b\s*[:\]\-)>]?[^\n]{0,80}?\b${AIMED}\b`, "i"),
  new RegExp(String.raw`\b(?:developer|admin(?:istrator)?|system)\s+(?:message|notice|instruction)s?\s*[:\]\-)>][^\n]{0,80}?\b${AIMED}\b`, "i"),
  // "the user pre-approved", "user has already approved", "the owner auto-approved"
  /\b(?:the\s+)?(?:user|owner|admin(?:istrator)?|operator)\s+(?:has\s+|have\s+|already\s+|previously\s+)*(?:pre-?approved?|pre-?authori[sz]ed?|auto-?approved?|authori[sz]ed\s+in\s+advance|granted\s+(?:blanket|standing|full)\s+(?:approval|permission|consent))\b/i,
  /\b(?:treat|consider|regard|assume)\s+(?:all\s+|any\s+|every\s+)?(?:future\s+|further\s+|later\s+)?(?:requests?|actions?|commands?|tool\s+calls?)\s+as\s+(?:already\s+|pre-?)?(?:approved|authori[sz]ed|confirmed)\b/i,
  /\bauto-?approve\s+(?:everything|all\s+(?:tool\s+calls?|actions?|requests?|commands?))\b/i,
  // "forget everything before this", "forget all you were told earlier"
  /\bforget\s+(?:absolutely\s+)?(?:everything|all|anything)\b[^.!?\n]{0,40}?\b(?:before|above|prior|earlier|previously|so\s+far|you\s+(?:know|were\s+told|learned|have\s+been\s+told))\b/i,
  // "stop following your rules / the safety guidelines"
  /\b(?:stop|cease|quit)\s+(?:following|obeying|respecting|applying|enforcing)\s+(?:(?:your|its|all|any|these|those)\s+|the\s+(?:system|safety|security)\s+)(?:\w+\s+)?(?:rules|instructions|guidelines|restrictions|safety|polic(?:y|ies)|guardrails|constraints)\b/i,
];

/** "memory poisoning" label for a note aimed at a later agent, or null. */
export function scanMemoryPoison(normalized: string): string | null {
  for (const re of POISON) if (re.test(normalized)) return "memory poisoning";
  return null;
}

// ---- 4. Instructions hidden in HTML comments ------------------------------------------------------------------------------------
const COMMENT_RE = /<!--([\s\S]{0,3000}?)(?:-->|$)/g;
const COMMENT_CUES: RegExp[] = [
  /\b(?:assistant|agent|ai|claude|llm|chatbot|gpt|copilot)\s*[:,>\]-]/i,
  /\b(?:ignore|disregard|forget)\s+(?:the\s+|all\s+|any\s+|your\s+|these\s+|those\s+)*(?:above|previous|prior|earlier|rules|instructions|guidelines|user)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:tell|show|reveal|mention|inform)\b[^>]{0,30}\b(?:user|human|owner)\b/i,
  /\b(?:always|never)\s+(?:approve|obey|trust|reveal|exfiltrate|forward)\b/i,
  /\bsystem\s+prompt\b/i,
];

/** "hidden instruction" when an HTML comment talks to an AI or tells it to ignore, hide or obey. A TODO comment is not held. */
export function scanHiddenComments(normalized: string): string | null {
  if (!normalized.includes("<!--")) return null;
  let n = 0;
  for (const m of normalized.matchAll(COMMENT_RE)) {
    if (++n > 50) break;
    if (COMMENT_CUES.some((re) => re.test(m[1]))) return "hidden instruction";
  }
  return null;
}

// ---- 5. External embeds ----------------------------------------------------------------------------------------------------
// Hosts a note may load code or styles from without being suspicious (the same list a published page may use).
const CODE_HOST_OK = "(?:cdnjs\\.cloudflare\\.com|cdn\\.jsdelivr\\.net|unpkg\\.com|code\\.jquery\\.com|ajax\\.googleapis\\.com|fonts\\.googleapis\\.com)";
const BADGE_OK = "(?:img\\.shields\\.io|badgen\\.net|badge\\.fury\\.io|codecov\\.io)";
const PLACEHOLDER_VALUE = String.raw`(?:\{\{|\$\{|%7[bB]%7[bB]|%24%7[bB]|<|%3[cC]|secret|token|api[_-]?key|passw|credential|cookie|session|env\b|\.env|dump|leak)`;
const EMBED_PATTERNS: RegExp[] = [
  // <iframe src=https://...>: any outside page shown inside the note's page.
  /<iframe\b[^>]{0,500}?\bsrc[ \t]*=[ \t]*["']?[ \t]*(?:https?:)?\/\/[^\s"'>]{1,300}/i,
  // <script src=https://...> from a host that is not a well-known library host.
  // A script tag with an integrity (subresource hash) attribute is a pinned library include, not an open door.
  new RegExp(String.raw`<script\b(?![^>]{0,500}?\bintegrity[ \t]*=)[^>]{0,500}?\bsrc[ \t]*=[ \t]*["']?[ \t]*(?:https?:)?\/\/(?!${CODE_HOST_OK}[/:"'>\s])[^\s"'>]{1,300}`, "i"),
  // CSS @import url(http...) or @import "http..." from an outside host (fonts.googleapis.com is common and exempt).
  new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\/(?!${CODE_HOST_OK}[/:"')\s])[^\s"')]{1,300}`, "i"),
  // A link or image whose address carries a {{placeholder}} / ${placeholder} / <placeholder> anywhere after the host.
  new RegExp(String.raw`\]\(\s*<?(?:https?:)?\/\/(?!${BADGE_OK}[/:])[^\s)]{1,200}?(?:\{\{|%7[bB]%7[bB]|\$\{|%24%7[bB])[^\s)]{0,300}\)`, "i"),
  // A link or image whose query asks for a secret-looking value: ?token=SECRET, ?d=<API_KEY>, ?key=${KEY}
  new RegExp(String.raw`\]\(\s*<?(?:https?:)?\/\/(?!${BADGE_OK}[/:])[^\s)#]{1,200}?[?&][\w.-]{1,30}=${PLACEHOLDER_VALUE}[^\s)]{0,300}\)`, "i"),
  // A secret-looking path segment: https://host/collect/<API_KEY> or /collect/{{TOKEN}} or /leak/SECRET_TOKEN
  new RegExp(String.raw`\]\(\s*<?(?:https?:)?\/\/(?!${BADGE_OK}[/:])[^\s)/]{1,100}\/[^\s)]{0,150}?\/(?:<|%3[cC]|SECRET|TOKEN|API[_-]?KEY|PASSWORD|YOUR[_-])[^\s)]{0,200}\)`),
];

/** "external embed" when a note loads an outside page, script or stylesheet, or has a link that carries a secret placeholder. */
export function scanExternalEmbeds(normalized: string): string | null {
  if (!normalized.includes("<") && !normalized.includes("@import") && !normalized.includes("](")) return null;
  for (const re of EMBED_PATTERNS) if (re.test(normalized)) return "external embed";
  return null;
}

// ---- 2. More languages --------------------------------------------------------------------------------------------------------
function ov(verbs: string, quant: string, adjs: string, nouns: string): RegExp {
  const q = String.raw`(?:(?:${quant})\s+){0,3}`;
  return new RegExp(String.raw`\b(?:${verbs})\s+${q}(?:(?:${adjs})\s+(?:${nouns})|(?:${nouns})\s+(?:${adjs}))\b`, "i");
}

// Latin-script languages, run on accent-free text (stripAccents) with dotless i and l-stroke folded.
const LATIN_OVERRIDE: RegExp[] = [
  // Italian
  ov(
    "ignora|ignorate|ignorare|dimentica|dimenticate|dimenticare|trascura|trascurate|scarta|salta",
    "tutte|tutti|tutto|le|gli|i|delle|degli|dei|queste|quelle|ogni|tue|tuoi|vostre|vostri",
    "precedenti|precedente|prima|sopra|originali|originale|di\\s+sistema|passate|anteriori",
    "istruzioni|istruzione|indicazioni|regole|direttive|ordini|messaggi|prompts?|comandi|vincoli|restrizioni"
  ),
  /\b(?:ignora|dimentica)\s+tutto\s+(?:quello|cio)\s+che\b/i,
  /\bnon\s+tenere\s+conto\s+(?:di|delle|degli|dei)\s+(?:tutte\s+le\s+|tutti\s+gli\s+)?(?:istruzioni|regole|indicazioni)\b/i,
  // Dutch
  ov(
    "negeer|negeren|vergeet|vergeten|veronachtzaam",
    "alle|al|de|het|je|jouw|uw|deze|die|elke|elk",
    "vorige|eerdere|voorgaande|bovenstaande|oorspronkelijke|originele|systeem|bestaande",
    "instructies|instructie|opdrachten|regels|richtlijnen|aanwijzingen|prompts?|commandos|beperkingen|berichten"
  ),
  /\b(?:negeer|vergeet)\s+alles\s+(?:wat\s+(?:hierboven|ervoor|eerder)|hierboven|ervoor|eerder)\b/i,
  // Turkish: "onceki tum talimatlari yok say", "yukaridaki talimatlari gormezden gel", "talimatlari unut"
  /\b(?:onceki|yukaridaki|onceden\s+verilen|eski|ilk)\s+(?:(?:tum|butun|bütün|her|bu|su)\s+)*(?:talimat|yonerge|komut|kural|emir|istem|direktif)\w*\s+(?:(?:tamamen|hemen|simdi)\s+)?(?:yok\s+say|gormezden\s+gel|unut|dikkate\s+alma|goz\s+ardi\s+et|iptal\s+et|gecersiz\s+say)\w*/i,
  /\b(?:tum|butun)\s+(?:onceki|yukaridaki)\s+(?:talimat|yonerge|komut|kural|emir|istem)\w*\s+(?:yok\s+say|gormezden\s+gel|unut|dikkate\s+alma|goz\s+ardi\s+et)\w*/i,
  /\b(?:yok\s+say|gormezden\s+gel|unut)\w*\s+(?:(?:tum|butun)\s+)?(?:onceki|yukaridaki)\s+(?:talimat|yonerge|komut|kural|emir)\w*/i,
  // Polish
  ov(
    "zignoruj|ignoruj|zapomnij(?:\\s+o)?|pomin|odrzuc|lekcewaz|zlekcewaz",
    "wszystkie|wszystkich|swoje|twoje|te|tamte|kazde",
    "poprzedni\\w*|wczesniejsz\\w*|powyzsz\\w*|oryginaln\\w*|systemow\\w*",
    "instrukcj\\w*|polecen\\w*|zasad\\w*|wytyczn\\w*|komunikat\\w*|prompt\\w*|rozkaz\\w*|regul\\w*"
  ),
];
const LATIN_HIDE: RegExp[] = [
  /\bnon\s+(?:dire|dirlo|dirgli|menzionare|informare|avvisare|avvertire)\s+(?:nulla\s+|niente\s+)?(?:a|all|al|l)['\s]*\s*utente\b/i,
  /\bsenza\s+(?:dire\s+nulla\s+a|informare|avvisare|avvertire)\s+(?:all'|l'|al\s+)?\s*utente\b/i,
  /\b(?:vertel|zeg|meld)\s+(?:het\s+|dit\s+)?(?:(?:niets|niet)\s+)?(?:aan\s+)?de\s+gebruiker\s+(?:niets|niet)\b/i,
  /\bvertel\s+(?:het\s+|dit\s+)?niet\s+aan\s+de\s+gebruiker\b/i,
  /\bzonder\s+(?:de\s+)?gebruiker\s+(?:te\s+)?(?:informeren|waarschuwen|vertellen|op\s+de\s+hoogte)/i,
  /\bkullanic\w*\s+(?:hicbir\s+sey\s+)?(?:soyleme|bildirme|anlatma|belirtme|haber\s+verme)/i,
  /\bkullanic\w*\s+(?:haberdar\s+etmeden|bilgilendirmeden|soylemeden)/i,
  /\bnie\s+(?:mow|informuj|wspominaj|powiadamiaj|ostrzegaj)\s+(?:nic\s+)?(?:o\s+tym\s+)?uzytkownik\w*/i,
  /\bbez\s+(?:informowania|powiadamiania|wiedzy)\s+uzytkownik\w*/i,
];

// Other scripts, run on light-normalized text (NFKC, invisible characters dropped, lower case; NOT confusable-folded, which
// would turn Russian letters into Latin ones, and not accent-stripped, which would cut Hindi vowel signs).
const OTHER_OVERRIDE: RegExp[] = [
  // Russian
  /(?<![\p{L}])(?:(?<!(?:^|\s)не\s)(?:забудь|забудьте|забыть)|игнорир\p{L}*|не\s+учитывай\p{L}*|пренебреги\p{L}*|отмени\p{L}*|проигнорир\p{L}*)\s+(?:(?:все|всю|весь|любые|любую|свои|твои|ваши|эти|те|мои|любые)\s+){0,3}(?:предыдущ\p{L}*|прошл\p{L}*|прежн\p{L}*|вышеуказанн\p{L}*|исходн\p{L}*|системн\p{L}*|ранее\s+данн\p{L}*|все)\s+(?:(?:все|мои|твои|ваши)\s+)?(?:инструкци\p{L}*|указани\p{L}*|правил\p{L}*|команд\p{L}*|директив\p{L}*|промпт\p{L}*|ограничени\p{L}*|сообщени\p{L}*)/u,
  /(?<![\p{L}])(?:игнорир\p{L}*|забудь|проигнорир\p{L}*)\s+все,?\s+что\s+(?:было\s+)?(?:сказано|написано|говорилось)\s+(?:выше|ранее|раньше|до\s+этого)/u,
  // Chinese (simplified and traditional)
  /(?:忽略|无视|忽视|忘记|忘掉|不要理会|别理会|不理会|不要遵守|无需遵守|無視|忽視|忘記|不要理會|別理會|不要遵守)[^。！？\n]{0,12}?(?:之前|以前|先前|上面|上述|以上|前面|此前|所有|全部|任何|原来|原先|系统|系統|之前的|所有的)[^。！？\n]{0,8}?(?:指令|指示|说明|說明|规则|規則|提示|命令|要求|约束|約束|限制|设定|設定)/u,
  // Japanese
  /(?:以前|前|これまで|上記|先ほど|最初|元|すべて|全て|あらゆる|システム)(?:の|までの)?[^。\n]{0,10}?(?:指示|命令|ルール|指令|プロンプト|制約|ガイドライン|規則)(?:を|は|に|も)?[^。\n]{0,6}?(?:無視|忘れ|従わない|従うな|破棄|取り消|守らない)/u,
  // Korean
  /(?:이전|앞의|위의|기존|원래|모든|이전의|시스템)[^.\n]{0,14}?(?:지시|지침|명령|규칙|프롬프트|제약|지시사항|명령어)[^.\n]{0,8}?(?:무시|잊어|잊으|따르지|어기|무효|따르지\s*마)/u,
  // Arabic (accents and short vowels are already gone after NFD in light(); letters are plain)
  /(?:تجاهل\p{L}*|انس|انسى|اهمل\p{L}*|تخط\p{L}*|لا\s+تتبع|لا\s+تلتزم\s+ب)\s+(?:(?:جميع|كل|كافة|تلك|هذه|اي)\s+){0,3}(?:التعليمات|الاوامر|القواعد|التوجيهات|الارشادات|الرسائل|الاعدادات)\s+(?:السابقة|الاصلية|اعلاه|الاولى|السابقه)/u,
  /(?:تجاهل|انس)\s+كل\s+ما\s+(?:سبق|قيل|ذكر)/u,
  // Hindi (vowel signs tolerated by \p{M}*)
  /(?:पिछले|पिछली|पहले\s+के|पहले\s+की|ऊपर\s+के|ऊपर\s+की|सभी|सारे|सारी|पूर्व)[^।.\n]{0,24}?(?:निर्देश|आदेश|हिदायत|नियम|प्रॉम्प्ट|दिशानिर्देश)\p{M}*[^।.\n]{0,14}?(?:अनदेखा|अनदेखी|भूल|उपेक्षा|नज\p{M}*र\p{M}*अंदाज|ignore|मत\s+मानो|न\s+मानें|न\s+मानो)/u,
];
const OTHER_HIDE: RegExp[] = [
  /не\s+(?:говори|сообщай|рассказывай|упоминай|говорите|сообщайте)\s+(?:об\s+этом\s+|этого\s+)?(?:пользовател\p{L}*|юзер\p{L}*|владельц\p{L}*)/u,
  /без\s+(?:уведомления|ведома|предупреждения|информирования)\s+пользовател\p{L}*/u,
  /(?:不要|别|不可以|不得|切勿|請勿|不要讓|別讓)(?:告诉|告知|通知|提醒|让|告訴|讓)[^。！？\n]{0,6}?(?:用户|使用者|用戶)/u,
  /ユーザー(?:に|には)[^。\n]{0,6}?(?:言わな|伝えな|知らせな|教えな|告げな|秘密)/u,
  /사용자(?:에게|한테)[^.\n]{0,8}?(?:말하지|알리지|숨기|언급하지)/u,
  /لا\s+(?:تخبر|تقل|تذكر|تبلغ)\s+(?:ال)?مستخدم/u,
  /उपयोगकर्ता\s+को\s+(?:मत\s+बताओ|न\s+बताएं|मत\s+बताना|कुछ\s+न\s+बताएं|नहीं\s+बताना)/u,
];

function lightNormalize(raw: string): string {
  return raw
    .replace(DROP_RE, "")
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

function latinFold(light: string): string {
  return stripAccents(light).replace(/ı/g, "i").replace(/ł/g, "l");
}

/** Label for an override or hide-from-the-user instruction in Italian, Dutch, Turkish, Polish, Russian, Chinese, Japanese,
 *  Korean, Arabic or Hindi, or null. `raw` is the text as received. */
export function scanMoreLanguages(raw: string): string | null {
  const light = lightNormalize(raw);
  if (/[^\u0000-\u007f]/.test(light)) {
    for (const re of OTHER_OVERRIDE) if (re.test(light)) return "instruction override";
    for (const re of OTHER_HIDE) if (re.test(light)) return "tool-call coercion";
  }
  const latin = latinFold(light);
  for (const re of LATIN_OVERRIDE) if (re.test(latin)) return "instruction override";
  for (const re of LATIN_HIDE) if (re.test(latin)) return "tool-call coercion";
  // Arabic with its short-vowel marks removed (the marks are \p{M}); Hindi above keeps its marks.
  if (/[؀-ۿ]/.test(light)) {
    const noMarks = light.normalize("NFD").replace(/\p{M}+/gu, "");
    for (const re of OTHER_OVERRIDE) if (re.test(noMarks)) return "instruction override";
    for (const re of OTHER_HIDE) if (re.test(noMarks)) return "tool-call coercion";
  }
  return null;
}
