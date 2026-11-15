// Idempotency keys on note writes (R2-04, 1.5.0). A writer passes `client_key` on state_write / POST /notes; a retry with the
// same key from the same writer returns the note the first write made (deduplicated: true) and writes nothing, so it is not
// counted by the flood guard either. Keys are per writer (another writer's same key is its own) and stored hashed. Free
// functions over the Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import { createHash } from "node:crypto";
import type { NoteInput, NoteRecord, Store } from "../store.js";
import { currentWriter } from "../actor.js";
import { ValidationError } from "../errors.js";

/** The same shape tasks accept for their client_key. */
const CLIENT_KEY = /^[A-Za-z0-9._:@/+=-]{1,128}$/;

export function checkClientKey(key: unknown): string {
  if (typeof key !== "string" || !CLIENT_KEY.test(key)) {
    throw new ValidationError("client_key must be 1-128 characters of letters, digits and . _ : @ / + = -");
  }
  return key;
}

function keyHash(key: string): string {
  return createHash("sha256").update(`monomem-nkey-v1\0${key}`).digest("hex").slice(0, 32);
}

/** The note this writer's key made, when the key is known (null = first use). */
function keyedNote(s: Store, key: string, namespace: string | undefined): NoteRecord | null {
  const row = s.db.prepare("SELECT note_id FROM note_client_keys WHERE writer = ? AND key_hash = ?").get(currentWriter(), keyHash(key)) as { note_id: number } | undefined;
  if (!row) return null;
  // s.read hides a note above the caller's ceiling. A note this request may not get back (relabelled above the ceiling,
  // moved to another namespace) is refused rather than written twice; it is the caller's own key, so nothing leaks.
  const n = s.read(row.note_id); // gate-ok: client_key replay: the writer's own earlier note, ceiling applied by read()
  if (!n || (namespace !== undefined && n.namespace !== namespace)) {
    throw new ValidationError("this client_key was already used for an earlier note this request cannot return; use a new key");
  }
  return n;
}

/** create() calls this inside its write transaction, right after the INSERT. A concurrent twin fails on the primary key. */
export function recordClientKey(s: Store, id: number, writer: string, key: string, at: string): void {
  s.db.prepare("INSERT INTO note_client_keys (writer, key_hash, note_id, at) VALUES (?, ?, ?, ?)").run(writer, keyHash(key), id, at);
}

export function createOnce(
  s: Store,
  input: NoteInput,
  clientKey: string | undefined,
  opts: Parameters<Store["create"]>[1] = {}
): { note: NoteRecord; deduplicated?: true } {
  if (clientKey === undefined) return { note: s.create(input, opts) };
  const key = checkClientKey(clientKey);
  const namespace = input.namespace?.trim() || undefined; // unset = the default namespace of an unpinned caller: no boundary to keep
  const hit = keyedNote(s, key, namespace);
  if (hit) return { note: hit, deduplicated: true };
  try {
    return { note: s.create(input, { ...opts, clientKey: key }) };
  } catch (e) {
    // Two retries raced: the loser's insert hit the key's primary key and rolled back. Return the winner's note.
    const won = keyedNote(s, key, namespace);
    if (won) return { note: won, deduplicated: true };
    throw e;
  }
}
