# What "lossless" means in Monomem, and how it is checked

Monomem 1.8.0 (schema v23) defines "lossless" as six invariants and checks them with code, not with a promise.
`monomem verify-lossless` (also `monomem audit verify --db`, and a line in `monomem doctor`) runs the cheap ones on your own database.

**The definition.** Every write Monomem acknowledged is either still the live text, or kept as an earlier version, or its removal is
recorded in the ledger. Nothing is overwritten without a record. Exceptions, by design: NUL bytes and lone UTF-16 surrogates are stored
as U+FFFD; versions beyond the history limit (`MONOMEM_HISTORY_VERSIONS`, default 20) are dropped and counted in `note_history_dropped`;
notes that existed before the v23 upgrade have no earlier history in the ledger (they enter as `adopt`).

| | Invariant | Checked by |
|---|---|---|
| L1 | Ack implies ledger: every `(note id, rev)` a client was told about has a content-changing ledger entry | `missingAcks` (test: random multi-process writes, one writer killed with SIGKILL) |
| L2 | One body per revision: a `(note id, rev)` has exactly one ledger entry (a database UNIQUE index), and a stored earlier version matches its keyed body digest | doctor, `verify-lossless` |
| L3 | A note's revisions only go up, with no repeat | doctor, `verify-lossless` |
| L4 | Nothing vanishes: every note the ledger saw is live, archived, or has a `delete` entry | ledger reconciliation |
| L5 | Export then import into an empty store keeps every title, body and tag | test (`lossless-property`) |
| L6 | A stored earlier version always has a ledger entry (no planted history) | doctor, `verify-lossless` |

**How it works.** Every note row has a `seal` (HMAC over its columns). Every Monomem write changes the note, re-seals it and appends a
signed, hash-chained ledger entry in one transaction under the one write lock: they commit or roll back together, and the chain cannot
fork. Two processes writing the same note without `if_rev` are both kept, each with its own revision (a test spawns two real OS
processes). The cheap checks cost about 3 s on 100,000 notes (see the numbers in the release notes).

**What it does not do.** The seal key comes from `.attest-key`. A program that can read that file as you can seal a forged note and
rewrite the ledger; nothing local stops it. It catches edits by anything that cannot read the key, and it makes a key-holder's rewrite
visible only against something kept elsewhere (`monomem audit checkpoint --out <file>`, or a write receipt an agent holds).
It does not prove a note is true, and it says nothing about notes edited before the upgrade sealed them.

**Commands.**
- `monomem verify-lossless [--full] [--json]`: the checks above (`--full` also verifies every ledger signature). Exit 1 on any failure.
- `monomem integrity seal`: finish sealing notes that existed before the upgrade now (otherwise it happens in short batches at open).
- `monomem integrity reseal --yes`: you looked at what doctor named and accept every note as it is now (also the way out after a key restore without the key file).
