// Model-free synonym and irregular-verb expansion for keyword search. No download, no network, no model: a small built-in
// table. A search word that (almost) no note holds is widened to its synonyms, so "who got fired" finds "contractor was
// terminated" and "my car" finds "company automobile". English only; other languages need the optional embeddings.
// ponytail: a hand-kept table (about 150 groups), not a thesaurus. Add a group when a real miss shows up; a learned
// vocabulary (co-occurrence from the user's notes) was not built, see docs/BENCHMARK.md for why.
import { searchStem } from "./keywords.js";

/** Words that mean (nearly) the same in everyday and developer notes. One group per line. */
const GROUPS: readonly string[] = [
  "car automobile vehicle", "doctor physician", "buy purchase acquire", "sell vend", "fire terminate dismiss sack",
  "hire recruit employ", "quit resign", "fix repair resolve patch", "bug defect fault glitch", "error failure exception",
  "crash outage downtime", "start begin launch commence", "stop halt cease terminate", "end finish complete conclude",
  "big large huge", "small little tiny", "fast quick rapid speedy", "slow sluggish laggy", "cheap inexpensive affordable",
  "expensive costly pricey", "money cash funds", "price cost fee charge", "salary pay wage income", "job work employment occupation",
  "boss manager supervisor", "coworker colleague teammate", "customer client", "meeting appointment", "email message",
  "house home residence", "apartment flat", "phone telephone mobile", "laptop notebook computer", "app application program software",
  "repo repository", "database datastore", "delete remove erase", "add append insert", "change modify alter edit update",
  "show display present", "hide conceal", "find locate discover", "check verify validate confirm", "test try",
  "build compile construct", "deploy release ship publish", "rollback revert undo", "install setup configure",
  "login signin authenticate", "password passphrase", "secret credential", "key token", "speed performance latency",
  "memory ram", "disk storage drive", "folder directory", "file document", "picture image photo", "movie film",
  "buy order", "send transmit dispatch", "receive get obtain", "ask request query", "answer reply respond",
  "tell inform notify", "choose select pick", "decide determine", "plan schedule", "agree approve accept",
  "reject decline refuse deny", "allow permit enable", "forbid prohibit ban block disallow", "need require", "want desire wish",
  "like enjoy love prefer", "hate dislike", "happy glad pleased", "sad unhappy upset", "angry mad furious",
  "tired exhausted sleepy", "sick ill unwell", "begin initiate", "keep retain preserve", "give provide supply grant",
  "take grab", "use utilize employ", "make create produce generate", "break shatter", "mistake blunder",
  "problem issue trouble", "idea concept notion", "goal objective target aim", "rule policy guideline", "plan strategy roadmap",
  "limit cap maximum", "minimum least", "begin onset", "huge enormous gigantic", "old ancient outdated legacy",
  "new recent fresh", "wrong incorrect", "right correct", "true accurate", "answer solution",
  "vacation holiday trip", "lunch meal", "dinner supper", "kid child", "mom mother", "dad father",
  "buy shop", "run execute", "wait pause", "fail break", "backup snapshot", "log record", "alert alarm warn",
  "bill invoice", "refund reimburse", "sign contract agreement", "deadline duedate", "stuck blocked frozen hung",
];

/** Irregular forms the suffix rules cannot reach (past tense, participles, plurals) to their base word. */
const IRREGULAR: Readonly<Record<string, string>> = Object.fromEntries(
  ("bought:buy sold:sell fired:fire hired:hire quit:quit fixed:fix broke:break broken:break ran:run began:begin begun:begin " +
    "chose:choose chosen:choose wrote:write written:write sent:send got:get gotten:get gave:give given:give took:take taken:take " +
    "made:make said:say told:tell found:find lost:lose paid:pay met:meet held:hold kept:keep left:leave built:build " +
    "felt:feel thought:think knew:know known:know saw:see seen:see went:go gone:go came:come did:do done:do had:have " +
    "spent:spend wrote:write drove:drive driven:drive ate:eat eaten:eat forgot:forget forgotten:forget " +
    "children:child men:man women:woman people:person mice:mouse feet:foot teeth:tooth").split(" ").map((p) => p.split(":") as [string, string])
);

/** A key shared by the forms of a word: "terminated", "terminate" and "terminates" all give "terminat". */
function root(word: string): string {
  const w = word.toLowerCase();
  const base = IRREGULAR[w] ?? w;
  let s = searchStem(base);
  if (/[^su]s$/.test(s)) s = s.slice(0, -1); // searchStem keeps "cars": fewer than 4 letters would be left
  return s.length > 4 && s.endsWith("e") ? s.slice(0, -1) : s;
}

/** root -> the roots of every other word in its groups (a word in two groups gets both). */
const INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, Set<string>>();
  for (const g of GROUPS) {
    const roots = g.split(" ").map(root);
    for (const r of roots) {
      const set = m.get(r) ?? new Set<string>();
      for (const o of roots) if (o !== r) set.add(o);
      m.set(r, set);
    }
  }
  return new Map([...m].map(([k, v]) => [k, [...v]]));
})();

/** Words worth adding to a search for `word`: its synonyms as prefix stems ("terminat"), empty when the table has none. */
export function synonymsFor(word: string): string[] {
  return [...(INDEX.get(root(word)) ?? [])];
}

/** Query terms for `word` plus its synonym stems (used by the save-time conflict finder: older notes that say the same thing in other words). */
export const synonymsOf = (word: string): string[] => [word, ...synonymsFor(word)];

/** One name for a group of synonyms (the alphabetically first stem), so two notes can be compared by what they are about. */
export function canon(word: string): string {
  const r = root(word);
  return [r, ...(INDEX.get(r) ?? [])].sort()[0];
}

