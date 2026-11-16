// 1.5.0 signed audit log: `monomem audit verify`, `monomem audit checkpoint` and `monomem verify-receipt`.
// The log and the receipts are signed by the store key (.attest-key); see SECURITY.md "Audit log and receipts".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { auditPath, printable, verifyAuditChain } from "./security.js";
import { contentHash, peekSigningKey } from "./attest.js";
import { verifyReceipt, type WriteReceipt } from "./store/write-receipt.js";

const HEX64 = /^[0-9a-f]{64}$/;
const PUB = /^[A-Za-z0-9_-]{43}$/;

/** Printed after every signature check: what it does not prove (SECURITY.md has the full list). */
const LIMITS =
  "This does not prove: anything against a program running as this store's user (it can read the key and rewrite\n" +
  "everything after the last receipt or checkpoint someone else holds, or cut the newest lines off), that the log is\n" +
  "complete, or that the content is true. Keep a checkpoint off this machine: monomem audit checkpoint --out <file>.";

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** The key beside the audit log (key id -> public key): what the log's newest signature must be under. */
function logKeyring(): Record<string, string> {
  const k = peekSigningKey(dirname(auditPath()));
  return k ? { [k.keyId]: k.publicKey } : {};
}

async function openStore() {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  return new Store(DB_PATH);
}

function readReceipt(file: string): Partial<WriteReceipt> {
  let r: unknown;
  try {
    r = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`cannot read the receipt ${file}: ${(e as Error).message}`, 2);
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) fail(`${file} is not a receipt (a JSON object)`, 2);
  // A write answers {note, receipt}; accept the whole answer too.
  const o = r as { receipt?: unknown };
  return (o.receipt && typeof o.receipt === "object" ? o.receipt : r) as Partial<WriteReceipt>;
}

function describe(r: Partial<WriteReceipt>): string {
  const what = r.decision === "checkpoint" ? "checkpoint of the log head" : `${printable(r.decision, 20)}${r.note_id !== undefined ? ` note #${r.note_id}` : ""}${r.rev !== undefined ? ` rev ${r.rev}` : ""}${r.content_hash ? ` with content ${printable(r.content_hash, 64)}` : ""}`;
  return `store ${printable(r.server_id, 64)}, key ${printable(r.key_id, 32)}, ${what} as audit line ${r.seq}/${printable(r.chain_hash, 64)} at ${printable(r.ts, 40)}`;
}

/** `audit verify [--expect <hash>] [--checkpoint <file>] [--all-signatures] [--strict]` */
export async function auditVerifyCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem audit verify [--expect <head-hash>] [--checkpoint <file>] [--all-signatures] [--strict]   |   monomem audit checkpoint [--out <file>]   |   monomem audit --since 24h [--op create|update|delete] [--label <key>] [--limit n] [--json]";
  let expect: string | undefined;
  let checkpoint: Partial<WriteReceipt> | undefined;
  let allSignatures = false;
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--expect") {
      expect = args[++i]?.trim().toLowerCase();
      if (!HEX64.test(expect ?? "")) fail(usage + " (the head hash is 64 hex characters, as printed by `monomem audit verify`)", 2);
    } else if (a === "--checkpoint" && args[i + 1]) checkpoint = readReceipt(args[++i]);
    else if (a === "--all-signatures") allSignatures = true;
    else if (a === "--strict") strict = true;
    else fail(usage, 2);
  }
  if (expect && checkpoint) fail("give --expect or --checkpoint, not both", 2);
  const keys = logKeyring();
  if (checkpoint) {
    const pub = keys[checkpoint.key_id ?? ""];
    if (!pub || !verifyReceipt(checkpoint, pub)) fail("Checkpoint NOT valid: its signature does not verify under this store's current key (edited, from another store, or signed before a key rotation: check it with verify-receipt --pubkey <the old key>).");
    if (!HEX64.test(checkpoint.chain_hash ?? "")) fail("Checkpoint NOT valid: no chain_hash.");
    expect = checkpoint.chain_hash;
  }
  const r = verifyAuditChain(undefined, expect, { keys, allSignatures, strict });
  const extra = `${r.forks} fork(s) (two processes writing at once, or a line inserted), ${r.unchained} line(s) from before the chain`;
  const sigs =
    `${r.signed} signed line(s)${r.head_key_id ? `, newest under key ${r.head_key_id}` : ""}; ${r.unsigned_before_signing} unsigned line(s) from before signing began (protected by the hash chain only)` +
    (r.unsigned_after_signing ? `; WARNING: ${r.unsigned_after_signing} unsigned line(s) after signing began (an older Monomem, a process that could not read the key, or a stripped signature)` : "");
  if (!r.ok) {
    if (r.breaks) fail(`Audit chain BROKEN: ${r.breaks} break(s), first at line ${r.brokenLine} of ${r.file} (it follows from none of the lines before it). ${extra}.`);
    if (r.bad_signature) fail(`Audit chain BROKEN: ${r.bad_signature} bad signature(s), first at line ${r.badSignatureLine} (edited, or signed by a key the log never handed over to). ${sigs}.`);
    if (r.head_key_trusted === false) fail(`Audit chain NOT trusted: the newest signed line is under key ${r.head_key_id}, which is not this store's key (${Object.keys(keys)[0] ?? "none"}) and no key-rotate line hands over to it.`);
    fail(`Audit chain NOT accepted with --strict: ${sigs}.`);
  }
  console.log(`Audit chain intact: ${r.lines} line(s), ${extra}.`);
  console.log(`Signatures: ${sigs}.${r.signed && !keys[r.head_key_id ?? ""] ? " No signing key beside the log, so the newest signature was checked only against keys named in the log." : ""}`);
  console.log(`Head ${r.head ?? "(empty)"}: keep it somewhere that is not this machine (a git commit, a password manager), then check later with: monomem audit verify --expect <head>. A signed, portable copy: monomem audit checkpoint --out <file>, checked with: monomem audit verify --checkpoint <file>.`);
  console.log("Detects lines edited or removed, and lines signed by the wrong key. Not: a rewrite by a program that can read the key (anything running as you), rotated files deleted, or the newest lines cut off after the last checkpoint someone else holds.");
  if (r.anchor) {
    if (!r.anchor.found) fail(`${checkpoint ? "Checkpoint" : "Anchor"} NOT FOUND: no line in the log has the hash you gave. The log was rewritten or cut off before that point (or the hash is from another log).`);
    if (checkpoint && r.anchor.seq !== checkpoint.seq) fail(`Checkpoint NOT valid: the line with that hash has seq ${r.anchor.seq || "(none)"}, not ${checkpoint.seq}.`);
    const what = checkpoint ? "Checkpoint OK" : "Anchor OK";
    console.log(r.anchor.linesAfter === 0 ? `${what}: it is the current head.` : `${what}: the line is still in the chain, ${r.anchor.linesAfter} line(s) older than the head (the log has grown since).`);
  }
}

/** `audit checkpoint [--out <file>]`: the signed head of the log. */
export async function auditCheckpointCmd(args: string[]): Promise<void> {
  const out = args[0] === "--out" && args[1] ? args[1] : undefined;
  if (args.length !== (out ? 2 : 0)) fail("Usage: monomem audit checkpoint [--out <file>]", 2);
  const store = await openStore();
  let cp: WriteReceipt;
  try {
    cp = store.auditCheckpoint();
  } catch (e) {
    fail(`No checkpoint: ${(e as Error).message}`);
  } finally {
    store.close();
  }
  const json = JSON.stringify(cp, null, 2) + "\n";
  if (!out) return void process.stdout.write(json);
  writeFileSync(out, json);
  console.log(`Signed checkpoint of audit line ${cp.seq} written to ${out}. Keep it off this machine; check later with: monomem audit verify --checkpoint ${out}`);
}

/**
 * `verify-receipt <seq> <chain_hash>`: the line is still in the unbroken, validly signed chain.
 * `verify-receipt --file <receipt.json> [--pubkey <file|base64url>] [--note <id>]`: the receipt's signature (offline with
 * --pubkey: no store is opened unless --note), then (without --pubkey) that its line is still in the log, then (--note)
 * whether the note still has the content the receipt names.
 */
export async function verifyReceiptCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem verify-receipt <seq> <chain_hash>   |   monomem verify-receipt --file <receipt.json> [--pubkey <file|base64url>] [--note <id>]";
  if (args[0] !== "--file") return verifyLine(args, usage);
  let file = "";
  let pubArg: string | undefined;
  let noteId: number | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]];
    if (v === undefined) fail(usage, 2);
    if (k === "--file") file = v;
    else if (k === "--pubkey") pubArg = v;
    else if (k === "--note" && /^\d{1,15}$/.test(v)) noteId = Number(v);
    else fail(usage, 2);
  }
  const r = readReceipt(file);
  let pub: string | undefined;
  if (pubArg !== undefined) {
    pub = (existsSync(pubArg) ? readFileSync(pubArg, "utf8") : pubArg).trim();
    if (!PUB.test(pub)) fail("--pubkey must be a raw Ed25519 public key in base64url (43 characters, as `monomem trust identity` prints), or a file holding one", 2);
  }
  const store = pub === undefined || noteId !== undefined ? await openStore() : undefined;
  try {
    const ring = store ? { ...store.ownKeyring(), ...logKeyring() } : {};
    const key = pub ?? ring[r.key_id ?? ""];
    if (!r.sig) fail("Receipt NOT verified: it is not signed (written by a store with no signing key beside its audit log).");
    if (!key) fail(`Receipt NOT verified: it is signed by key ${printable(r.key_id, 32)}, which is not this store's key or one of its retired keys. Check it with --pubkey <that store's public key>.`);
    if (!verifyReceipt(r, key)) fail("Receipt NOT verified: the signature does not match (a field was changed, or it is from another key).");
    console.log(`Signature OK: ${describe(r)}.`);
    if (pub === undefined) {
      const v = verifyAuditChain(undefined, r.chain_hash, { keys: logKeyring() });
      if (!v.ok) fail(`Receipt NOT verified against the log: the audit chain is BROKEN (${v.breaks} break(s), ${v.bad_signature} bad signature(s)${v.head_key_trusted === false ? ", newest line under a key that is not this store's" : ""}).`);
      if (!v.anchor?.found) fail("Receipt NOT verified against the log: no line has its hash. The log was rewritten or cut off after it was issued, or rotated past it.");
      if (v.anchor.seq !== r.seq) fail(`Receipt NOT verified against the log: the line with that hash has seq ${v.anchor.seq || "(none)"}, not ${r.seq}.`);
      console.log(`Log OK: line ${v.anchor.line} of an unbroken, signed chain of ${v.lines} line(s) (${v.anchor.linesAfter} written after it).`);
    }
    if (store && noteId !== undefined) console.log(noteState(store, noteId, r));
    console.log(LIMITS);
  } finally {
    store?.close();
  }
}

/** --note: is the note's content still what the receipt names? Only hashes and the rev are printed, never note text. */
function noteState(store: Awaited<ReturnType<typeof openStore>>, id: number, r: Partial<WriteReceipt>): string {
  if (r.decision !== "accepted" || !r.content_hash) return `Note #${id}: this receipt names no accepted content (${printable(r.decision, 20)}), so there is nothing to compare.`;
  if (r.note_id !== undefined && r.note_id !== id) return `Note #${id}: this receipt is for note #${r.note_id}, not #${id}.`;
  const n = store.read(id); // gate-ok: verify-receipt --note: the operator compares a note with their own receipt; only a hash and the rev are printed
  if (!n) return `Note #${id} no longer exists (deleted); \`monomem history ${id}\` may still have the version you were given.`;
  return contentHash(n.title, n.body, n.tags) === r.content_hash
    ? `Note #${id}: unchanged since the receipt (rev ${n.rev}).`
    : `Note #${id}: changed later (rev ${n.rev}); \`monomem history ${id}\` has the version you were given (rev ${r.rev}).`;
}

async function verifyLine(args: string[], usage: string): Promise<void> {
  const [seqRaw, hashRaw] = args;
  const hash = hashRaw?.trim().toLowerCase();
  if (!/^\d{1,15}$/.test(seqRaw ?? "") || !HEX64.test(hash ?? "") || args.length > 2) fail(usage + "   (seq and chain_hash from the `receipt` a write returned)", 2);
  const r = verifyAuditChain(undefined, hash, { keys: logKeyring() });
  if (r.breaks) fail(`Receipt NOT verified: the audit chain is BROKEN at line ${r.brokenLine} of ${r.file} (it follows from none of the lines before it: a line was edited or removed). ${r.breaks} break(s) in all.`);
  if (!r.ok) fail(`Receipt NOT verified: ${r.bad_signature} bad signature(s) in the audit log${r.badSignatureLine ? `, first at line ${r.badSignatureLine}` : ""}${r.head_key_trusted === false ? "; the newest line is under a key that is not this store's" : ""}.`);
  if (!r.anchor?.found) fail("Receipt NOT verified: no line in the audit log has that hash. The line was edited or removed, the log was cut off or rotated past it, or the receipt is from another store.");
  if (r.anchor.seq !== Number(seqRaw)) fail(`Receipt NOT verified: the line with that hash has seq ${r.anchor.seq || "(none)"}, not ${seqRaw}.`);
  console.log(`Receipt OK: seq ${seqRaw} is line ${r.anchor.line} of the audit log, in an unbroken chain of ${r.lines} line(s) (${r.anchor.linesAfter} written after it).`);
  console.log(
    r.signed
      ? `The chain is signed (newest line under key ${r.head_key_id}). ${LIMITS}`
      : "This shows the line was not edited or removed since. It does not prove who wrote the log: these lines are not signed (no signing key beside the log)."
  );
}
