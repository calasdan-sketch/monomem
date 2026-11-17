# Encryption at rest, retention, and retrieval visibility

Three additions aimed at running Monomem as a *shared* memory service,
where "my notes" may be read by several agents and devices. Each section
leads with the tradeoff, not the marketing.

---

## Encryption at rest (AES-256-GCM)

Note **bodies** are encrypted on disk with AES-256-GCM. The key is a
32-byte file at `~/.monomem/.key` (mode `0600`), created on first
`monomem encrypt enable`.

```bash
monomem encrypt enable     # create the key, encrypt existing bodies
monomem encrypt status     # on/off, key path, encrypted note count
monomem encrypt disable    # decrypt bodies and remove the key
```

### What is protected, and what is not

This is the part most tools omit, so read it before enabling. `monomem encrypt status --surfaces` (1.5.0) prints this
list for **your** store, with counts of what is sealed and what is plain right now (`--json` for a script). Every bold
name below is one line of that report:

| | Protected? | Why |
|---|---|---|
| **Note bodies** | **Yes** — AES-256-GCM at rest | The sensitive part (pasted secrets, private context). Bodies written before the key existed stay plain until `encrypt enable` seals them; the report counts them |
| **Note titles** | No | Keyword search and namespace isolation both need it in plaintext |
| **`written_by` / `created_by`** (who wrote it) | No | Server-stamped token label or `stdio`/`cli`/`server`; filtering needs it in plaintext, and it is never note content |
| **Tags**, timestamps, namespace | No | Same: filtering, search and isolation read them directly. Facts are tags too |
| **Sources** | No | The `source` a writer claims for a note, and the source named when confirming one |
| Access counters | No | Ranking input; not sensitive |
| **Old versions** (`note_history`) | Body: yes, when a key exists | Earlier versions of an edited note. The body is sealed like a note body; the old title and tags stay plain |
| **Held writes** (table `quarantine`) | Yes, when a key exists | Title, body and tags of a write waiting for approval are all sealed, bound to their queue row |
| **Embeddings** (`note_vectors`) | No | Vectors are stored unencrypted, and with `MONOMEM_EMBEDDINGS=on` the **decrypted body is sent to your embeddings endpoint** when a note is embedded. Leave semantic search off if that matters |
| **Captured prompts and tool output** (`capture_events`) | Yes, when a key exists | The raw events the capture hooks record (kept 7 days). Events recorded before the key existed are sealed by `encrypt enable` |
| **Captured titles and tags** (automatic capture) | Kept out of them (1.5.0) | With a key present, a captured note gets a fixed title ("Decision (sealed)", "Session 2026-11-14"), the sentence it was built from goes into the sealed body, and no `obs.concept:<word>` tags are made. Notes captured **before** the key existed, or by a version before 1.5.0, keep their old titles and tags: `encrypt enable` seals bodies, it does not rewrite titles |
| **Captured file paths and folders** (`note_files.path`, `sessions.cwd`) | No | The files a session edited or read, and the folder it ran in, are kept as plain paths so "what does memory know about this file" works. A secret in a file or folder name stays readable |
| **Code anchors** (`code_anchors`, 1.5.0) | No | The files a note says it is about (`files` on `memory_save` / `POST /notes`): the repository folder, each file path and git's ids for the file and commit. Kept plain because every read compares them with git. They are names, not note text, but a file name can say what a note is about (`src/payroll-export.ts`), so leave `files` out of a note whose subject must stay private |
| **Claim checks** (`code_claims`) | No | A note's `claims` on `memory_save`: the repository folder, file paths, the check text (`contains` text, a package name) and hashes of cited lines. Kept plain because reads re-check them ([claim-checks.md](./claim-checks.md)) |
| **Capture spool** (`capture-spool.jsonl` in the data folder) | Yes, when a key exists (1.5.0) | Each waiting hook event is sealed and bound to its line id. Lines spooled before 1.5.0 or before the key existed stay plain JSON until the next hook takes them in |
| Captured tool names, event times, the model name | No | Needed to list sessions; not your text |
| **Search index** (FTS) | No — and **sealed bodies are not indexed on disk** | It holds every title and tag, and the body of any note still stored plain. See below |
| **Body search index** (in memory, 1.5.0) | Not on disk | While encryption is on, each Monomem process that searches (the servers build it at start) holds an index of every body's words, decrypted, in RAM only. Monomem never writes it to the database, the WAL or a temp file. The operating system **can** page it to swap or a hibernation file, and a crash dump can contain it. The session-start hook never builds the body index; it uses a running Monomem server's index for this store if there is one, else it matches titles and tags. `MONOMEM_BODY_INDEX=off` turns it off. See below |
| **Change feed log** (`change_log`) | No | The titles of recent changes, kept for the change feed (`monomem activity`) and pruned after its retention period |
| **Observed evidence** (`note_evidence`, 1.6) | Yes, when a key exists | What a writer said it observed for a note (`evidence` on `memory_save`): kinds and references such as `src/a.ts:12`, a command or a URL, after the secret redactor. Evidence saved before the key stays plain. Removed when its note is deleted |
| **Access log** | Yes, when a key exists | The redacted, 120-character preview of what each read asked for ([access-log.md](./access-log.md)) |
| **Audit log** (`audit.log`) | No note text | Operations, ids, namespaces and byte counts only, by design |
| **Server log** (`server.log`, `start --log`) | No note text | Paths, ports and error messages; Monomem writes no note text there, but the file itself is plain |
| **Backups** | Not checked by the report | A backup is a copy of the database as it was: whatever was sealed then is sealed in it, and the key is only included with `--include-key`. Pre-upgrade copies made before encryption hold plain bodies; the report counts them |
| **Exports** | No | `monomem export` (JSON or a Markdown folder) and `GET /export` write **decrypted** bodies (see Export below) |
| **Sync conflicts** (`sync-conflicts/` in the data folder) | No | When `sync --git` meets an edit conflict, the losing side is kept here as plain Markdown, decrypted. Delete a folder once you have checked it |
| **Project rules files** (`AGENTS.md` / `CLAUDE.md`) | No | `monomem project-rules` copies the **decrypted** bodies of confirmed notes into the repository's rules file, which is usually committed. It prints the namespaces it drew from; without a namespace setting for the folder it draws from every namespace, so pass `--ns <namespace>` to keep it to one |
| **Sync files** | Not checked by the report | `monomem sync --git --encrypt` seals every file ([file-sync.md](./file-sync.md)); without `--encrypt` the repository holds plain Markdown |

**The search tradeoff, stated plainly.** `notes_fts` is a SQLite
external-content FTS5 index over `notes(title, body, tags)`, maintained by
SQL triggers. You cannot index encrypted text. So when encryption is on,
the plaintext `body` column is left **empty**, ciphertext lives in a
separate `body_enc` column, and the **on-disk** index holds titles and tags only.

Since 1.5.0, body search still works on an encrypted store, from a second index that exists **only in memory**:

- **Who has it.** Any Monomem process that runs a keyword search while a key is present: the REST, MCP HTTP and stdio MCP
  servers build it just after they start, and a one-off CLI `search` builds it on its first search. It indexes every
  note's title, decrypted body and tags, so ranking is the same as on a plain store (LongMemEval-S keyword R@5 97.2
  encrypted and plain; see [BENCHMARK.md](./BENCHMARK.md)). It is kept current as notes change, including changes made by
  other Monomem processes.
- **Who does not.** The hooks (session start, per-prompt recall, capture, file context) never build it, to keep session
  start fast: on an encrypted store the context they add is chosen by titles, tags, files and recency. Session start also
  asks a Monomem server for the same store, when one runs on this computer, which notes' bodies match (127.0.0.1 only, at
  most 0.3 s; the hook sends its key only after the server proves it holds the same key and store, and takes back only
  note ids). With no server running, body words do not reach session start: give notes titles and tags that say what
  they are about.
- **Cost.** About 0.5 s to build at 10,000 notes and 4-6 s at the 100,000 cap. Memory: `monomem bench --scale` measures
  about +22 MB at 10,000 and +155 MB at 100,000 inside an already-running process; a freshly started server grows by about
  +60 MB at 10,000 and about +235 MB at 100,000 (to about 305 MB in total). That is in **each** process
  that has it (five apps each running their own stdio server hold five copies). Above 100,000 notes it is not built:
  search there covers titles and tags only, and the CLI search says so. Any search that runs on titles and tags only
  while bodies are sealed (over the cap, a search inside a write before the index is built, or a failed build) says so in
  its reply: a `body_search` field on REST `/search` and `/relevant` and on MCP replies. Each is counted; `GET /status`
  (admin) and `monomem check --setup` show the count and the last reason.
- **Automatic backups keep it longer.** A deleted or purged note stays in the daily backups (`<data folder>/backups/`, 7 daily
  plus 4 weekly copies) until they rotate out, up to about 5 weeks. To remove it now, delete the `backups/` folder (or the dated
  folders made since the note was written).
- **After a purge.** A purged note leaves the index at once, so search cannot return it. Its words can still sit in the
  server's in-memory index (search no longer finds them, but its stored data is not rewritten at once) until that server restarts; restart the servers after a purge you care
  about. A store that was over the 100,000 cap and is purged back under it gets its index again after the server restarts.
- **What it changes for security.** Nothing new is written to disk by Monomem: someone who copies the database file, its
  WAL or a database-only backup still gets no body text. But while a server runs, **every body's words are in its
  memory**, with their positions (enough to rebuild much of the text). The operating system can write that memory to disk:
  the swap file or `pagefile.sys`, the hibernation file (`hiberfil.sys`), and crash or core dumps. Whole-disk encryption
  (below) covers all three; on Linux also consider `ulimit -c 0`. If you would rather not hold decrypted words in RAM at
  all, set `MONOMEM_BODY_INDEX=off` (each process reads it when it opens the database): search then covers titles and
  tags only, as before 1.5.0.

For **full-file** protection (titles included, search index included), use
OS disk encryption — BitLocker (Windows), FileVault (macOS), LUKS (Linux) —
in addition to, not instead of, this.

### Guarantees and failure modes

- Each write draws a **fresh 12-byte IV**, so the same note written twice
  produces different ciphertext (no deterministic leak).
- The GCM **auth tag** detects tampering with the ciphertext: it fails
  loudly on read rather than handing an agent corrupted memory. In 1.2.0 the
  tag did not cover the note id or namespace, so ciphertext copied between
  rows still decrypted; 1.2.1 binds it to the row (see the CHANGELOG). A
  wrong/tampered key throws — it is never swallowed.
- **Encryption gives confidentiality, not rollback protection.** Someone
  who can write the database file but has no key (a database synced through
  a cloud folder while the key stays local, for example) cannot read or
  forge a body, but can put back an **older** sealed body of the same note
  from any earlier copy of the file: it decrypts, because the seal binds the
  note id and namespace, not its version. Held writes are bound to their own
  queue row (1.5.0), so one cannot be moved into another. Access-log rows
  are not bound to their row at all, so they can be reordered or swapped.
  Keep the database where only you can write it; for git sync, see
  [file-sync.md](./file-sync.md).
- The key file is written via **temp file + atomic rename**, so a crash
  cannot leave a truncated key that silently fails to decrypt existing
  notes.
- **The key sits beside the database**, so a backup of the whole data
  directory carries both. Back the key up separately from database backups.
- **The attestation signing key** (`.attest-key`, 1.4.0; [trust.md](./trust.md)) is a separate Ed25519 file beside
  the database. It does not encrypt anything, is not copied by `monomem backup`, and is not needed to read
  your data; losing it only changes the identity your exports are signed with.
- **Losing the key file loses the bodies.** Back it up. There is no
  recovery path, by design.
- A corrupt (wrong-size) key file is a **hard error at startup**, not a
  silent fallback — degrading would write new notes with no key while old
  ones stay encrypted.

### Export

`GET /export` returns **decrypted** bodies (it requires an admin key).
An export is therefore plaintext; store it accordingly. Re-importing into
an encrypted store re-encrypts.

---

## Retention controls

Per-note time-to-live with **soft archive**, never silent deletion.

```bash
# Set a TTL when writing (days)
curl -X POST localhost:8790/notes -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Scratch","body":"temp context","forget_after":7}'
```

- `forget_after` (days) is stored as an absolute `expires_at` deadline.
- `forget_after: 0` clears a deadline; omitting it on update **preserves**
  the existing one (an unrelated edit never silently drops your TTL).
- The sweep archives every past-due note. It is idempotent and returns the
  count, so it is safe on a timer.
- **Nothing runs the sweep for you.** Until something calls it, a note past
  its deadline still appears in search and recall. Put the call on a timer
  (cron, Task Scheduler) if you rely on TTLs.

```bash
curl -X POST localhost:8790/sweep-expired -H "Authorization: Bearer $TOKEN"
# {"archived": 3}

curl -X POST localhost:8790/notes/42/archive -H "Authorization: Bearer $TOKEN"  # forget
curl -X POST localhost:8790/notes/42/restore -H "Authorization: Bearer $TOKEN"  # bring back
```

An **archived** note is excluded from `list`, keyword search, semantic
search and the SessionStart recall hook — it is genuinely forgotten by
every read surface — but it stays on disk and is restorable. This is the
reversible alternative to `DELETE` for "forget this".

`GET /notes` hides archived notes by default; `?includeArchived=1` shows
them all, `?archived=1` shows only the archive (the restore view).

> A TTL's deadline is computed from `updated_at`, so **editing a note resets
> its clock**. That is the intended semantic for "forget this N days after I
> last touched it"; set an absolute deadline via the API if you need
> otherwise.

---

## Retrieval visibility ("why did I get this?")

Search ranking is three multiplicative stages — native relevance
(bm25 / cosine / RRF) → recency-decayed access boost → graded staleness
penalty — and every intermediate used to be discarded. An agent could see
*which* notes came back but never *why* one outranked another.

`GET /search?q=...&explain=1` attaches a `breakdown` to each result,
computed from the **same functions the scorer uses**, so the explanation
cannot drift from the ranking:

```json
{
  "results": [
    {
      "id": 12,
      "title": "VPN setup for office",
      "breakdown": {
        "finalScore": 3.412,
        "baseScore": 3.1,
        "accessBoost": 1.09,
        "stalePenalty": 1.0,
        "accessCount": 4,
        "daysSinceAccess": 1.2,
        "ageDays": 3,
        "stale": false,
        "explanation": "strong text match; read 4x, last 1d ago (boost x1.090); fresh (3d old)."
      }
    }
  ]
}
```

The identity `finalScore = baseScore × accessBoost × stalePenalty` holds
exactly (verified in `test/explain.test.ts`). Results and their **order are
identical** with and without `explain=1` — explaining never reorders.

---

## The evaluation set

`evals/cross-device-tasks.json` is a small set of *repeated cross-device
memory tasks*: a fact written from one surface (desktop, phone, claude.ai,
cursor) and recalled later from a different one. `test/evalset.test.ts`
seeds a fresh store per task, runs each query, and scores retrieval with
recall@1, recall@5 and MRR, gating so a ranking or schema change that
quietly degrades retrieval fails CI.

It exercises **both** retrieval paths, because an agent has both:

- `memory_search` (formerly `state_search`) — keyword, **AND**-conjunction of prefix tokens. Precise,
  but a natural-language question ("what did we ship in standup") matches
  nothing, because common words like "what"/"we"/"did" are not in the note.
- `memory_search` with `mode: "relevant"` (formerly `state_relevant`) — **OR** semantics with keyword extraction, built
  exactly for vague messages.

The gate is measured **best-of-both-paths** (what a user experiences), and
the harness *reports* keyword-only recall alongside it so the AND-search
limitation stays visible instead of papered over:

```
[eval] cross-device retrieval over 10 tasks (best of keyword+relevant): recall@1=1.000 recall@5=1.000 mrr=1.000
[eval] keyword-only (state_search, AND) recall@1=1.000
```

**Read this score honestly.** The set is 10 tasks over a 10-note corpus,
and every query reuses words from its target note, so it is lexically easy.
A perfect score is a **regression gate** (it catches a ranking, FTS or schema
change that breaks retrieval), **not a claim about retrieval quality**.
Paraphrased queries such as "how do I connect remotely to work" against a
note titled with "wireguard vpn" do not match, and the surface a note was
written from is not exercised. Treat the gate as a floor.

To grow the set, add `{ query, expected, why }` entries. `expected` is the
exact title of the note that should rank for `query`. Keep queries
realistic and the expected note unambiguous; the harness is deterministic
(access boost disabled, fresh store per task) so results reproduce exactly.
