# What Monomem does, in detail

The main [README](../README.md) is the short version. This page is the long one: the checks you can run, automatic
memory, what sets Monomem apart, who wrote each note, and the security model in one place.

## Check and explain your memory

Notes keep their earlier versions (up to 20 per note by default), so replacing or editing a note can be undone; deleting one is permanent, by design. Local apps are marked `stdio:<app>` (`stdio:cursor`, `stdio:claude-code`, ...), a name the app's config file declares, not a login; give each app its own token when the writer must be authenticated. [Benchmarks](./BENCHMARK.md) back these claims.

| Command | What it shows | What it can't catch |
|---|---|---|
| `monomem check --attacks` | Replays known poisoning attacks on a copy of your store and says which reached an agent | Only attacks it already knows about |
| `monomem check` | One grade A-F with the reason: setup, settings, attack replay, audit chain, held writes | It grades what it checks, not everything in your notes |
| `monomem why 42` | The story of note #42: who wrote each version, what replaced it, which sessions were shown it | Who read the note (only a count and the last read time are kept), and versions older than the kept history (20 by default) |
| `monomem review conflicts` | Disagreements between writers: exact ones from attached facts, then a "possible" tier guessed from `key: value` lines in the text. It only flags and never changes a note | A reworded disagreement with no fact or `key: value` line is missed |
| `monomem facts` | The decisions agents recorded as facts, with who wrote them; disputed keys marked | Decisions nobody recorded as a fact |
| `monomem receipts` | Which notes recent session starts showed, and why (give a session id for one session's list) | Notes an agent found later by searching, and sessions older than the receipt window (30 days by default) |
| `monomem search --as-of <time>` | What your memory held at an earlier time, rebuilt from history | Notes deleted for good, and text older than the kept versions |

Agents that record decisions as `facts` (deploy_target, package_manager ...) get an exact match: a different value from another writer is flagged on write and, at session start, shown as a short "writers disagree" line. `check` (formerly `health`; `check --attacks` was `drill`) opens your store (an older database file is upgraded once) and writes one small row noting how long the audit log was, so the next run can see lines removed. These are local commands: `check --attacks` and `check` replay the attacks with embeddings forced off, so they make no embedding call (and no call to any other machine; the replay talks only to a temporary server on 127.0.0.1) even when `MONOMEM_EMBEDDINGS` and a remote `MONOMEM_EMBED_URL` are set (`check` only reports that such a URL is configured).

## Automatic memory

Monomem can also remember what your coding agent *does*, without anyone writing a note. Setup can wire this for Claude Code, Codex, Gemini CLI and Muse (whichever it finds on this computer). The Codex and Gemini CLI hooks follow those tools' published hook documentation (Codex asks you to approve them once with `/hooks`); Muse does not publish its hook fields, so capture there is the least certain:

```bash
monomem setup --capture        # or answer y to "Also record what <agent> does in this project ...?"
```

- **What is recorded:** prompts, tool calls, file edits, commands and their errors, through each tool's hooks
  (`monomem hook <event>`). Only on this machine, in the same SQLite file; raw events are deleted after 7 days
  (`MONOMEM_CAPTURE_RETENTION_DAYS`).
- **What is kept:** a free, deterministic distiller (no model call) turns each session into a few **observations**
  (a commit typed by its `fix:` / `feat:` / `refactor:` prefix, a test that failed and then passed, a decision you
  stated, a secret that was kept out) and one **session summary** (request, files, commands, outcome, next step).
  They are ordinary notes with a `kind`, so lint, holding, history, search and the trust policy apply to them,
  and they never show up in `memory_list` / `memory_search` unless asked for.
- **Private by default:** `<private>...</private>` blocks are dropped and secrets are replaced with
  `[REDACTED:<type>]` *before* anything is stored. `MONOMEM_CAPTURE=off` stops it; `MONOMEM_CAPTURE_EXCLUDE`
  skips folders; `MONOMEM_CAPTURE_SKIP_TOOLS` skips tools.
- **Never in the way:** every hook exits 0 and never migrates the database. If the database is busy or from another
  version, the (already redacted) event waits in a spool file and is stored by a later hook.
- **Back at the next session:** the start-of-session context is ranked by what you are working on (git branch, changed
  files, recent work), packed into `MONOMEM_RECALL_TOKENS` (1500), and ends with what it stands in for.
- **During a session:** new notes from other agents show up as one-line titles on your next message (at most 5, then
  "and N more"; distrusted writers and captured rows left out; nothing when there are none).
- **Looking things up:** `memory_sessions` with action `index` (compact rows) → action `timeline` (what happened around one) →
  `memory_read` (full text, cite as `om:#id`), plus action `list` for sessions (`memory_sessions` is not shown by default: `MONOMEM_TOOLS=memory_sessions`). REST: `GET /index`, `GET /timeline`, `POST /get`,
  `GET /sessions`, `GET /files/timeline?path=`. The [monomem-mem skill](../skills/monomem-mem/SKILL.md) teaches
  an agent this order.
- **Before a file is read (Claude Code only):** a `PreToolUse` hook on `Read` (`monomem hook file-context`, installed with
  `--capture`) tells the agent which memories are linked to that file, once per session per file. It is advisory
  only: it never blocks, allows or changes the Read. Same namespace, trust and UNTRUSTED-banner rules as the
  start-of-session context.
- **Before the context is compacted (Claude Code only):** a `PreCompact` hook (`monomem hook pre-compact`, installed
  with `--capture`) saves the session so far as its summary note before `/compact` or an automatic compaction, so the
  work is not only in the context being shortened. Same redaction, stamps and spool as the other capture hooks; a later
  stop or session end updates the same summary.
- **In the dashboard:** the **Sessions** tab lists recorded sessions; open one for its timeline (summary, prompts,
  observations, oldest first).
- **Optional local model:** set `MONOMEM_LLM_URL` (an OpenAI-compatible server such as Ollama,
  `http://127.0.0.1:11434`) and `MONOMEM_LLM_MODEL`, and at session end one call rewrites the session summary in
  plain words. Off by default; only a loopback URL is accepted (`MONOMEM_LLM_ALLOW_REMOTE=1` to override); bounded
  by `MONOMEM_LLM_TIMEOUT_MS`; the answer is redacted and linted like any write, and on any failure the automatic
  summary stays.
- **Moves with your data:** export / import and the Markdown vault sync carry an observation's kind, session, type
  and files; `monomem encrypt enable` seals the bodies of captured rows too (with the key present they get fixed titles and no word tags, and the capture spool is sealed; file paths and working folders stay plain text: see [what is protected](https://github.com/calasdan-sketch/monomem/blob/main/docs/encryption-retention.md#what-is-protected-and-what-is-not)). Captured rows are left out of the stale
  count, `memory_usage` totals and merging.
- **Old captured rows fade out:** an observation nobody updated or read for 30 days (`MONOMEM_DECAY_DAYS`; summaries
  180, `MONOMEM_DECAY_SUMMARY_DAYS`) is archived, never deleted, by the expiry sweep or at session end. Your own notes,
  decisions and anything tagged `pinned` never decay. `monomem tidy decay --dry-run` shows what would go; `monomem
  restore <id>` brings one back; `memory_usage` reports the counts.
- **Memory quality:** `monomem review duplicates [--json]` (formerly `monomem quality`; also the dashboard's **Quality** tab, admin key, `GET /quality`)
  lists near-duplicates, older duplicates of a newer note, held writes, notes the linter flags and rows about to
  decay, each with the command or button that fixes it. Every fix previews or asks first and can be undone.

**Semantic search when available:** `MONOMEM_EMBEDDINGS=auto` uses your local embedding endpoint when it answers
and quietly stays on keyword search when it does not (it retries once a minute).

`monomem check --setup` shows whether the hooks are wired, the last captured event and the spool size;
`monomem setup --undo` takes the hooks out again.

**At session start**, notes you pin are shown at the start of every session, first, within a fixed size limit
(`monomem pin <id>`, or **Pin (always shown)** in the dashboard with an admin key; `monomem pin` lists them). Then
you get a short "What I know about this project" block (decisions, conventions, key
files, the last session, open-task count), built from your stored notes with no model, capped at
`MONOMEM_PROFILE_TOKENS` (300) and switched off with `MONOMEM_PROFILE=off`. Every memory line then says why it is
there, in a few characters (`{files,kw 3d}`: linked to files you changed, matches your branch, three days old). A
memory that keeps showing up without helping: `monomem never-show <id>`, the dashboard's **never show** button, or
the tag `never-show`. It stays searchable; it is just never injected again.

### What it costs you

Monomem makes **no hidden model calls**. The only models it ever talks to are the optional local summarizer
(`MONOMEM_LLM_URL`, off by default, one call per session) and the optional embeddings endpoint (`MONOMEM_EMBEDDINGS`, off by default; it
receives note and search text, defaults to a local Ollama, and is a remote host if you set `MONOMEM_EMBED_URL` to one). The meter shows the rest, as aggregate numbers only (no
prompt or note text is recorded):

- tokens injected at session start, per session and in total, and the tokens of full note text they stood in for;
- tokens the local summarizer used (0 while it is off);
- capture events recorded and the database size on disk.

See it in `monomem check --usage`, `monomem check --setup` (the `footprint:` line), `GET /stats` and `memory_usage` (the `meter` field), and the
dashboard's **Usage** view. Tokens are estimates at about 4 characters a token.


## What makes it different

- **Small footprint.** One process (your Node, or the one inside the download), one SQLite file, **2 direct runtime
  dependencies** (`@modelcontextprotocol/sdk`, `zod`; ~94 packages installed
  in total, mostly the MCP SDK's own), no native modules, no vector database,
  no Python. Back it up by copying one file.
- **Change feed.** `memory_catch_up` with action `changes` / `GET /changes` / `monomem activity`: "what changed while I was
  away" — created, updated **and deleted** notes grouped by the writer that made them, with a
  per-device "since I last looked" marker. Driven by a local change log, so
  restores, file-sync imports and deletes are never missed. → [docs/change-feed.md](./change-feed.md)
- **Live wait.** `GET /changes?wait=25` / `memory_catch_up { action: "changes", wait_seconds: 25 }` parks
  until something changes in your scope, so a session sees an idea added from
  your phone within moments instead of on its next poll. **Use 25, not the 55
  maximum:** many proxies and tunnels cut an idle response at 30s (a 55s wait
  behind one died at 30.0s). Bounded (16 per app key), and a dropped client or a
  server shutdown frees its slot; `ack_mode: "manual"` makes delivery
  at-least-once. → [docs/change-feed.md](./change-feed.md#live-wait)
- **Task board, handoffs, catch-up.** `memory_tasks` (actions `put`, `get`, `list`,
  `claim`), `memory_sessions` with action `handoff`, and one `memory_catch_up` call (changes since you last looked +
  open tasks + latest handoff). Built on plain notes, so it is encrypted,
  namespaced and searchable like the rest; `monomem recall` includes open
  tasks and the latest handoff at session start. A task whose `due` date has passed is listed
  first there, marked `OVERDUE`, so "remind me next session" works. Nothing fires between
  sessions: it shows when the next session starts. → [docs/tasks.md](./tasks.md)
- **Memory linter.** Every write is scanned for secrets (API keys, JWTs,
  private keys, high-entropy tokens) and prompt-injection instructions
  ("ignore previous instructions", chat-template markers, tool-call
  coercion). Secrets are blocked; injection is held for admin review
  and invisible to search and recall until approved. It is a pattern
  linter, so expect misses. On 190,000 ordinary chat turns it held 21 (all
  containing real override wording) and refused 27 (mostly code examples with a
  sample password); method and caveats in [docs/BENCHMARK.md](./BENCHMARK.md#write-check-false-positives-how-often-ordinary-text-is-refused-or-held).
  → [docs/memory-linter.md](./memory-linter.md)
- **Plain-file sync.** `monomem export --format md --dir` writes one
  Markdown file per note with YAML front-matter, deterministic and
  git-friendly; `monomem import --dir` merges edits back three-way — newer
  wins, conflicts reported and the losing version kept, never silently lost.
  Works across machines through GitHub or Syncthing. → [docs/file-sync.md](./file-sync.md)
- **Scoped app keys.** `read` / `write` / `admin` app keys, enforced
  identically on REST and MCP — give your phone a read key and a leaked
  key can't wipe the store.
- **Sensitivity labels.** Mark a note `public`, `internal` (the default) or `private`, and give each app a ceiling
  (`monomem keys add --label cursor --scope write --max internal`, or `monomem connect cursor --restricted`). Above its
  ceiling a note is not found, searched, listed, counted, exported or injected, and looks the same as a note that does
  not exist. → [docs/sensitivity-labels.md](./sensitivity-labels.md), [docs/give-an-app-limited-access.md](./give-an-app-limited-access.md)
- **MCP *and* a plain REST API** on the same store, plus a small dashboard.

Also included: optional semantic / hybrid search with your own embeddings
endpoint (Ollama or any OpenAI-compatible API), natural-language time
filters ("yesterday evening"), staleness warnings, near-duplicate
consolidation, a similarity graph, access-based ranking, server-side
namespace isolation, and a Claude Code SessionStart recall hook.
→ [docs/search.md](./search.md)

## Who wrote this?

Every note carries a **server-stamped** `written_by` (who last changed its title or body; a tag edit or a task status change does not count) and `created_by`
(the first). It is the label of the authenticated token that made the call, or a fixed
marker for writers with no token: `stdio` (local MCP), `cli` (an `monomem` command),
`server` (its own jobs), `runner` (the command runner). A client cannot set it: `written_by` in a request body is
ignored, and an import stamps the *importing* admin.

**Which local app?** `monomem setup` puts `MONOMEM_CLIENT=<app>` in each app's MCP entry
(`claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, `muse`, `vscode`, `zed`; a folder's
`.mcp.json` gets `claude-code`), and the stdio server then stamps `stdio:<app>` instead of `stdio`.
Re-running setup adds the name to an entry written by an older version; an install that never
re-runs setup keeps stamping plain `stdio`. Be clear about what this is: the name is
**self-declared** by that config file. Anything that can edit the file, or start `monomem mcp` with
its own environment, can claim any name, so `stdio:cursor` tells your apps apart; it does not prove
Cursor wrote the note. It grants nothing: every stdio connection has the same access as before. For
an authenticated writer, use a scoped token over HTTP (`MONOMEM_TOKENS`). In filters and distrust
rules, `stdio:cursor` names that one app and plain `stdio` still names every local stdio app,
labelled or not, so a rule written for `stdio` keeps covering all of them. A token label cannot
start with `stdio:` (it is stored as `token:stdio:...`). The old `source` field is still
there, but it is only what the writer *claims*, so anyone can put anything in it.

A note written by Claude Code and one written by Cursor are therefore no longer
identical on read-back. MCP results add a "who wrote this" block under the untrusted-data
banner, the session-start recall names the writer, and `memory_list`, `memory_search` and
`memory_catch_up` (action `changes`) take `written_by` / `not_written_by` (REST: `?written_by=`) so an agent can
ignore its own writes or distrust a client.
Details and limits: [docs/provenance.md](./provenance.md).

**Trust.** `writer_id` (`<server_id>/<label>`) says which server a label came from. An admin can put a
writer on a per-namespace **distrust list** (`monomem trust distrust <writer> --namespace work`, the
`memory_trust` MCP tool, `/trust` REST): its notes, tasks, handoffs and feed entries are then left out of every
read path unless an **admin** passes `include_distrusted`, they stay hidden after anyone else edits them, and a
distrusted command task is never run. `monomem ls` and `monomem search` say how many notes they left out this way,
and `--include-distrusted` shows them, marked. A local app's notes are written by `stdio:<app>` (`stdio:cursor`, not
`cursor`); `monomem show <id>` prints a note's writer, and `trust distrust cursor` refuses and suggests the right name. A JSON export made with `--attest` (`?attest=1`) carries a per-note Ed25519
**attestation**; an import that trusts the exporting server's key keeps the original author as `attested_writer`,
otherwise it marks the note `imported_unverified`. (Attestations are **experimental**.) What that proves and what it
does not: [docs/trust.md](./trust.md).

**Outside content (1.4.0).** A note written after an agent read a web page or another MCP server's output, **when
Monomem can see it** (Claude Code's hooks, a connection that read an unconfirmed note, or `outside: true`), lands
**unconfirmed**: labelled, kept out of session start, and never pinned until a person runs `monomem confirm <id>`. Another
agent's confirm, with its own key and a different stated source, is corroboration, not verification. Not seen: `Read`,
`Bash`, and apps without the hooks. Notes can also say what they were built from (`derived_from`), and notes nobody
re-confirmed in 30 days are labelled `[expired - ...]` (labels only by default; `monomem settings`). `monomem review` lists
what waits for you. Details and limits: [docs/trust.md](./trust.md#outside-content-limits-first-140),
[docs/search.md](./search.md#re-confirmation-expiry).

## Honest numbers

- **Finding a note again (keyword search only, top 5 results, from a QA pass).** Questions that use the note's own words: the right note was
  in the top 5 about **95%** of the time. Reworded questions that share few words with the note: about **50%**. Semantic search
  (`MONOMEM_EMBEDDINGS=on`, needs a local Ollama) helps with the reworded ones; without it Monomem does not understand meaning. These come
  from a QA pass, not from the benchmark above: treat them as a rough guide and test on your own notes.
- **What it adds at the start of a session.** A store of 60 short notes at the default setting (`MONOMEM_RECALL_TOKENS` = 1,500) produced
  about 5,900 characters, roughly **1,500 tokens** (estimated at 4 characters a token), listing all 60 notes (measured 2026-11-09 with
  `node bench/recall-size.mjs`, which you can run yourself). The block is capped at 8,000 characters. `monomem check --usage` shows what yours actually costs and saves, as estimates.

## Security in one paragraph

Loopback by default and fail-closed: it refuses to bind a public interface
without an explicit `MONOMEM_TOKEN`. Constant-time app-key checks on every
data route, scoped app keys, DNS-rebinding Origin checks, per-client rate
limits, size caps, an append-only audit log without note content (hash-chained and, since 1.5.0, Ed25519-signed with
the store's key; every note write, including a held or refused one, answers with a signed receipt you can check
offline with only the public key, using `monomem verify-receipt --pubkey` or the standalone
[docs/verify-receipt.mjs](https://github.com/calasdan-sketch/monomem/blob/main/docs/verify-receipt.mjs); a program
running as you can still read the key and rewrite everything after the last receipt or checkpoint someone else holds,
so keep a `monomem audit checkpoint` off the machine), a read access log (who read
what, with a redacted query preview and never note text) and a per-writer flood guard, the
write-time linter above, and an untrusted-data banner on every MCP read (REST responses do not
carry it) so agents treat note content as data, not instructions. Optional AES-256-GCM
encryption at rest for note bodies only (`monomem encrypt enable`; titles,
tags, timestamps and embeddings stay readable; body search then runs from an index held only in memory, which the system can page to swap, so pair it with whole-disk encryption), per-note
TTL with reversible soft-archive, and `?explain=1` so a caller can see why
a memory was retrieved. **Per-token namespace permissions** pin a token to
one namespace so a single shared bridge stays isolated per agent — a pinned
admin key is still confined. Your notes stay in one
file on your machine; a tunnel only carries requests. Details and known
limits: [SECURITY.md](../SECURITY.md),
[docs/token-namespaces.md](./token-namespaces.md), and
[docs/encryption-retention.md](./encryption-retention.md).

**About the retrieval eval.** `evals/cross-device-tasks.json` is 10 tasks over
10 notes and lexically easy; its perfect score is a regression gate in CI,
not evidence of retrieval quality. Keyword-only `memory_search` scores 1.00
recall@1 on it. See [docs/encryption-retention.md](./encryption-retention.md#the-evaluation-set).

## Leaves no trace

Monomem writes to its data folder (`~/.monomem`) and, through `monomem setup`, to the one `monomem` entry in each
app's config, with a backup beside it. Nothing lands in your projects unless you name the folder (`--project`, `--dir`,
`--out`, `sync --git`), a `CLAUDE.md` or `AGENTS.md` is never written unless you run `monomem project-rules` (and then only inside its fenced
block), and every retry has a limit. `monomem uninstall` takes it out
of every app (byte for byte where it can), `--purge` also deletes the data after a final backup. Every file, and how to
remove it: [docs/footprint.md](./footprint.md).
