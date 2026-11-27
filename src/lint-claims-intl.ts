// Claim rules for eight more languages, second pass (r8, 2026-11-26): es fr de pt zh ja ru ar. The first pass (INTL in lint-claims.ts)
// needs its words in one fixed order, so an attack worded in another order (Japanese and German put the verb last) or with a
// different object ("the whole memory", "login details", an IBAN instead of 000-111) passed: 47 of 48 reworded attacks reached the store.
//
// Shape: a rule is 2 or 3 small word lists that must all appear within SPAN characters of each other, in any order. Each list is a
// plain alternation (no nested quantifiers); every match position of every list is found in one linear pass, then the nearest
// partner is looked up by binary search, so the cost is O(n log n) with no cap on the number of matches (a flood of decoy words
// cannot push the real one past a limit). Latin and Arabic text is read without accents and short-vowel marks; Latin words must
// start at a word start so "copies" does not read as French "copie".
//
// What this will NOT catch: a language not listed; a word not in the lists (synonyms, slang, typos); a claim split over two notes or
// spread wider than SPAN; anything an attacker rewords after reading this file. A floor, not a defence (docs/memory-linter.md).

import type { ClaimAction } from "./lint-claims.js";

const SPAN = 160;
const L = (words: string) => String.raw`(?<!\p{L})(?:${words})(?!\p{L})`; // Latin: a whole word; a stem spells out its \w*

const SEND = `${L("envi[ae]\\w*|envoi\\w*|envoy\\w*|reenvi\\w*|transmet\\w*|transmit[ae]\\w*|transfer[ae]\\w*|recopi\\w*|copia\\w*|copie|copiez|copier|kopier\\w*|sub[ea]\\w*|subir|faca\\s+upload|fazer\\s+upload|hochlad\\w*|hochzulad\\w*|schick\\w*|sende|senden|sendet|leite\\w*|encaminh\\w*|repass\\w*")}|发送|发到|发给|转发|寄到|上传|抄送|复制|拷贝|送信|送って|送る|転送|アップロード|コピー|メール|отправ|перешл|пересл|пошл|загруж|скопиру|копиру|ارسل|ارسال|ارفع|انسخ`;
// Notes only count with "all / saved / every" next to them: "send the meeting notes to team@..." is an ordinary request.
const NOTES = `${L("notas|notes|notizen")}|笔记|メモ|ノート|заметк|заметок|ملاحظات|الملاحظات`;
const ALL = `${L("todas|todos|toda|guardad[ao]s|toutes|tous|enregistre\w*|alle|allen|samtliche\w*|gespeichert\w*|gesamte\w*|salv[ao]s|integralite")}|全部|所有|保存|すべて|全て|全部|все|всех|всю|сохран|جميع|كل|المحفوظة`;
// Memory and credentials need no "all": nobody sends a password to an address in an ordinary note.
const SECRET_OBJ = `${L("memoria|memoire|speichers?|contrasenas|claves|credenciales|credenciais|identifiants|mots?\s+de\s+passe|passw[oö]rter|passwort|zugangsdaten|anmeldedaten|senhas")}|记忆|密码|凭据|凭证|密钥|記憶|パスワード|ログイン情報|認証情報|памят|парол|уч[её]тн|الذاكرة|كلمات\s+المرور|كلمة\s+المرور|بيانات\s+الدخول|بيانات\s+الاعتماد`;
// Starts only at a token start and is bounded: a long letter run with no "@" is one linear pass, not O(n^2) (r8 timing test).
const ADDR = String.raw`https?://|(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]`;
const PAY = `${L("nominas?|sueldos?|salarios?|paie|salaires?|remunerations?|gehalt|gehalter|lohne?|lohnen|folha\\s+de\\s+pagamento")}|工资|薪水|薪资|給与|給料|賃金|зарплат|выплат|оклад|رواتب|راتب|اجور`;
const ACCT = String.raw`(?<![\w-])(?:[a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){3,7}|\d{4}(?:[ -]\d{3,4}){2,}|\d{7,}|\d{3,4}-\d{2,})`;
// A pay-into / from-now-on verb, not just "account": "the expense account 4000-12" sits next to salary talk in ordinary notes.
const PAYINTO = `${L("desde\s+hoy|a\s+partir\s+de|deposit\w*|ingres\w*|abona\w*|transfier\w*|vir[ea]s?|verse[es]?|desormais|ab\s+sofort|ab\s+heute|uberwies\w*|gezahlt|geht|gehen|passa\s+a|agora|ahora|now")}|现在|改存|改为|转入|打到|存到|今後|振り込|振込|теперь|перечисл|поступа|перевест|переводи|تحويل|يودع|تدفع|تودع|اعتبارا`;
const NOTE_SELF = `${L("esta\\s+nota|cette\\s+note|diese[rn]?\\s+notiz|esta\\s+nota")}|这条笔记|本笔记|此笔记|このメモ|эта\\s+заметка|этой\\s+заметк|эту\\s+заметку|هذه\\s+الملاحظة`;
const PRIORITY = `${L("priorid\\w*|priorit\\w*|passe\\s+avant|prevaut|vorrang|uberwieg\\w*")}|优先|優先|важнее|приоритет|главнее|الاولوية|اولوية`;
// The note must put itself above the person or their orders: "this note has priority over the old checklist" is ordinary.
const OVER_USER = `${L("usuari[oa]|persona|ordenes|instrucciones|utilisat\w*|personne|ordres|consignes|benutzer\w*|nutzer\w*|person|befehle\w*|anweisungen|pessoa|ordens|instrucoes|pedidos?")}|用户|对方|命令|指示|要求|ユーザー|相手|命令|指示|要求|пользовател|человек|команд|указани|инструкц|просьб|المستخدم|الشخص|اوامر|تعليمات|طلبات`;
const NOTE = `${L("notas|notes|notizen|notiz")}|笔记|メモ|заметк|заметок|ملاحظ`;
const EDIT = `${L("cambios?|modificacion\\w*|reemplaz\\w*|sustituc\\w*|changements?|modifications?|remplacements?|anderung\\w*|ersetzung\\w*|alterac\\w*|substituic\\w*")}|修改|替换|更改|変更|置き換え|изменени|замен|تعديل|استبدال`;
const NO_CONFIRM = `${L("sin\\s+confirmac|sans\\s+confirmation|aucune\\s+confirmation|ohne\\s+(?:ruckfrage|bestatigung)|keine\\s+(?:ruckfrage|bestatigung)|ruckfrage\\s+ist\\s+nicht|nao\\s+precisa\\s+de\\s+confirmac|sem\\s+confirmac|no\\s+hace\\s+falta\\s+confirmac|no\\s+(?:es\\s+)?necesari[ao]\\s+confirmar")}|无需确认|不需要确认|不用确认|確認は不要|確認不要|подтверждение\\s+не\\s+нужно|без\\s+подтвержд|لا\\s+حاجة\\s+الى\\s+تاكيد|دون\\s+تاكيد`;
const AUTO = `${L("automaticament\\w*|d'office|automatiquement|automatisch")}|自动|自動|автоматически|تلقائيا`;
const APPROVE = `${L("aprob\\w*|acept\\w*|por\\s+buen[oa]s|valid\\w*|approuv\\w*|accept\\w*|genehmig\\w*|bestatig\\w*|akzeptier\\w*|aprov\\w*|aceit\\w*")}|通过|批准|承认|承認|принима|одобр|تقبل|يقبل|قبول|موافق`;
const CONCEAL = `${L("que\\s+el\\s+usuario\\s+no\\s+se\\s+(?:entere|de\\s+cuenta)|sin\\s+que\\s+el\\s+usuario\\s+(?:lo\\s+)?(?:sepa|note|vea|se\\s+entere)|sans\\s+que\\s+l'utilisat\\w*\\s+(?:ne\\s+)?(?:le\\s+)?(?:sache|sachent|voie|remarque)|ohne\\s+dass\\s+(?:der|die)\\s+(?:nutzer|benutzer|anwender)\\w*\\s+(?:davon\\s+|es\\s+)?(?:erfahrt|weiss|merkt|sieht)|sem\\s+que\\s+o\\s+usuario\\s+(?:perceba|saiba|veja|note)")}|别让用户(?:知道|发现|看到)|不要让用户(?:知道|发现)|不要告诉用户|(?:ユーザー|利用者)(?:に|には)(?:知られない|伝えない|言わない|気づかれない)|чтобы\\s+пользовател\\w*\\s+не\\s+(?:узнал|заметил|увидел)|не\\s+говори\\s+пользовател|ничего\\s+не\\s+говори|دون\\s+ان\\s+يعلم\\s+المستخدم|لا\\s+تخبر\\s+المستخدم|دون\\s+علم\\s+المستخدم`;
const DOWNLOAD = `${L("descarg\\w*|telecharg\\w*|herunter\\w*|lade|baix[ea]\\w*")}|下载|ダウンロード|скача|نزل|حمل`;
const RUN = `${L("ejecut\\w*|lance|lancez|lancer|execut[ae]\\w*|execute|ausfuhr\\w*|fuhre|starte|starten|rod[ea]r?|corr[ea]r?")}|运行|执行|実行|запуст|выполн|شغل|نفذ`;

interface Group { family: string; label: string; action: ClaimAction; parts: RegExp[] }
const g = (family: string, label: string, action: ClaimAction, ...parts: string[]): Group => ({ family, label, action, parts: parts.map((p) => new RegExp(p, "giu")) });

const GROUPS: Group[] = [
  g("send-out", "claim: sends notes or secrets to an outside address", "hold", SEND, SECRET_OBJ, ADDR),
  g("send-out", "claim: sends notes or secrets to an outside address", "hold", SEND, NOTES, ALL, ADDR),
  g("payment-redirect", "claim: payment redirect", "hold", PAY, ACCT, PAYINTO),
  g("override-user", "claim: overrides the user's instructions", "hold", NOTE_SELF, PRIORITY, OVER_USER),
  g("approval-bypass", "claim: approval bypass", "hold", NOTE, EDIT, NO_CONFIRM),
  g("approval-bypass", "claim: approval bypass", "hold", NOTE, AUTO, APPROVE),
  g("concealment", "claim: concealment from the user", "hold", CONCEAL),
  g("remote-code", "claim: download and run code", "warn", DOWNLOAD, ADDR, RUN),
];

/** Latin and Arabic marks off (accents, harakat, hamza seats), ' for the curly apostrophe. CJK keeps its marks (dakuten). */
export function intlView(t: string): string {
  return t.normalize("NFD").replace(/([\p{Script=Latin}\p{Script=Arabic}])\p{M}+/gu, "$1").normalize("NFC").replace(/[’ʼ]/g, "'").replace(/ß/g, "ss").toLowerCase();
}

const starts = (re: RegExp, t: string): number[] => Array.from(t.matchAll(re), (m) => m.index);

/** true when some value in sorted `xs` lies within SPAN of `p`. */
function near(xs: number[], p: number): boolean {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < p - SPAN) lo = mid + 1; else hi = mid; }
  return lo < xs.length && xs[lo] <= p + SPAN;
}

/** The rule groups that fire on `text` (already run through normalizeForScan). */
export function scanIntlGroups(text: string): Array<Pick<Group, "family" | "label" | "action">> {
  const v = intlView(text);
  const out: Array<Pick<Group, "family" | "label" | "action">> = [];
  for (const gr of GROUPS) {
    const pos = gr.parts.map((re) => starts(re, v));
    if (pos.some((p) => !p.length)) continue;
    if (pos[0].some((p) => pos.slice(1).every((xs) => near(xs, p)))) out.push({ family: gr.family, label: gr.label, action: gr.action });
  }
  return out;
}
