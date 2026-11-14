# Search, recall and memory hygiene

## Semantic search (optional)

Keyword (FTS5) search is the default and needs nothing extra. Turn on
meaning-based search and the bridge will also embed each note so a query like
*"canine companion"* finds a note about your dog that shares no words with it:

```bash
export MONOMEM_EMBEDDINGS=on
export MONOMEM_EMBED_URL=http://localhost:11434/v1/embeddings  # Ollama default
export MONOMEM_EMBED_MODEL=nomic-embed-text
node dist/src/cli.js reindex   # backfill embeddings for existing notes
```

Embeddings come from **your own** OpenAI-compatible endpoint (local Ollama,
or any OpenAI-shaped `/v1/embeddings` API) — still zero native modules, still
nothing sent to a third party you didn't configure. `state_search` /
`GET /search` then accept `mode=keyword | semantic | hybrid` (hybrid fuses
both with Reciprocal Rank Fusion). If the endpoint is unavailable, search and
writes silently fall back to keyword — an optional embedder can never fail a
write or a query.

## Time-aware search

`state_search` takes an optional `when` parameter (and `GET /search` takes
`?when=`) with a natural-language time phrase. It scopes results to notes
**created** in that window; keywords still rank within it. An unrecognized
phrase is ignored — the query runs unscoped rather than erroring.

```
state_search({ query: "budget", when: "yesterday evening" })
state_search({ query: "",      when: "last week" })   # time-only: newest-first list of the range
GET /search?q=invoice&when=Oct+14
```

Supported phrases (case-insensitive, found anywhere in the string, so
`"yesterday about the budget"` works — the time part scopes, the rest ranks):

- `today`, `yesterday`, `3 days ago`, `a day ago`
- `last week` / `this week` (weeks start **Monday**), `last month` / `this month`
- `in july`, `in july 2025` (bare month = most recent such month, never future)
- Dayparts: `this morning`, `yesterday evening`, `tonight`, `last night`
  (morning 05–12, afternoon 12–17, evening 17–22, night 22–05 next day;
  `tonight` = 17:00 → 05:00 next day)
- Clock times: `around 3pm`, `at 14:30`, `3pm yesterday` (±30 min window)
- Absolute: `2026-10-14`, `Oct 14`, `October 14 2025`, `10/14/2026`
  (numeric dates are **MM/DD**; a missing year means the most recent past occurrence)

Day boundaries are computed in your timezone: set `MONOMEM_TIMEZONE`
(e.g. `America/Winnipeg`, default: the host's system timezone). Invalid names fall back to UTC.

## Time travel (`--as-of`)

`monomem search "deploy region" --as-of 7d` shows memory as it stood then (an ISO time, `2h`, `2026-10-01`). `monomem relevant ... --as-of` is the same flag on the same code, so the two read alike. With no words it lists the notes. Add `--json` for machine output. Times are printed in your local time with the UTC offset. `monomem why` and `monomem receipts` print times the same way. JSON output and MCP replies keep ISO 8601 times in UTC (`2026-11-05T18:03:00.000Z`). The MCP tool `state_search` takes the same thing as `as_of`, for an admin token only: a past view brings back earlier versions (which can hold text that was taken out on purpose) and notes that were forgotten since, the same reason note history is admin-only. It only reads; nothing is written.

Each hit shows a short snippet of the old text, an `[edited since]` marker when the note changed after that time, and `writer then:`. For old text the writer and version number come from the note's history (the same record `monomem why` reads), never from today's note. When history does not say, the line reads "writer then: not recorded" (in JSON and MCP the `written_by` and `rev` fields are left out and `writer_then` says "not recorded").

It is rebuilt from what Monomem already keeps: creation time, the saved earlier versions (`note_history`), the replace log (`supersede_log`) and an archive log (`archive_log`). A note made after that time is absent. A note archived or replaced before it is hidden, unless it was restored or the replacement undone before it. A note edited since shows the version that was current then, without today's writer, confidence or attestation fields (history does not keep those). The header says how many notes were archived or replaced at that time and are not shown. Over MCP, `as_of` is admin-only.

`archive_log` is a small table (note id, time, archived or restored; no text) filled by a database trigger on every archive, expiry or decay sweep, replace, restore and undo. It was added without a schema version change (created if missing when a writer opens the database). It starts when your database is first opened by this version (that first open, even to read, writes the table and trigger once; later opens write nothing); the header line says since when. Before that, an archive followed by a restore is not known and the note shows as live. Deleting a note deletes its rows.

What it cannot do, and says so:

- A version that was pruned (default: 20 kept per note) or purged is gone. That note is listed as "text from that time not kept" and counted in the header. The newer text is never shown in its place.
- A note deleted for good (hard delete) is not shown. No text survives a hard delete.
- Only text changes make history. Tag or source edits are not reconstructed, and a note whose only later change was such an edit has no recorded writer for the old text. If history was switched off (`MONOMEM_HISTORY_VERSIONS=0`), an edited note is "not kept".
- Search at a past time scores the rebuilt notes with the keyword scorer (share of your words found, newest first on ties). It does not use the search index, which only holds today's text, and has no semantic ranking, time phrases or writer filters.

## Relevant-memory search

Don't know the exact wording? `state_search` with `mode: "relevant"` (or the
separate `state_relevant` tool, which is no longer registered by default) takes a natural conversational
message, extracts keywords from it (lowercase, stop-words removed, hashtags
like `#status` kept as-is), and returns notes matching **any** of them —
a deliberately permissive OR search, unlike `state_search`'s AND conjunction.
Results rank by most keyword hits first, then newest. The extracted keywords
are returned alongside the results so you can see what was searched.

```
state_search({ query: "what did we decide about the acme launch?", mode: "relevant" })
# same as state_relevant({ message: "..." }); `when`, `explain` and `include_superseded` do not apply
# -> { keywords: ["decide", "acme", "launch"], results: [...] }
```

Same over HTTP: `POST /relevant` with `{ message, limit?, namespace? }`
(read-scoped), and on the CLI: `monomem relevant "some message" [--limit 5]`.

## Staleness detection

Facts go stale. `state_read` and `state_search` (and `GET /notes/:id`,
`GET /search`) annotate every note with `stale: boolean` and
`ageDays: number` (whole days since `updated_at` — the most recent write
wins). When a note is stale, a `staleWarning` string is included, e.g.:

> "This note is 45 days old (tagged #status, expires after 30 days).
> Verify against current state before acting on it."

Stale notes are never hidden or deleted — they stay findable, but search
ranks them slightly lower (their score is multiplied by 0.9), so a fresh
note with comparable relevance wins. Agents should verify a stale note
against current state before acting on it.

**A stale note stays behind its newer twin (1.6.0).** The 0.9 factor is mild, so a 200-day-old note that matches the words better could still
come first. Now, when a stale note has a newer, fresh note that is *about the same thing* (the two are linked as similar notes), the stale one is
placed right behind the lowest-ranked of its fresh newer twins. It is still returned and still flagged, and `explain` says "Kept behind the newer note #N on the same topic."
A stale note that people keep reading (a clearly active read signal) keeps the place its reads earned. Notes that are not similar to anything are
untouched. To remove an out-of-date note from search entirely, replace it ([replacing-memories.md](./replacing-memories.md)).

Thresholds (env vars, read live — no restart needed to retune):

| Variable | Default | Meaning |
|---|---|---|
| `MONOMEM_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are stale |
| `MONOMEM_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `MONOMEM_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `MONOMEM_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |

Invalid values fall back to the defaults. Staleness is per-note and
namespace-agnostic — it never crosses (or needs to know about) namespace
isolation boundaries.

## Labels on notes (1.4.0)

Search results, reads, session-start index lines, recall summaries and the dashboard can carry three labels. Each is also
a field on the record (only when set), so a program can check it:

| Label | Field | Meaning | In search | At session start |
|---|---|---|---|---|
| `[unconfirmed - from outside content]` | `unconfirmed`, `unconfirmed_label` | Written after an outside read Monomem could see; nobody has confirmed this version ([trust.md](./trust.md#outside-content-and-taint-140)) | returned, score x0.9 | left out; one count line |
| `[expired - not re-confirmed in 30 days]` | `expired`, `expired_label` | Nobody changed or confirmed it within the re-confirmation period (the number follows `confirm-days`) | returned; x0.9 only in `enforce` | shown with the label; left out only in `enforce` |
| `[built on a distrusted writer]` | `built_on_distrusted`, `built_on_distrusted_label` | Its `derived_from` names a note a distrusted writer touched (one hop) | returned | left out |

None of them hides, archives or deletes a note. An unconfirmed note that is also expired in `enforce` mode is ranked at
most x0.81.

## Re-confirmation expiry

A fact can stop being true without anyone noticing. Expiry asks a person (or a second agent) to stand behind a note again
every so often.

**When a note is due.** Due = the latest of these, plus `confirm-days` (default 30):

- its last edit (`updated_at`);
- the last confirm of its current version;
- the 1.4.0 upgrade (`grandfathered_at`, on notes that existed then);
- the last time the mode was changed.

It is computed on every read, never stored. Pinned, archived and replaced notes and captured rows (observations, session
summaries) never expire. A confirm by another agent after a stronger confirm (a person's, or an admin key's) is recorded
but does not restart the clock.

**Modes.** Set with `monomem config set confirm-mode <mode>` ([configuration.md](./configuration.md#settings-kept-in-the-store-monomem-config)):

| Mode | What an expired note gets |
|---|---|
| `off` | nothing |
| `label` (default) | the `[expired - ...]` label on reads, search and index lines. Ranked as before, still at session start |
| `enforce` | the label, left out of session start (one line: `Monomem: N notes not re-confirmed in 30 days (not shown). Review: monomem review`), and score x0.9 in search |

No mode ever archives or deletes a note for being expired.

**What this means after an upgrade.** Nothing changes on day 1. About 30 days after upgrading, notes that nobody edited
or confirmed since start showing `[expired - not re-confirmed in 30 days]`. They are still shown and ranked as before. To
turn the label off: `monomem config set confirm-mode off` (asks you to type yes). To make expiry hide notes from session
start: `monomem config set confirm-mode enforce`. The clock then restarts for every note.

**Re-confirming.** `monomem confirm <id> --source "what you checked"` (a person; see [trust.md](./trust.md#confirming-notes)),
or `monomem review` to see every expired and unconfirmed note with the reason, and `monomem review --confirm-all` to
confirm them all as you after one typed yes. A confirm's reply ends with `Next check due YYYY-MM-DD.` while expiry is on.
The same writer can confirm the same version again once its last confirm is older than the period.

`monomem doctor` and `monomem health` print the mode, the period and how many notes are past due.

Not yet: per-tag or per-writer periods, per-namespace `enforce`, and a warning before notes expire (planned for 1.4.1).

## Consolidation (dedup)

Agents re-storing the same fact ("our API base URL is …" saved three times
in slightly different words) bloats the store and muddies search results.
Consolidation finds near-duplicates by **cosine similarity over
term-frequency vectors** (title + body, lowercase, stopwords removed;
Jaccard available as a secondary metric — zero new dependencies) and merges
them: longest title wins, bodies are deduplicated and joined with `---`,
tags are unioned.

**Candidate detection never crosses namespaces** — namespaces are an
isolation boundary, so a pair is only ever suggested when both notes live in
the same one. Detection is O(n²) and capped: beyond 2,000 notes (or ~2 MB
of title + body text) only the most recently created notes are scanned.

MCP tools:

| Tool | Scope | What it does |
|---|---|---|
| `memory_consolidation_candidates` | **admin** | Lists near-duplicate pairs (score ≥ threshold, default 0.95) with both titles so the model can judge. Admin because the scan is O(n²) CPU; one scan runs at a time, under a 15 s budget, and stops if the client disconnects |
| `memory_consolidate` | **admin** | Merges 2+ ids into one note. `dry_run: true` previews the merge without writing; `keep_sources: true` skips deleting the originals. Gated at admin because it deletes, like `state_delete`. |

CLI (safe by default — reports only, unless you opt in):

```bash
node dist/src/cli.js consolidate                          # list candidates
node dist/src/cli.js consolidate --dry-run                # preview each merge
node dist/src/cli.js consolidate --yes                    # actually merge
node dist/src/cli.js consolidate --threshold 0.98 --namespace acme
```

**Scheduled auto-consolidation** (opt-in):

```bash
export MONOMEM_AUTO_CONSOLIDATE_INTERVAL=24h   # or "30m", "90s", "3600" (seconds)
```

When set, `monomem start` runs a background pass on that interval that
**logs** every candidate pair ≥ 0.95 for review — and only auto-merges pairs
scoring **≥ 0.99** (near-identical notes, e.g. the same fact saved twice
verbatim). Weaker duplicates are never merged blindly; review them with
`memory_consolidation_candidates` or the CLI. The scheduler never throws: a
background janitor must not take down the server.
