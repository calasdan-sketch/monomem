# Sensitivity labels

Every note carries a label, and every token can carry a ceiling. A token never reads, searches,
lists, exports or changes a note above its ceiling, on every note route. Without this, every connected app
that holds a token can read everything in its namespace.

Labels, lowest to highest: `public` < `internal` < `private`.

- A note with no label is `internal`. Existing notes became `internal` when the database upgraded
  (schema 17).
- A token with no `max_sensitivity` behaves as it always did: it sees every label. Setting one is
  recommended for any token you hand to an app you do not fully trust.

## Setting a ceiling on a token

In `tokens.json` or `MONOMEM_TOKENS`:

```json
[
  { "token": "…", "scope": "read",  "label": "slack-bot", "max_sensitivity": "public" },
  { "token": "…", "scope": "write", "label": "work-agent", "namespace": "work", "max_sensitivity": "internal" }
]
```

- A typo (`"privte"`) refuses that token at start-up with a message. It is never treated as "no
  ceiling".
- The primary token (`MONOMEM_TOKEN`) cannot carry a ceiling.
- A token listed twice keeps the lower ceiling; a ceiling beats none.
- A ceiling and a namespace pin combine: the token sees only its namespace, and only notes at or
  below its ceiling.

## What a ceiling does

| Action | Over the ceiling |
|---|---|
| read, get, list, search (keyword, semantic, hybrid), relevant, timeline, index | not found, the same answer as a note that does not exist |
| counts, stats, change feed, file-context, neighbours, history, tasks | the note is left out, counts included |
| write a note | rejected (`400`) if the label is above the ceiling. An unlabelled write gets `internal`, or the ceiling if that is lower |
| relabel | cannot go above the ceiling. Lowering a label needs an `admin` token |
| update, delete, archive, restore, supersede a hidden note | not found, nothing changes |
| held (quarantined) writes | hidden the same way; approving one keeps its label |
| consolidate | the merged note gets the strictest label of its sources |
| `why`, receipts (`memory_receipt`), the pinned list, rollback plans, fact-conflict warnings, session-neighbour boosts | a hidden note is left out; a replacement it cannot see is called "another note" |
| the read access log (`/access`) and the meter totals in `/stats` | not available to a key with a ceiling: they hold what every app searched for and token totals that are not split by label |

A hidden note leaks no title, snippet, id, count or error difference. The check is made inside the
store (SQL for lists, search and vectors; a guard on every by-id path), not in each route, so a new
route does not need to remember it.

## Which way an app connects matters

A ceiling belongs to a **token**, and only the HTTP server (REST and `/mcp`) checks tokens. The stdio
server (`monomem mcp`, what `monomem setup` wires by default) has no token: the app that starts it
reads every note. So:

- An app you want to keep away from private notes must connect over HTTP with its own token that has
  a `max_sensitivity` (see [give-an-app-limited-access.md](./give-an-app-limited-access.md)).
- If an app must use stdio, set `MONOMEM_STDIO_MAX_SENSITIVITY` in its `env` block. That is a cap you
  set yourself, so only trust it for apps that do not edit their own config.
- `monomem doctor` warns when an app is wired over stdio while private notes exist.

Changes to `tokens.json` apply within about two seconds without a restart. A removed token stops
working at once, and a new ceiling applies to that token's next request.

## Labelling notes

- MCP and REST: `state_write` / `POST /notes` / `PUT /notes/:id` accept `sensitivity`.
- Operator: `monomem label <id> [public|internal|private]` shows or sets a label. The CLI has no
  ceiling, so the operator can relabel anything.

## Operator-side settings

| Variable | Effect |
|---|---|
| `MONOMEM_RECALL_MAX_SENSITIVITY` | session-start and file-context hooks leave out notes above it. The hooks read the database directly with no token, so this is how you cap them. A bad value injects nothing |
| `MONOMEM_DEFAULT_MAX_SENSITIVITY` | opt-in: a ceiling applied to every secondary token that sets none. A bad value stops the server. At start-up Monomem also warns once if any note is labelled and a secondary token has no ceiling |
| `MONOMEM_ALLOW_PRIVATE_REMOTE` | `1` lets private notes be sent to an embeddings endpoint. Unset, private notes are not embedded (keyword search still finds them) |
| `MONOMEM_EXPORT_MAX_SENSITIVITY` | Markdown vault export writes nothing above it and removes earlier files for such notes. `monomem export --max-sensitivity <level>` does the same for one run, for both `--format md` and `--format json`. `monomem sync --git` applies the variable too, and warns when private notes will be pushed with it unset. A bad value stops the export |

Labels travel in Markdown front matter (`sensitivity:`) and in JSON exports, and are restored on
import.

## Limits

- The CLI, stdio mode, backups and the background sweeps are operator-level and have no ceiling.
  A backup copy contains every label. Restoring `<db>.pre-v17-backup` also drops every write made
  after the upgrade.
- Raw captured sessions, prompts and observations are unlabelled and may contain anything typed in
  a session. A ceiling below `private` sees no sessions at all.
- Counts-only operator statistics (index size, vector count, the change-feed head number) include
  hidden notes. They reveal a total, not a note. Note ids are shared, so a gap in the ids a token
  sees means a note it cannot see exists.
- `explain` (search score breakdowns) is switched off for a token with a ceiling, because the scores
  are computed over every note. Result order can still be shaped slightly by hidden text.
- `rebuild-edges` is refused for a token with a ceiling.
- Text sent to a configured endpoint leaves with that endpoint's rules, not Monomem's: embeddings
  (`MONOMEM_EMBED_URL`) and the session summary / distill calls (`MONOMEM_LLM_*`) send note or
  session text whatever its label. Private notes are not embedded unless
  `MONOMEM_ALLOW_PRIVATE_REMOTE=1`. The LLM calls work on raw sessions, which are not labelled.
- A token that can read a private note's text can still copy it into a new, lower-labelled note it
  is allowed to write. A ceiling stops reading, not copying. Give a token a low ceiling if you
  do not trust it with the text.
- Lowering a label (for example private to public) does not rewrite the note's old history versions
  or the titles already in the change feed.
- Replacing a note makes the new note at least as sensitive as the notes it replaces, and a note
  named as the replacement must already be. Deleting a replacement does not bring back replaced
  notes the deleting token cannot see.
- Export signatures (`--attest`) do not cover the label, so labels in an export or vault file are
  trusted as written. A label in a vault file only applies to a new note; it never changes an
  existing note's label. Do not import files from a source you do not trust.
- Importing under a ceiling can create a duplicate beside a hidden note with the same content.
  That is by design: matching it would reveal that it exists.
- An older build refuses a version-17 database rather than ignoring the labels.
