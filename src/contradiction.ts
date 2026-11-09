// Possible contradictions between notes in the SAME namespace. A HEURISTIC, ENGLISH ONLY: it finds
//   (1) two notes about the same subject where the value differs ("staging port 8443" vs "staging port 9000",
//       "the api uses postgres" vs "the api uses mysql"), and
//   (2) two notes that share most of their words where exactly one adds a negation ("deploys on friday" vs
//       "never deploys on friday").
// It only SUGGESTS a look (and the supersede preview command); it changes nothing. It will miss contradictions in
// other words or other languages and will flag harmless pairs. Archived and already-replaced notes are left out.
// Bounded: words used by hundreds of notes are ignored, each note is compared with a handful of candidates, and the
// whole pass stops after a time budget (default 3 s) so 10,000 notes cannot stall a report.
import type { NoteRecord } from "./store.js";

export interface Contradiction {
  /** [older, newer] */
  ids: [number, number];
  namespace: string;
  why: string;
}

const NEGATIONS = new Set(["not", "no", "never", "dont", "doesnt", "isnt", "arent", "cannot", "cant", "wont", "without", "stopped", "disabled"]);
const STOP = new Set(["the", "a", "an", "is", "are", "was", "of", "to", "in", "on", "for", "and", "it", "this", "that", "we", "our", "my", "be", "as", "at", "by", "with"]);

const words = (s: string): string[] => s.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** "<subject> port <n>", "<subject> is|uses|runs on|equals <value>": [subject, value] facts, one per sentence. */
export function extractFacts(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/[.\n;]+/)) {
    const s = raw.trim();
    if (!s || s.length > 200) continue;
    let m = /^(?:the\s+)?([a-z][\w .-]{1,40}?)\s+port\s+(?:is\s+)?(\d{2,5})\b/i.exec(s);
    if (m) {
      out.push([`${m[1].toLowerCase().trim()} port`, m[2]]);
      continue;
    }
    m = /^(?:the\s+)?([a-z][\w .-]{1,40}?)\s+(?:is|are|uses|use|runs on|runs|equals|=|:)\s+([a-z0-9][\w./:-]{0,40})\s*$/i.exec(s);
    if (m && !NEGATIONS.has(m[2].toLowerCase())) out.push([m[1].toLowerCase().trim().replace(/\s+/g, " "), m[2].toLowerCase()]);
  }
  return out;
}

export function findContradictions(notes: NoteRecord[], opts: { max?: number; budgetMs?: number } = {}): { found: Contradiction[]; truncated: boolean } {
  const max = opts.max ?? 200;
  const deadline = Date.now() + (opts.budgetMs ?? 3000);
  const live = notes.filter((n) => !n.archived_at && n.superseded_by === undefined);
  const found: Contradiction[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const older = (a: NoteRecord, b: NoteRecord): [NoteRecord, NoteRecord] => (Date.parse(a.updated_at) <= Date.parse(b.updated_at) ? [a, b] : [b, a]);
  const push = (a: NoteRecord, b: NoteRecord, why: string): void => {
    const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (seen.has(k) || found.length >= max) return;
    seen.add(k);
    const [o, n] = older(a, b);
    found.push({ ids: [o.id, n.id], namespace: a.namespace, why });
  };
  const byNs = new Map<string, NoteRecord[]>();
  for (const n of live) (byNs.get(n.namespace) ?? byNs.set(n.namespace, []).get(n.namespace)!).push(n);

  for (const [, group] of byNs) {
    // (1) same subject, different value
    const facts = new Map<string, Map<string, NoteRecord>>();
    for (const n of group) {
      for (const [subj, val] of extractFacts(`${n.title}. ${n.body.slice(0, 2000)}`)) {
        const per = facts.get(subj) ?? facts.set(subj, new Map()).get(subj)!;
        if (!per.has(val)) per.set(val, n);
      }
    }
    for (const [subj, per] of facts) {
      if (per.size < 2 || per.size > 6) continue;
      const vals = [...per];
      for (let i = 0; i < vals.length; i++)
        for (let j = i + 1; j < vals.length; j++)
          if (vals[i][1].id !== vals[j][1].id) push(vals[i][1], vals[j][1], `both say what "${subj}" is, with different answers (${vals[i][0]} and ${vals[j][0]})`);
    }
    // (2) shared words, one adds a negation
    const toks = new Map<number, Set<string>>();
    const post = new Map<string, number[]>();
    for (const n of group) {
      const set = new Set(words(`${n.title} ${n.body.slice(0, 1500)}`).filter((w) => w.length > 2 || NEGATIONS.has(w)));
      toks.set(n.id, set);
      for (const w of set) if (!NEGATIONS.has(w) && !STOP.has(w)) (post.get(w) ?? post.set(w, []).get(w)!).push(n.id);
    }
    const byId = new Map(group.map((n) => [n.id, n]));
    for (const n of group) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const mine = toks.get(n.id)!;
      const myNeg = [...mine].some((w) => NEGATIONS.has(w));
      const votes = new Map<number, number>();
      for (const w of mine) {
        const p = post.get(w);
        if (!p || p.length > 200) continue;
        for (const id of p) if (id > n.id) votes.set(id, (votes.get(id) ?? 0) + 1);
      }
      const cands = [...votes].filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 12);
      for (const [id] of cands) {
        const other = toks.get(id)!;
        if (myNeg === [...other].some((w) => NEGATIONS.has(w))) continue;
        const core = (s: Set<string>): string[] => [...s].filter((w) => !NEGATIONS.has(w) && !STOP.has(w));
        const a = new Set(core(mine));
        const b = new Set(core(other));
        let inter = 0;
        for (const w of a) if (b.has(w)) inter++;
        const jac = inter / (a.size + b.size - inter || 1);
        if (jac >= 0.6) push(n, byId.get(id)!, "they use almost the same words, but one of them says \"not\"/\"never\"/\"no\"");
      }
    }
    if (found.length >= max) break;
  }
  return { found, truncated };
}
