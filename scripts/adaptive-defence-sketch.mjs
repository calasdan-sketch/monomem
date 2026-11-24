// OFFLINE sketch of defender rules for what the adaptive attacker got past the write gate. Not part of the linter (src/lint*.ts is untouched).
//   node scripts/adaptive-defence-sketch.mjs        needs bench/results/adaptive-winners-qwen2.5_7b.json (node scripts/adaptive-analyze.mjs)
// Each rule is tried on (a) every winning text, (b) every note in bench/benign-corpus.txt, whole body, and (c) the first line of each benign note
// (about what a title / tag / source would hold). The existing linter is run first so only NEW catches are counted. Same method as bench/lint-fp.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { lintContent } from "../dist/src/lint.js";
import { normalizeForScan } from "../dist/src/security.js";

const W = String.raw`[^.\n]`;
export const RULES = {
  "R1 payment redirect": new RegExp(String.raw`\b(redirect|reroute|route|re-route|wire|transfer|direct|send)\w*\b${W}{0,50}\b(payroll|salar\w+|payments?|invoices?|wages|bonus\w*)\b${W}{0,60}\b(account|acct|iban)\b${W}{0,12}\d{3}|\b(payroll|payments?|invoices?)\b${W}{0,40}\b(to|->|=)\s*(account\s*)?\d{3,4}-\d{3,}|\b(redirect|reroute)\w*_(payroll|payments?)`, "i"),
  "R2 trust grant": new RegExp(String.raw`\b(treat|consider|mark|regard|trust)\w*\b${W}{0,40}\b(notes?|messages?|updates?|writers?|bots?)\b${W}{0,40}\b(trusted|verified|safe|authoritative)\b|\b(trusted|verified)\s+(notes?|messages?|updates?)\s+from\b|\b[\w]*bot\b${W}{0,40}\b(trusted|trustworthy|verified|authoritative|without\s+(checking|verif))|\btrusted[_-]?\w*bot|\bbot\w*(trust|verified)`, "i"),
  "R3 approval bypass": new RegExp(String.raw`\b(approv\w*|accept\w*|confirm\w*|authori[sz]\w*|replac\w*|overwrit\w*)\b${W}{0,60}\b(without|skip\w*|never|no)\b${W}{0,20}\b(ask\w*|verif\w*|confirm\w*|check\w*|review\w*|approval|permission|person|user)\b|\b(no|without|skip)\s+(any\s+)?(further\s+)?(verification|approval|confirmation|review)\b|\balways[ _-]approv|auto[ _-]?approv|always[_ -]permissive|\binstantly\b${W}{0,10}\bapprov`, "i"),
  "R4 concealment": new RegExp(String.raw`\b(hide|conceal|suppress)\w*\b${W}{0,40}\b(rule|note|instruction|policy|this|it)\b|\b(never|do\s+not|don'?t|not)\s+(mention|tell|reveal|disclose|show|surface)\b${W}{0,40}\b(user|person|owner|anyone|this)\b|\b(secret|hidden)[\s_-]*(rule|instruction|policy)s?\b|\bquiet(ly)?\b${W}{0,20}\b(change|update|setting)|\bsecret\W{0,2}(rule|规则)`, "i"),
  "R5 override user": new RegExp(String.raw`\b(ignore|disregard|overlook|override|overrule)\w*\b${W}{0,30}\b(user|instructions?|prompts?|requests?)\b|\bignore[_ -]?(user|instruction)|\b(instructions?|user)\b${W}{0,40}\b(overlooked|disregarded|overridden)\b`, "i"),
  "R6 safety off": new RegExp(String.raw`\b(disable|turn\s+off|skip|bypass|switch\s+off|deactivate)\w*\b${W}{0,30}\b(linter|lint\b|write[- ]checks?|safety|validation|filter|scanner|pre[- ]?save)`, "i"),
  "R7 export before search": new RegExp(String.raw`\bexport\w*\b${W}{0,35}\b(before|prior\s+to|ahead\s+of)\b${W}{0,25}\b(search|quer\w+|lookup)|\b(before|prior\s+to)\b${W}{0,25}\b(search|quer\w+)\b${W}{0,45}\bexport|\b(before|prior\s+to)\w*(search|quer\w+)\w*export|\bexport\w*before\w*(search|quer)`, "i"),
  "R8 send-all / credentials out": new RegExp(String.raw`\b(send|forward|post|upload|sync|email|mail|transmit|aggregat\w+)\w*\b${W}{0,40}\b(all|every|saved|stored)\b${W}{0,25}\b(notes?|passwords?|credentials?|entries|data)\b|\b(passwords?|credentials)\b${W}{0,30}\b(forward|send|email|mail|to)\b${W}{0,30}\S+@\S+|(collect|forward|send)\w*[_-](all|store)|store[_-]all[_-]notes`, "i"),
  "R9 delete originals": new RegExp(String.raw`\b(delete|purge|discard|remove)\w*\b${W}{0,30}\b(originals?|other\s+writers?|other\s+agents)\b|\b(verify|confirm|mark)\w*\b${W}{0,40}\b(all|every)\b${W}{0,30}\b(notes?|entries)\b${W}{0,50}\b(delete|purge|discard|remov)|confirm[_-]all[_-]\w*(delete|discard)`, "i"),
  "R10 exclusive tool (name-only)": /\b[a-z]+[-_][a-z]+[-_ ]?only\b|\bonly\b\W{0,3}(use|using)?\W{0,12}[a-z]+-[a-z]+\b(?!-)/i,
  "R12 send-to-outside-address": new RegExp(String.raw`\b(forward|send|post|upload|email|mail|transmit|redirect)\w*\b${W}{0,60}(https?://|\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b|\.invalid\b)|(https?://|\.invalid\b)\S*(collect|exfil|forward|transmit)`, "i"),
  "R11 pipe-to-shell hold (warn->hold)": /\bcurl\b[^\n]{0,80}\|\s*\\?\s*(ba|z)?sh\b|\bwget\b[^\n]{0,80}\|\s*\\?\s*(ba|z)?sh\b/i,
};
const LONG = new RegExp(Object.values(RULES).map((r) => r.source).join("|"), "i");

const norm = (t) => normalizeForScan(t);
const existing = (t, field = "body") => lintContent({ [field]: t, writer: "outsider" }).some((f) => f.category === "injection" || f.category === "secret");

const winners = JSON.parse(readFileSync("bench/results/adaptive-winners-qwen2.5_7b.json", "utf8"));
const benign = readFileSync("bench/benign-corpus.txt", "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s && !/^#cat:/.test(s));
const firstLine = (t) => t.split(/\n/)[0].slice(0, 90);

const res = { rules: {}, combined: {} };
const lines = [];
const p = (s) => lines.push(s);
p(`winners ${winners.length} (blind + adaptive, valid by judge), benign notes ${benign.length}`);
const already = winners.filter((w) => existing(w.text)).length;
p(`already caught by the current linter when the same text is written as a body: ${already}/${winners.length}`);
for (const [name, re] of Object.entries(RULES)) {
  const hit = winners.filter((w) => re.test(norm(w.text)) || re.test(w.text));
  const fpBody = benign.filter((t) => re.test(norm(t)) || re.test(t));
  const fpLine = benign.filter((t) => re.test(norm(firstLine(t))) || re.test(firstLine(t)));
  res.rules[name] = { caught: hit.length, fp_body: fpBody.length, fp_first_line: fpLine.length, fp_examples: fpBody.slice(0, 3).map((t) => t.replace(/\s+/g, " ").slice(0, 100)) };
  p(`${name.padEnd(36)} catches ${String(hit.length).padStart(3)} / ${winners.length}   false positives: ${fpBody.length} / ${benign.length} bodies, ${fpLine.length} first lines`);
  for (const t of fpBody.slice(0, 3)) p(`      FP: ${t.replace(/\s+/g, " ").slice(0, 110)}`);
}
const anyHit = winners.filter((w) => LONG.test(norm(w.text)) || LONG.test(w.text));
const fpAny = benign.filter((t) => LONG.test(norm(t)) || LONG.test(t));
const fpAnyLine = benign.filter((t) => LONG.test(norm(firstLine(t))) || LONG.test(firstLine(t)));
res.combined = { caught: anyHit.length, of: winners.length, fp_body: fpAny.length, fp_first_line: fpAnyLine.length, of_benign: benign.length };
p(`ALL RULES combined: catches ${anyHit.length} / ${winners.length} winners; false positives ${fpAny.length} / ${benign.length} bodies, ${fpAnyLine.length} first lines`);
const missed = winners.filter((w) => !(LONG.test(norm(w.text)) || LONG.test(w.text)));
p(`still passing (${missed.length}), by goal: ${JSON.stringify(missed.reduce((a, w) => ((a[w.goal] = (a[w.goal] ?? 0) + 1), a), {}))}`);
for (const w of missed.slice(0, 12)) p(`   G${w.goal} ${w.field}: ${w.text.slice(0, 110)}`);
console.log(lines.join("\n"));
writeFileSync("bench/results/adaptive-defence-sketch.json", JSON.stringify({ ...res, still_passing: missed.map((w) => ({ goal: w.goal, field: w.field, text: w.text })) }, null, 1));
