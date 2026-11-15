#!/usr/bin/env node
// Check a Monomem write receipt or audit checkpoint WITHOUT installing Monomem: plain Node 18+ and node:crypto.
//   node verify-receipt.mjs receipt.json <public key, base64url, from `monomem trust identity`>
// Exit 0: the holder of that key issued exactly this receipt. Exit 1: it did not (a field was changed, or another key).
// It does not prove the content is true, or anything against a program running as the store's user (that program can
// read the key). See SECURITY.md, "Audit log and receipts".
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [file, pub] = process.argv.slice(2);
if (!file || !/^[A-Za-z0-9_-]{43}$/.test(pub ?? "")) {
  console.error("usage: node verify-receipt.mjs <receipt.json> <public key, base64url>");
  process.exit(2);
}
let r = JSON.parse(readFileSync(file, "utf8"));
if (r.receipt) r = r.receipt; // the whole answer of a write is fine too
const keyId = createHash("sha256").update(Buffer.from(pub, "base64url")).digest("hex").slice(0, 16);
const bytes = JSON.stringify(["monomem-receipt-v2", r.server_id, r.seq, r.chain_hash, r.decision, r.ts, r.note_id ?? null, r.rev ?? null, r.content_hash ?? null]);
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
const ok = r.v === 2 && r.key_id === keyId && typeof r.sig === "string" && verify(null, Buffer.from(bytes), key, Buffer.from(r.sig, "base64url"));
if (!ok) {
  console.error("NOT valid: the signature does not match this key (a field was changed, or it was signed by another key).");
  process.exit(1);
}
const what = r.decision === "checkpoint" ? "checkpoint of the log head" : `${r.decision}${r.note_id !== undefined ? ` note #${r.note_id}` : ""}${r.rev !== undefined ? ` rev ${r.rev}` : ""}${r.content_hash ? ` with content ${r.content_hash}` : ""}`;
console.log(`valid: store ${r.server_id}, key ${r.key_id}, ${what} as audit line ${r.seq}/${r.chain_hash} at ${r.ts}`);
