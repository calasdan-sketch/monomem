// Model-based random testing (not a test file). A tiny in-memory reference model of the memory (create / update with
// if_rev / archive / restore / delete / replace / undo replace / approve-first holds / distrust / rollback by writer) is
// driven by a seeded random op list through a Driver (the real Store API, or the real MCP stdio server). After every few
// ops the visible state of the real thing is compared with the model; a failing op list is shrunk (ddmin) to a minimal repro.
// Notes are named by a logical slot `k`, never by a raw id, so any subset of an op list is still replayable (shrinking).
import { actorStore } from "../src/actor.js";
import { Store, StaleWriteError, QuarantinedError } from "../src/store.js";
import { supersedePreview, supersedeConfirm, supersedeUndo } from "../src/supersede.js";
import { rollbackPreview, rollbackConfirm } from "../src/rollback.js";
import { verifyAll } from "../src/store/integrity.js";

export const WRITERS = ["alice", "bob", "carol"];
export const NAMESPACES = ["default", "other", "gated"];
const SLOTS = 8;

export type Op =
  | { t: "create"; k: number; w: string; ns: string; body: string }
  | { t: "update"; k: number; w: string; body: string; cas: "none" | "good" | "stale" | "same" }
  | { t: "archive" | "restore" | "delete" | "undo"; k: number; w: string }
  | { t: "replace"; k: number; w: string; body: string }
  | { t: "approve"; n: number }
  | { t: "distrust" | "undistrust"; w: string; ns: string }
  | { t: "mark" }
  | { t: "rollback"; w: string };

export type Out =
  | { kind: "ok"; id: number; rev: number }
  | { kind: "null" }
  | { kind: "stale" }
  | { kind: "held"; qid: number }
  | { kind: "refused"; msg: string };

export interface Snap {
  id: number;
  ns: string;
  title: string;
  body: string;
  rev: number;
  written_by: string;
  created_by: string;
  archived: boolean;
  superseded: boolean;
  /** the surface cannot show an archived note's text: only `archived` is compared */
  opaque?: boolean;
}

export interface Driver {
  readonly mcp: boolean;
  create(w: string, ns: string, title: string, body: string): Promise<Out>;
  update(w: string, id: number, body: string, ifRev?: number): Promise<Out>;
  archive(w: string, id: number): Promise<Out>;
  restore(w: string, id: number): Promise<Out>;
  del(w: string, id: number): Promise<Out>;
  replace(w: string, oldId: number, title: string, body: string): Promise<Out>;
  undo(w: string, id: number): Promise<Out>;
  approve(qid: number): Promise<Out>;
  setGate(ns: string): Promise<void>;
  distrust(ns: string, w: string, on: boolean): Promise<void>;
  rollback(w: string, sinceIso: string): Promise<string>;
  read(id: number): Promise<Snap | null>;
  list(): Promise<number[]>;
  search(title: string): Promise<number[]>;
  history(id: number): Promise<number | null>;
  heldCount(): Promise<number | null>;
  verify(): Promise<string[]>;
  close(): Promise<void>;
}

// ---------- the model ----------
interface Ver { body: string; writer: string; seq: number }
interface MNote {
  id: number; ns: string; title: string; versions: Ver[]; rev: number; creator: string; createdSeq: number;
  archived: boolean; supersededBy: number | null; deleted: boolean; taint: Set<string>; replacer: string;
}
interface Held { qid: number; op: "create" | "update"; w: string; k: number; ns: string; title: string; body: string; baseRev: number }

export class Model {
  notes = new Map<number, MNote>(); // k -> note
  held: Held[] = [];
  gated = new Set<string>();
  distrusted = new Set<string>(); // `${ns}|${writer}`
  seq = 0;
  markSeq = 0;
  markIso = new Date(0).toISOString();
  replacements: Array<{ oldK: number; newK: number; w: string; seq: number }> = [];
  constructor(readonly mcp: boolean) {}
  private cur = (n: MNote): Ver => n.versions[n.versions.length - 1];
  body = (k: number): string | undefined => { const n = this.notes.get(k); return n ? this.cur(n).body : undefined; };
  hidden(n: MNote): boolean { return this.distrusted.has(`${n.ns}|${this.cur(n).writer}`) || [...n.taint].some((w) => this.distrusted.has(`${n.ns}|${w}`)); }
  /** a content edit hands the note over: everyone who held it before stays tainted */
  hand(n: MNote, w: string): void { const c = this.cur(n).writer; if (c !== w) n.taint.add(c); }
  listed(n: MNote): boolean { return !n.deleted && !n.archived && n.supersededBy === null && !this.hidden(n); }
  title = (k: number): string => `tk${k}x`; // unique FTS-friendly token per slot (a slot holds one note ever)
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Apply one op to the model and the driver; return a mismatch description or null. */
export async function step(m: Model, d: Driver, op: Op): Promise<string | null> {
  m.seq++;
  const gatedNs = (ns: string): boolean => m.gated.has(ns);
  const exp = (what: string, got: Out, want: string): string | null => (got.kind === want ? null : `${what}: expected ${want}, real ${JSON.stringify(got)}`);
  switch (op.t) {
    case "create": {
      if (m.notes.has(op.k) || m.held.some((h) => h.k === op.k && h.op === "create")) return null; // slot used
      const out = await d.create(op.w, op.ns, m.title(op.k), op.body);
      if (gatedNs(op.ns)) {
        const e = exp("create in gated ns", out, "held");
        if (e) return e;
        if (out.kind === "held") m.held.push({ qid: out.qid, op: "create", w: op.w, k: op.k, ns: op.ns, title: m.title(op.k), body: op.body, baseRev: 0 });
        return null;
      }
      if (out.kind !== "ok") return `create: expected ok, real ${JSON.stringify(out)}`;
      if (out.rev !== 1) return `create: rev ${out.rev} != 1`;
      m.notes.set(op.k, { id: out.id, ns: op.ns, title: m.title(op.k), versions: [{ body: op.body, writer: op.w, seq: m.seq }], rev: 1, creator: op.w, createdSeq: m.seq, archived: false, supersededBy: null, deleted: false, taint: new Set(), replacer: "" });
      return null;
    }
    case "update": {
      const n = m.notes.get(op.k);
      if (!n || n.deleted || n.supersededBy !== null) return null;
      const cur = n.versions[n.versions.length - 1];
      if (m.mcp && n.archived) { const o = await d.update(op.w, n.id, op.body); return o.kind === "ok" ? "mcp update of archived note succeeded" : null; }
      if (gatedNs(n.ns)) {
        const out = await d.update(op.w, n.id, op.body);
        const e = exp("update in gated ns", out, "held");
        if (e) return e;
        if (out.kind === "held") m.held.push({ qid: out.qid, op: "update", w: op.w, k: op.k, ns: n.ns, title: n.title, body: op.body, baseRev: n.rev });
        return null;
      }
      const body = op.cas === "same" ? cur.body : op.body;
      const ifRev = op.cas === "good" ? n.rev : op.cas === "stale" ? n.rev + 1 + (m.seq % 3) : undefined;
      const out = await d.update(op.w, n.id, body, ifRev);
      if (op.cas === "stale") return exp("stale CAS update", out, "stale");
      if (out.kind !== "ok") return `update: expected ok, real ${JSON.stringify(out)}`;
      if (body !== cur.body) { m.hand(n, op.w); n.rev++; n.versions.push({ body, writer: op.w, seq: m.seq }); }
      if (out.rev !== n.rev) return `update: rev real ${out.rev} model ${n.rev}`;
      return null;
    }
    case "archive": case "restore": {
      const n = m.notes.get(op.k);
      if (!n || n.deleted || n.supersededBy !== null) return null;
      if (m.mcp && op.t === "restore") return null;
      const out = await (op.t === "archive" ? d.archive(op.w, n.id) : d.restore(op.w, n.id));
      if (m.mcp && n.archived) return out.kind === "refused" ? null : `mcp archive of an archived note: expected a refusal, real ${JSON.stringify(out)}`; // the MCP tool says "already archived"; Store.archive is idempotent
      if (gatedNs(n.ns)) return out.kind === "refused" ? null : `${op.t} in gated ns: expected refusal, real ${JSON.stringify(out)}`;
      if (out.kind !== "ok") return `${op.t}: expected ok, real ${JSON.stringify(out)}`;
      n.archived = op.t === "archive";
      return null;
    }
    case "delete": {
      const n = m.notes.get(op.k);
      if (!n || n.deleted || m.mcp) return null;
      const out = await d.del(op.w, n.id);
      if (gatedNs(n.ns)) return out.kind === "refused" ? null : `delete in gated ns: expected refusal, real ${JSON.stringify(out)}`;
      if (out.kind !== "null" && out.kind !== "ok") return `delete: ${JSON.stringify(out)}`;
      n.deleted = true;
      for (const [, o] of m.notes) if (o.supersededBy === op.k && !o.deleted) { o.supersededBy = null; o.archived = false; o.rev++; } // the replaced note comes back
      return null;
    }
    case "replace": {
      const n = m.notes.get(op.k);
      if (!n || n.deleted || n.supersededBy !== null || n.archived || m.mcp || gatedNs(n.ns) || m.hidden(n) || m.distrusted.has(`${n.ns}|${op.w}`)) return null;
      const nk = SLOTS + m.seq; // new slot, never reused
      const out = await d.replace(op.w, n.id, m.title(nk), op.body);
      if (out.kind !== "ok") return `replace: expected ok, real ${JSON.stringify(out)}`;
      n.supersededBy = nk; n.archived = true; n.rev++; n.replacer = op.w;
      m.notes.set(nk, { id: out.id, ns: n.ns, title: m.title(nk), versions: [{ body: op.body, writer: op.w, seq: m.seq }], rev: 1, creator: op.w, createdSeq: m.seq, archived: false, supersededBy: null, deleted: false, taint: new Set(), replacer: "" });
      m.replacements.push({ oldK: op.k, newK: nk, w: op.w, seq: m.seq });
      return null;
    }
    case "undo": {
      const n = m.notes.get(op.k);
      if (!n || n.deleted || n.supersededBy === null || m.mcp || m.hidden(n) || m.distrusted.has(`${n.ns}|${n.replacer}`)) return null;
      const out = await d.undo(n.replacer, n.id); // only the replacer (or an admin) may undo
      if (out.kind !== "ok") return `undo replace: expected ok, real ${JSON.stringify(out)}`;
      n.supersededBy = null; n.archived = false; n.rev++;
      return null;
    }
    case "approve": {
      const h = m.held[op.n % Math.max(1, m.held.length)];
      if (!h) return null;
      const out = await d.approve(h.qid);
      if (h.op === "create") {
        if (out.kind !== "ok") return `approve held create: expected ok, real ${JSON.stringify(out)}`;
        m.held = m.held.filter((x) => x !== h);
        m.notes.set(h.k, { id: out.id, ns: h.ns, title: h.title, versions: [{ body: h.body, writer: h.w, seq: m.seq }], rev: 1, creator: h.w, createdSeq: m.seq, archived: false, supersededBy: null, deleted: false, taint: new Set(), replacer: "" });
        return null;
      }
      const n = m.notes.get(h.k);
      if (!n || n.deleted || n.rev !== h.baseRev) return out.kind === "ok" ? `approve of a stale held edit succeeded (note rev ${n?.rev}, held at ${h.baseRev})` : null;
      if (out.kind !== "ok") return `approve held update: expected ok, real ${JSON.stringify(out)}`;
      m.held = m.held.filter((x) => x !== h);
      m.hand(n, h.w); n.rev++; n.versions.push({ body: h.body, writer: h.w, seq: m.seq });
      return out.rev === n.rev ? null : `approve held update: rev real ${out.rev} model ${n.rev}`;
    }
    case "distrust": case "undistrust": {
      if (m.mcp) return null;
      await d.distrust(op.ns, op.w, op.t === "distrust");
      if (op.t === "distrust") m.distrusted.add(`${op.ns}|${op.w}`); else m.distrusted.delete(`${op.ns}|${op.w}`);
      return null;
    }
    case "mark": { m.markSeq = m.seq; await sleep(4); m.markIso = new Date().toISOString(); await sleep(4); return null; }
    case "rollback": {
      if (m.mcp) return null;
      return rollbackStep(m, d, op.w);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rollbackStep(m: Model, d: Driver, w: string): Promise<string | null> {
  const since = m.markSeq;
  const arch: number[] = []; const rest: Array<{ k: number; v: Ver }> = []; const unrep: number[] = [];
  for (const [k, n] of m.notes) {
    if (n.deleted || m.gated.has(n.ns) || n.supersededBy !== null) continue;
    const cur = n.versions[n.versions.length - 1];
    if (n.creator === w && n.createdSeq >= since) {
      if (n.archived) continue;
      const others = n.versions.some((v) => v.writer !== w);
      if (!others) arch.push(k);
      continue;
    }
    const fi = n.versions.findIndex((v, i) => i > 0 && v.writer === w && v.seq >= since);
    if (fi < 0) continue;
    if (n.archived) continue;
    if (n.versions.slice(fi + 1).some((v) => v.writer !== w) || cur.writer !== w && n.versions.slice(fi).some((v) => v.writer !== w)) continue;
    rest.push({ k, v: n.versions[fi - 1] });
  }
  for (const r of m.replacements) {
    const o = m.notes.get(r.oldK);
    if (r.w === w && r.seq >= since && o && !o.deleted && o.supersededBy === r.newK && !m.gated.has(o.ns)) unrep.push(r.oldK);
  }
  const out = await d.rollback(w, m.markIso);
  if (arch.length + rest.length + unrep.length === 0 && out.startsWith("error:")) return null;
  if (out.startsWith("error:")) return `rollback(${w}) errored: ${out}`;
  for (const k of arch) m.notes.get(k)!.archived = true;
  for (const r of rest) { const n = m.notes.get(r.k)!; if (r.v.body === n.versions[n.versions.length - 1].body) { n.rev++; continue; } /* FINDING F1: text already that: rev still bumps, no history */ n.taint = new Set(n.versions.filter((v) => v !== n.versions[n.versions.length - 1]).map((v) => v.writer)); n.rev++; n.versions.push({ body: r.v.body, writer: r.v.writer, seq: m.seq }); }
  for (const k of unrep) { const n = m.notes.get(k)!; n.supersededBy = null; n.archived = false; n.rev++; }
  return null;
}

/** Compare the model with the driver. Returns the first difference or null. */
export async function compare(m: Model, d: Driver): Promise<string | null> {
  const listed = new Set(await d.list());
  const want = new Set<number>();
  for (const [k, n] of m.notes) {
    const cur = n.versions[n.versions.length - 1];
    const real = await d.read(n.id);
    if (n.deleted) { if (real !== null) return `note slot ${k} (id ${n.id}) was deleted but still reads`; continue; }
    if (!real) { if (!m.hidden(n)) return `note slot ${k} (id ${n.id}) missing`; continue; }
    if (real.opaque) { if (!n.archived) return `slot ${k} id ${n.id}: reads as archived but the model says live`; continue; }
    const diffs: string[] = [];
    if (real.rev !== n.rev) diffs.push(`rev real ${real.rev} model ${n.rev}`);
    if (real.body !== cur.body) diffs.push(`body real ${JSON.stringify(real.body)} model ${JSON.stringify(cur.body)}`);
    if (real.written_by !== lbl(m, cur.writer)) diffs.push(`written_by real ${real.written_by} model ${cur.writer}`);
    if (real.created_by !== lbl(m, n.creator)) diffs.push(`created_by real ${real.created_by} model ${n.creator}`);
    if (real.archived !== n.archived) diffs.push(`archived real ${real.archived} model ${n.archived}`);
    if (real.superseded !== (n.supersededBy !== null)) diffs.push(`superseded real ${real.superseded} model ${n.supersededBy !== null}`);
    if (real.ns !== n.ns) diffs.push(`namespace real ${real.ns} model ${n.ns}`);
    if (diffs.length) return `slot ${k} id ${n.id}: ${diffs.join("; ")}`;
    const h = await d.history(n.id);
    if (h !== null && h !== n.versions.length - 1) return `slot ${k} id ${n.id}: history real ${h} model ${n.versions.length - 1}`;
    const vis = m.listed(n);
    if (vis) want.add(n.id);
    const found = (await d.search(n.title)).includes(n.id);
    if (found !== vis) return `slot ${k} id ${n.id}: search for its title ${found ? "found" : "missed"} it but visible=${vis} (archived=${n.archived} superseded=${n.supersededBy !== null} hidden=${m.hidden(n)})`;
  }
  const got = [...listed].sort((a, b) => a - b), exp = [...want].sort((a, b) => a - b);
  if (!same(got, exp)) return `list: real ${JSON.stringify(got)} model ${JSON.stringify(exp)}`;
  const hc = await d.heldCount();
  if (hc !== null && hc !== m.held.length) return `held writes: real ${hc} model ${m.held.length}`;
  return null;
}
const lbl = (m: Model, w: string): string => (m.mcp ? `stdio:${w}` : w);

// ---------- random op lists ----------
export function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function genOps(seed: number, count: number, mcp: boolean): Op[] {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const ws = mcp ? ["t1", "t2"] : WRITERS;
  const nss = mcp ? ["default"] : NAMESPACES;
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const x = r();
    const k = Math.floor(r() * SLOTS);
    const w = pick(ws);
    const body = `bd${seed}n${i} text${Math.floor(r() * 1e6)}`;
    if (x < 0.2) ops.push({ t: "create", k, w, ns: pick(nss), body });
    else if (x < 0.5) ops.push({ t: "update", k, w, body, cas: pick(["none", "good", "stale", "same"] as const) });
    else if (x < 0.6) ops.push({ t: "archive", k, w });
    else if (x < 0.68) ops.push({ t: "restore", k, w });
    else if (x < 0.72) ops.push({ t: "delete", k, w });
    else if (x < 0.78) ops.push({ t: "replace", k, w, body });
    else if (x < 0.82) ops.push({ t: "undo", k, w });
    else if (x < 0.87) ops.push({ t: "approve", n: Math.floor(r() * 5) });
    else if (x < 0.9) ops.push({ t: "distrust", w, ns: pick(nss) });
    else if (x < 0.93) ops.push({ t: "undistrust", w, ns: pick(nss) });
    else if (x < 0.96) ops.push({ t: "mark" });
    else ops.push({ t: "rollback", w });
  }
  return ops;
}

// ---------- run + shrink ----------
export async function runOps(make: () => Promise<{ d: Driver; gated: string[] }>, ops: Op[], checkEvery = 4): Promise<string | null> {
  const { d, gated } = await make();
  try {
    const m = new Model(d.mcp);
    for (const g of gated) { await d.setGate(g); m.gated.add(g); }
    for (let i = 0; i < ops.length; i++) {
      let why: string | null;
      try { why = await step(m, d, ops[i]); } catch (e) { why = `threw ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 200)}`; }
      if (!why && (i % checkEvery === checkEvery - 1 || i === ops.length - 1)) why = await compare(m, d);
      if (why) return `op #${i} ${JSON.stringify(ops[i])}: ${why}`;
    }
    const bad = await d.verify();
    return bad.length ? `verify: ${bad.join("; ")}` : null;
  } finally {
    await d.close();
  }
}

/** ddmin-style shrink: drop chunks of ops while the failure (any failure) persists. */
const sig = (w: string | null): string => (w ?? "").replace(/^op #\d+ \{.*?\}: /, "").replace(/\d+/g, "#").slice(0, 45);
export async function shrink(make: () => Promise<{ d: Driver; gated: string[] }>, ops: Op[], budget = 80): Promise<Op[]> {
  const want = sig(await runOps(make, ops, 1));
  let cur = ops; let n = 2; let runs = 0;
  while (cur.length >= 2 && runs < budget) {
    const size = Math.ceil(cur.length / n); let reduced = false;
    for (let s = 0; s < cur.length && runs < budget; s += size) {
      const cand = [...cur.slice(0, s), ...cur.slice(s + size)];
      runs++;
      if (cand.length && sig(await runOps(make, cand, 1)) === want) { cur = cand; n = Math.max(n - 1, 2); reduced = true; break; }
    }
    if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
  }
  return cur;
}

// ---------- the in-process Store driver ----------
const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const toSnap = (n: ReturnType<Store["read"]>): Snap | null =>
  n ? { id: n.id, ns: n.namespace, title: n.title, body: n.body, rev: n.rev, written_by: n.written_by ?? "", created_by: n.created_by ?? "", archived: !!n.archived_at, superseded: n.status === "superseded" } : null;

function classify(e: unknown): Out {
  if (e instanceof StaleWriteError) return { kind: "stale" };
  if (e instanceof QuarantinedError) return { kind: "held", qid: e.quarantineId };
  return { kind: "refused", msg: `${(e as Error)?.constructor?.name}: ${(e as Error)?.message?.slice(0, 120)}` };
}

export function storeDriver(store: Store): Driver {
  const run = async (f: () => { id: number; rev: number } | null | boolean): Promise<Out> => {
    try { const r = f(); if (r === null || r === false) return { kind: "null" }; if (r === true) return { kind: "ok", id: 0, rev: 0 }; return { kind: "ok", id: r.id, rev: r.rev }; } catch (e) { return classify(e); }
  };
  return {
    mcp: false,
    create: (w, ns, title, body) => run(() => as(w, () => store.create({ namespace: ns, title, body }))),
    update: (w, id, body, ifRev) => run(() => as(w, () => store.update(id, { body }, ifRev === undefined ? {} : { ifRev }))),
    archive: (w, id) => run(() => as(w, () => store.archive(id))),
    restore: (w, id) => run(() => as(w, () => store.restore(id))),
    del: (w, id) => run(() => as(w, () => store.delete(id))),
    replace: async (w, oldId, title, body) => {
      try {
        const nn = { title, body };
        const p = as(w, () => supersedePreview(store, { scope: "write" }, { old_ids: [oldId], new_note: nn }));
        const r = as(w, () => supersedeConfirm(store, { scope: "write" }, { token: p.token, new_note: nn })) as unknown as { replacement?: { id: number; rev?: number } };
        return { kind: "ok", id: Number(r.replacement?.id), rev: 1 };
      } catch (e) { return classify(e); }
    },
    undo: async (w, id) => { try { as(w, () => supersedeUndo(store, { scope: "write" }, id)); return { kind: "ok", id, rev: 0 }; } catch (e) { return classify(e); } },
    approve: (qid) => run(() => store.approveQuarantine(qid)),
    setGate: async (ns) => { store.setApproveFirst(ns, true); },
    distrust: async (ns, w, on) => { if (on) store.distrustAdd(ns, w); else store.distrustRemove(ns, w); },
    rollback: async (w, since) => {
      try {
        const caller = { scope: "admin" } as const;
        const p = rollbackPreview(store, caller, { writer: w, since });
        rollbackConfirm(store, caller, { token: p.token });
        return "ok";
      } catch (e) { return `error: ${(e as Error).message}`; }
    },
    read: async (id) => toSnap(store.read(id)),
    list: async () => store.listIds({ limit: 500 }),
    search: async (title) => store.search(title, { limit: 50 }).map((n) => n.id),
    history: async (id) => store.historyCount(id),
    heldCount: async () => store.listQuarantine({ limit: 500 }).length,
    verify: async () => verifyAll(store, { signatures: true }).issues.filter((i) => i.severity === "fail").map((i) => JSON.stringify(i)),
    close: async () => { store.close(); },
  };
}

// ---------- the real MCP stdio server (two client apps t1, t2 = two server processes on one folder) ----------
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-stdio.js");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function mcpDriver(dir: string): Promise<Driver> {
  const clients = new Map<string, Client>();
  for (const w of ["t1", "t2"]) {
    const t = new StdioClientTransport({ command: process.execPath, args: [BIN], stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", HOME: dir, USERPROFILE: dir, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir, MONOMEM_AUDIT_LOG: join(dir, "audit.log"), MONOMEM_TOOLS: "legacy-1.5,all", MONOMEM_HISTORY_VERSIONS: "500", MONOMEM_FLOOD_WRITES_PER_HOUR: "0" } });
    const c = new Client({ name: w, version: "1" });
    await c.connect(t);
    clients.set(w, c);
  }
  const call = async (w: string, name: string, args: Json): Promise<{ err: boolean; j: Json; text: string }> => {
    const r = (await clients.get(w)!.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0].text; const i = text.indexOf("{");
    let j: Json = {}; try { j = i >= 0 ? JSON.parse(text.slice(i)) : {}; } catch { /* plain text */ }
    return { err: !!r.isError, j, text };
  };
  const out = (r: { err: boolean; j: Json; text: string }): Out => {
    if (!r.err) return { kind: "ok", id: Number(r.j.note?.id ?? r.j.archived ?? 0), rev: Number(r.j.note?.rev ?? 0) };
    if (r.j.stale) return { kind: "stale" };
    return { kind: "refused", msg: String(r.j.error ?? r.text).slice(0, 140) };
  };
  const no = async (): Promise<Out> => ({ kind: "refused", msg: "not on MCP" });
  return {
    mcp: true,
    create: async (w, _ns, title, body) => out(await call(w, "state_write", { title, body })),
    update: async (w, id, body, ifRev) => out(await call(w, "state_write", { id, body, ...(ifRev === undefined ? {} : { if_rev: ifRev }) })),
    archive: async (w, id) => { const r = await call(w, "state_delete", { id }); return r.err ? out(r) : { kind: "ok", id, rev: 0 }; },
    restore: no, del: no, replace: no, undo: no, approve: no,
    setGate: async () => undefined, distrust: async () => undefined, rollback: async () => "error: not on MCP",
    read: async (id) => {
      const r = await call("t1", "state_read", { id });
      if (r.err) return /archived/.test(r.text) ? { id, ns: "", title: "", body: "", rev: 0, written_by: "", created_by: "", archived: true, superseded: false, opaque: true } : null;
      const n = r.j.note ?? r.j;
      return { id: n.id, ns: n.namespace, title: n.title, body: n.body, rev: n.rev, written_by: n.written_by, created_by: n.created_by, archived: false, superseded: false };
    },
    list: async () => ((await call("t2", "state_list", { limit: 200 })).j.notes ?? []).map((n: Json) => Number(n.id)),
    search: async (title) => ((await call("t2", "state_search", { query: title, limit: 50 })).j.results ?? []).map((n: Json) => Number(n.id)),
    history: async () => null,
    heldCount: async () => null,
    verify: async () => {
      for (const c of clients.values()) await c.close();
      clients.clear();
      const s = new Store(join(dir, "state.db"));
      try { return verifyAll(s, { signatures: true }).issues.filter((i) => i.severity === "fail").map((i) => JSON.stringify(i)); } finally { s.close(); }
    },
    close: async () => { for (const c of clients.values()) await c.close().catch(() => undefined); },
  };
}
