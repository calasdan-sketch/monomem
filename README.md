<!-- Image URLs are absolute on purpose: GitHub resolves relative paths, npm does not. -->
![Monomem: Shared memory for AI agents that holds writes that match known attack patterns.](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/brand/monomem-banner.png)

**Shared memory for your AI coding agents that records who wrote each note and holds suspicious writes for your review.**

```bash
npx monomem setup
```

Want to see it first? `npx monomem demo` runs a short tour on a throwaway store (deleted at the end); it never touches your notes.

Needs Node 22.16 or newer (check with `node -v`). No new enough Node? One command instead (needs Docker; put a long random `MONOMEM_TOKEN` in `.env` first):

```bash
git clone https://github.com/calasdan-sketch/monomem && cd monomem && cp .env.example .env && docker compose up -d
```

(More: [Docker](#docker).)

[![Monomem MCP server](https://mcprush.com/badge/monomem-mcp/card.svg)](https://mcprush.com/to/monomem-mcp?ref=badge)

*An independent scan's grade, updated by mcprush after each scan: it reads the published package, not our claims.*

**What it does not do:** it holds writes that match known attack patterns and records who wrote each note. It only covers what goes through Monomem: anything that can run shell commands or open `~/.monomem/state.db` itself can read or change your notes directly, and a reworded attack the pattern check does not know can still get through. Sensitivity limits apply to apps that connect with their own key. See [Known limits](#known-limits).

![A write that matches a known attack pattern is held, a second agent's search never sees it, and the dashboard rejects it](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/monomem-demo.gif)

*Recorded from a real run against a throwaway store ([transcript](https://github.com/calasdan-sketch/monomem/blob/main/docs/brand/demo-transcript.txt)): a write containing an injected instruction is held and never reaches the other agent's search, then rejected from the real dashboard. The two terminal panes are drawn from the real REST responses; the dashboard is a screen recording. Nothing sped up.*

- **One memory for all your assistants.** Tell Claude Code something once, and Cursor, Codex and Gemini CLI can read it too. It's one SQLite file on your own machine: no cloud, no API keys, no hidden model calls. Already use another memory tool? See [how it compares](#how-it-compares).
- **Knows who wrote it.** Every note records its writer. For callers that use a token, the server stamps the name; for local apps it is a label from that app's config file, so it tells your apps apart but is not proof.
- **Holds suspicious writes.** A write that looks like an instruction planted to steer your other assistants is held until you approve it, and `monomem approve-first --all on` makes every agent write wait for your OK. The check is pattern matching, so it doesn't catch everything. An agent that can run shell commands, like Claude Code, can run the `monomem` command itself and its writes are not held, so this protects you from tools that only have the memory connection (see [SECURITY.md](./SECURITY.md)).

**How it works:**

![How Monomem works: your agents save through MCP or REST; a write check refuses secrets and holds writes that match known attacks until you approve them; one SQLite file keeps each note's writer, history and privacy label; reads hide private notes from limited apps and leave out distrusted writers.](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/monomem-architecture.png)

*Diagram source: [docs/monomem-architecture.mmd](https://github.com/calasdan-sketch/monomem/blob/main/docs/monomem-architecture.mmd) (Mermaid). More detail: [docs/architecture.md](./docs/architecture.md).*

[![CI](https://github.com/calasdan-sketch/monomem/actions/workflows/ci.yml/badge.svg)](https://github.com/calasdan-sketch/monomem/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/monomem)](https://www.npmjs.com/package/monomem)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22.16-green)

---

## Quickstart

> **Requires Node.js 22.16 or newer** (22.16+ or 24 LTS). Check with `node -v`. Can't
> upgrade? Use [Docker](#docker) instead.

### Install in 60 seconds

```bash
npx monomem setup
npx monomem drill   # replays 23 known poisoning attacks on a copy of your store
```

`setup` finds Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, Muse, VS Code and Zed on this computer, shows you in plain words what it will do and the exact
lines it will change, saves a backup of each file, and writes only after you type `y`. Then it writes a first test note, reads it
back, runs `monomem doctor` and tells you how to check it inside Claude Code (type `/mcp`). To look first: `npx monomem setup
--dry-run`. To go back: `monomem setup --undo`. It changes only the Monomem entry; your other servers and settings stay as they
are. Step by step, with troubleshooting: [docs/live-claude-code.md](./docs/live-claude-code.md).

Already have notes in Claude Code? `monomem import --claude --dry-run` shows what could be brought in from your `CLAUDE.md` files and
Claude Code's auto memory (secrets are skipped, nothing leaves your computer). Coming from claude-mem, mem0, basic-memory or the official MCP memory server?
`monomem import --from claude-mem --dry-run` (or `mem0 --path export.json`, `basic-memory`, `mcp-memory`); see [docs/switching.md](./docs/switching.md)
for the import and a clean uninstall of the old tool.

In Claude Code you can also install Monomem as a plugin instead of running `setup` ([what the plugin does and does not do](./docs/plugin.md)):

```
/plugin marketplace add calasdan-sketch/monomem
/plugin install monomem@monomem
```

Anything else that speaks MCP or HTTP can connect too, including a browser on your phone if you expose the HTTP endpoint yourself ([INFRA.md](./INFRA.md) covers tunnels and phone or web access).

The manual way, if you prefer:

```bash
npm i -g monomem                           # 1. install
claude mcp add monomem -- monomem mcp        # 2. wire it into Claude Code (stdio)
monomem doctor                                 # 3. verify Node, database, token
```

Then, in Claude, say **"remember that my staging server is on port 8443"**,
and in a fresh chat ask "what port is my staging server on?". Step 4, only
if you want the dashboard, REST API and MCP-over-HTTP (the `curl` examples
below need it): `monomem start`.

No global install: `claude mcp add monomem -- npx -y monomem mcp`.
`monomem init --print` prints the config for Claude Desktop / Cursor, and a separate
`.vscode/mcp.json` block (`"servers"`) for VS Code / Copilot;
[INSTALL.md](./INSTALL.md) has every client.

`monomem start` serves the dashboard and REST API on `:8790` and
MCP-over-HTTP on `:8791` (bound to `127.0.0.1`). Clients that can send a
bearer token (Claude Code, scripts, your own apps) can reach it remotely
through a private network or tunnel you control — see [INFRA.md](./INFRA.md).
**claude.ai and the Claude mobile app do not work with it yet:** their custom
connectors sign in with OAuth, Monomem only accepts a bearer token, and a
login page such as Cloudflare Access blocks the connector. On a phone, use
Claude Code's remote control, which runs on your computer.

Plain REST works too once `monomem start` is running (the token is in
`~/.monomem/.token`):

```bash
TOKEN=$(cat ~/.monomem/.token)
curl -X POST localhost:8790/notes -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"Deploy day","body":"Shipped v1.1"}'
curl -H "Authorization: Bearer $TOKEN" "localhost:8790/search?q=deploy"
```

### Where your data lives

Everything (database, token, scoped tokens, spaces config) lives in
`~/.monomem` (Windows: `%USERPROFILE%\.monomem`), outside the installed
package, so `npm update` and npx cache cleanups never touch it. Set
`MONOMEM_HOME` to put it elsewhere, or `MONOMEM_DB_PATH` for just the
database. On macOS/Linux the folder is owner-only (`0700`, files `0600`).
A from-source git checkout that already has `./data/state.db` keeps using
it. `monomem doctor` shows which directory is in use. Upgrading or moving from another tool:
[docs/upgrading.md](./docs/upgrading.md), [docs/switching.md](./docs/switching.md).

### Docker

```bash
cp .env.example .env     # set MONOMEM_TOKEN (openssl rand -hex 32)
docker compose up -d     # dashboard at http://localhost:8790
```

### Backups & restore

```bash
monomem backup --out ~/om-backup     # consistent hot copy; safe while the server runs
```

(The attestation signing key `.attest-key` is not copied; see [docs/trust.md](./docs/trust.md#setting-it-up-between-two-servers).)


`monomem backup` writes `state.db` (via SQLite `VACUUM INTO`) plus, if
at-rest encryption is on, a copy of the `.key` file. **Keep the key apart from
the backup**: a backup without its key is unreadable, and one stored next to it
is not encrypted. See [INFRA.md](./INFRA.md#7-backups). The JSON route (admin
token) also works:

```bash
TOKEN=$(cat ~/.monomem/.token)
curl -H "Authorization: Bearer $TOKEN" localhost:8790/export > backup.json   # or: monomem export --format json --out backup.json
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @backup.json localhost:8790/import                           # admin scope only
```

- **Restore into an empty store.** `POST /import` does not de-duplicate:
  importing a backup into a store that already holds those notes creates
  duplicates.
- **Exports carry edit history.** Each note exports with its latest body *plus*
  the earlier versions an edit replaced (`history`), so export size tracks how
  often you rewrote a note, not just your note count. `?history=0` /
  `--no-history` leaves them out. **An export with history can hold text
  someone removed on purpose — treat it like the database** (see
  [SECURITY.md](./SECURITY.md)). The change feed's per-edit log is separate:
  metadata only (titles, no bodies), pruned after 90 days, and never part of
  a JSON backup.
- **Exports stream.** `GET /export` and `monomem export --format json` page
  through the store and write as they go, so peak memory is one page (500
  notes) regardless of store size — a multi-month store dumps in one pass.
- **Restores keep the history that exists.** `created_at`, `updated_at`,
  `source` and the `rev` counter all survive the round trip (a note at rev 26
  stays at rev 26, so `if_rev` guards and the change feed stay accurate).
  Imports over 200 notes land in seconds and defer the O(n²) similarity-graph
  rebuild — the response says so and search works immediately; run
  `monomem rebuild-edges` when you want neighbor ranking back. Restored
  notes are re-embedded automatically when semantic search is enabled.
- Markdown (one file per note, git-friendly) is a separate path:
  `monomem export --format md --dir ~/memory` — see
  [docs/file-sync.md](./docs/file-sync.md).

---

## Check and explain your memory

Notes keep their earlier versions (up to 20 per note by default), so replacing or editing a note can be undone; deleting one is permanent, by design. Local apps are marked `stdio:<app>` (`stdio:cursor`, `stdio:claude-code`, ...), a name the app's config file declares, not a login; give each app its own token when the writer must be authenticated. [Benchmarks](#benchmark) back these claims.

| Command | What it shows | What it can't catch |
|---|---|---|
| `monomem drill` | Replays known poisoning attacks on a copy of your store and says which reached an agent | Only attacks it already knows about |
| `monomem health` | One grade A-F with the reason: setup, settings, drill, audit chain, held writes | It grades what it checks, not everything in your notes |
| `monomem why 42` | The story of note #42: who wrote each version, what replaced it, which sessions were shown it | Who read the note (only a count and the last read time are kept), and versions older than the kept history (20 by default) |
| `monomem conflicts` | Disagreements between writers: exact ones from attached facts, then a "possible" tier guessed from `key: value` lines in the text. It only flags and never changes a note | A reworded disagreement with no fact or `key: value` line is missed |
| `monomem facts` | The decisions agents recorded as facts, with who wrote them; disputed keys marked | Decisions nobody recorded as a fact |
| `monomem receipts` | Which notes recent session starts showed, and why (give a session id for one session's list) | Notes an agent found later by searching, and sessions older than the receipt window (30 days by default) |
| `monomem search --as-of <time>` | What your memory held at an earlier time, rebuilt from history | Notes deleted for good, and text older than the kept versions |

Agents that record decisions as `facts` (deploy_target, package_manager ...) get an exact match: a different value from another writer is flagged on write and, at session start, shown as a short "writers disagree" line. `health` opens your store (an older database file is upgraded once) and writes one small row noting how long the audit log was, so the next run can see lines removed. These are local commands: `drill` and `health` run the drill with embeddings forced off, so they make no embedding call (and no call to any other machine; the drill talks only to a temporary server on 127.0.0.1) even when `MONOMEM_EMBEDDINGS` and a remote `MONOMEM_EMBED_URL` are set (`health` only reports that such a URL is configured).

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
  They are ordinary notes with a `kind`, so lint, quarantine, history, search and the trust policy apply to them,
  and they never show up in `state_list` / `state_search` unless asked for.
- **Private by default:** `<private>...</private>` blocks are dropped and secrets are replaced with
  `[REDACTED:<type>]` *before* anything is stored. `MONOMEM_CAPTURE=off` stops it; `MONOMEM_CAPTURE_EXCLUDE`
  skips folders; `MONOMEM_CAPTURE_SKIP_TOOLS` skips tools.
- **Never in the way:** every hook exits 0 and never migrates the database. If the database is busy or from another
  version, the (already redacted) event waits in a spool file and is stored by a later hook.
- **Back at the next session:** the start-of-session context is ranked by what you are working on (git branch, changed
  files, recent work), packed into `MONOMEM_RECALL_TOKENS` (1500), and ends with what it stands in for.
- **During a session:** new notes from other agents show up as one-line titles on your next message (at most 5, then
  "and N more"; distrusted writers and captured rows left out; nothing when there are none).
- **Looking things up:** `memory_index` (compact rows) → `memory_timeline` (what happened around one) →
  `memory_get` (full text, cite as `om:#id`), plus `session_list`. REST: `GET /index`, `GET /timeline`, `POST /get`,
  `GET /sessions`, `GET /files/timeline?path=`. The [monomem-mem skill](./skills/monomem-mem/SKILL.md) teaches
  an agent this order.
- **Before a file is read (Claude Code only):** a `PreToolUse` hook on `Read` (`monomem hook file-context`, installed with
  `--capture`) tells the agent which memories are linked to that file, once per session per file. It is advisory
  only: it never blocks, allows or changes the Read. Same namespace, trust and UNTRUSTED-banner rules as the
  start-of-session context.
- **In the dashboard:** the **Sessions** tab lists recorded sessions; open one for its timeline (summary, prompts,
  observations, oldest first).
- **Optional local model:** set `MONOMEM_LLM_URL` (an OpenAI-compatible server such as Ollama,
  `http://127.0.0.1:11434`) and `MONOMEM_LLM_MODEL`, and at session end one call rewrites the session summary in
  plain words. Off by default; only a loopback URL is accepted (`MONOMEM_LLM_ALLOW_REMOTE=1` to override); bounded
  by `MONOMEM_LLM_TIMEOUT_MS`; the answer is redacted and linted like any write, and on any failure the automatic
  summary stays.
- **Moves with your data:** export / import and the Markdown vault sync carry an observation's kind, session, type
  and files; `monomem encrypt enable` seals captured event outputs too. Captured rows are left out of the stale
  count, `memory_stats` totals and consolidation.
- **Old captured rows fade out:** an observation nobody updated or read for 30 days (`MONOMEM_DECAY_DAYS`; summaries
  180, `MONOMEM_DECAY_SUMMARY_DAYS`) is archived, never deleted, by the expiry sweep or at session end. Your own notes,
  decisions and anything tagged `pinned` never decay. `monomem decay --dry-run` shows what would go; `monomem
  restore <id>` brings one back; `memory_stats` reports the counts.
- **Memory quality:** `monomem quality [--json]` (and the dashboard's **Quality** tab, admin token, `GET /quality`)
  lists near-duplicates, stale notes with a newer twin, quarantined writes, notes the linter flags and rows about to
  decay, each with the command or button that fixes it. Every fix previews or asks first and can be undone.

**Semantic search when available:** `MONOMEM_EMBEDDINGS=auto` uses your local embedding endpoint when it answers
and quietly stays on keyword search when it does not (it retries once a minute).

`monomem doctor` shows whether the hooks are wired, the last captured event and the spool size;
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

See it in `monomem doctor` (the `footprint:` line), `GET /stats` and `memory_stats` (the `meter` field), and the
dashboard's **Usage** view. Tokens are estimates at about 4 characters a token.

---

## What makes it different

- **Small footprint.** One Node process, one SQLite file, **2 direct runtime
  dependencies** (`@modelcontextprotocol/sdk`, `zod`; ~94 packages installed
  in total, mostly the MCP SDK's own), no native modules, no vector database,
  no Python. Back it up by copying one file.
- **Change feed.** `memory_since` / `GET /changes`: "what changed while I was
  away" — created, updated **and deleted** notes grouped by source, with a
  per-device "since I last looked" marker. Driven by a local change log, so
  restores, file-sync imports and deletes are never missed. → [docs/change-feed.md](./docs/change-feed.md)
- **Live wait.** `GET /changes?wait=25` / `memory_since { wait_seconds: 25 }` parks
  until something changes in your scope, so a session sees an idea added from
  your phone within moments instead of on its next poll. **Use 25, not the 55
  maximum:** many proxies and tunnels cut an idle response at 30s (a 55s wait
  behind one died at 30.0s). Bounded (16 per token), and a dropped client or a
  server shutdown frees its slot; `ack_mode: "manual"` makes delivery
  at-least-once. → [docs/change-feed.md](./docs/change-feed.md#live-wait)
- **Task board, handoffs, catch-up.** `task_put` / `task_get` / `task_list` /
  `task_claim`, `session_handoff`, and one `catch_up` call (changes since you last looked +
  open tasks + latest handoff). Built on plain notes, so it is encrypted,
  namespaced and searchable like the rest; `monomem recall` includes open
  tasks and the latest handoff at session start. A task whose `due` date has passed is listed
  first there, marked `OVERDUE`, so "remind me next session" works. Nothing fires between
  sessions: it shows when the next session starts. → [docs/tasks.md](./docs/tasks.md)
- **Memory linter.** Every write is scanned for secrets (API keys, JWTs,
  private keys, high-entropy tokens) and prompt-injection instructions
  ("ignore previous instructions", chat-template markers, tool-call
  coercion). Secrets are blocked; injection is quarantined for admin review
  and invisible to search and recall until approved. It is a pattern
  linter, so expect misses. On 190,000 ordinary chat turns it held 21 (all
  containing real override wording) and refused 27 (mostly code examples with a
  sample password); method and caveats in [docs/BENCHMARK.md](./docs/BENCHMARK.md#write-check-false-positives-how-often-ordinary-text-is-refused-or-held).
  → [docs/memory-linter.md](./docs/memory-linter.md)
- **Plain-file sync.** `monomem export --format md --dir` writes one
  Markdown file per note with YAML front-matter, deterministic and
  git-friendly; `monomem import --dir` merges edits back three-way — newer
  wins, conflicts reported and the losing version kept, never silently lost.
  Works across machines through GitHub or Syncthing. → [docs/file-sync.md](./docs/file-sync.md)
- **Scoped tokens.** `read` / `write` / `admin` bearer tokens, enforced
  identically on REST and MCP — give your phone a read token and a leaked
  token can't wipe the store.
- **Sensitivity labels.** Mark a note `public`, `internal` (the default) or `private`, and give each app a ceiling
  (`monomem token add --label cursor --scope write --max internal`, or `monomem connect cursor --restricted`). Above its
  ceiling a note is not found, searched, listed, counted, exported or injected, and looks the same as a note that does
  not exist. → [docs/sensitivity-labels.md](./docs/sensitivity-labels.md), [docs/give-an-app-limited-access.md](./docs/give-an-app-limited-access.md)
- **MCP *and* a plain REST API** on the same store, plus a small dashboard.

Also included: optional semantic / hybrid search with your own embeddings
endpoint (Ollama or any OpenAI-compatible API), natural-language time
filters ("yesterday evening"), staleness warnings, near-duplicate
consolidation, a similarity graph, access-based ranking, server-side
namespace isolation, and a Claude Code SessionStart recall hook.
→ [docs/search.md](./docs/search.md)

---

## How it works

![How Monomem works: your agents save through MCP or REST; a write check refuses secrets and holds writes that match known attacks until you approve them; one SQLite file keeps each note's writer, history and privacy label; reads hide private notes from limited apps and leave out distrusted writers.](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/monomem-architecture.png)

Write once in one assistant, read it back in another — every agent shares
the same store.

## How it compares

The closest well-known alternative is the official
[MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
(`@modelcontextprotocol/server-memory`), a small knowledge graph kept in one file.
It is a good fit if you want that and nothing more. This table only lists things you can check:
the left column against [its README](https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md)
(read on 5 November 2026; check it again, it changes), the right against this repository.

| | Official MCP memory server | Monomem |
|---|---|---|
| Who wrote each note | Its README documents no author on a stored observation | Every note has a `written_by`: stamped by the server for token callers, a label from the app's config file for local apps ([Who wrote this?](#who-wrote-this)) |
| History and undo | Its README documents delete tools and no undo or version history | Earlier versions kept (20 per note by default) and restorable; a permanent delete is deliberate and cannot be undone |
| Holding suspicious writes (quarantine) | Its README documents none | Suspicious writes wait for your approval, and a namespace can be approve-first ([docs/memory-linter.md](./docs/memory-linter.md)) |
| REST API | Its README documents MCP tools and one MCP resource, no REST | REST API and dashboard next to MCP over stdio and HTTP |
| Several apps on one memory | Yes: its README describes several clients sharing one file, with a lock so writes take turns | Yes, and each app or token gets its own writer name; `setup` wires eight clients |
| Import | Not documented | `monomem import --from mcp-memory` reads its file ([docs/switching.md](./docs/switching.md)) |

Its data model is also different: entities, relations and observations, where Monomem keeps titled notes with tags.
Neither is better in general; pick the one whose model fits how you work.

What Monomem itself provides (all of it checkable in this repo): MIT
license, Node 22.16+ with 2 direct runtime dependencies, one SQLite file,
MCP over stdio and HTTP plus a REST API, optional semantic search with your
own embeddings endpoint, a change feed that includes deletes, a write-time
secret and injection linter, Markdown export and three-way import, scoped
tokens with optional per-token namespaces, and optional AES-256-GCM
encryption of note bodies. See [SECURITY.md](./SECURITY.md) for what it does
**not** do.

---

## MCP tools

**Nine of these are registered by default:** `state_write`, `state_read`, `state_search`,
`state_list`, `state_delete`, `catch_up`, `memory_supersede_preview`, `memory_supersede_confirm`,
`memory_supersede_undo`. Every tool's
schema is sent to the model on every turn, so the rest are operator tooling you opt into with
`MONOMEM_TOOLS=all`, or by naming them: `MONOMEM_TOOLS=memory_index,memory_timeline`. See
[docs/configuration.md](./docs/configuration.md). The command runner (`task_*`, `runner_status`) is **not
shipped in the npm package** — build it from the repo.

| Tool | Scope | |
|---|---|---|
| `state_write` / `state_read` / `state_delete` | write / read / admin | Write with compare-and-swap (`if_rev`) and provenance (`source`); read; forget. `state_delete` archives (restorable); a permanent delete is for a person, in the dashboard or with `monomem delete <id>` |
| `state_search` / `state_relevant` / `state_list` | read | keyword, semantic or hybrid search, or vague-message recall with `mode: "relevant"`; listing. `state_relevant` does the same recall as its own tool and is no longer registered by default |
| `memory_since` | read | change feed (`wait_seconds` = live wait) |
| `task_put` / `task_list` / `task_get` | write / read / read | shared task board across devices and models; `client_key` makes a create retry-safe |
| `task_claim` | write | take / heartbeat / release a task with a lease (compare-and-swap) |
| `task_approve` | admin | approve a command task so the PC's runner may run it ([RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)) |
| `runner_status` | read | is the PC's runner listening, and how many approved commands are waiting for it (`monomem runner-status`, `GET /runner/status`; [RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)) |
| `session_handoff` / `catch_up` | write / read | leave a handoff; one-call catch-up at session start |
| `memory_ack` | read | confirm a manual-ack change-feed page |
| `memory_stats` | read | totals, most-read, never-read, stale |
| `memory_quarantine` | admin | review linter-held writes |
| `trust_policy` | admin | list / change the per-namespace distrust list and the trusted attester keys ([docs/trust.md](./docs/trust.md)) |
| `memory_supersede_preview` / `memory_supersede_confirm` / `memory_supersede_undo` | write | replace a note in two steps (preview changes nothing; confirm needs its one-time code); undo ([docs/replacing-memories.md](./docs/replacing-memories.md)) |
| `memory_history` / `memory_restore_version` / `memory_history_purge` | admin | earlier versions of a note; put one back as a new version; forget them |
| `memory_rollback` | admin | undo what one writer did since a time: preview, then confirm with the one-time code (operator-only: off over stdio unless `MONOMEM_STDIO_ADMIN_TOOLS=1`) |
| `memory_consolidation_candidates` / `memory_consolidate` / `memory_rebuild_edges` | admin | dedup and similarity-graph maintenance |

REST mirrors them (`/notes`, `/search`, `/relevant`, `/changes`, `/tasks`, `/handoffs`, `/catch-up`, `/stats`,
`/export`, `/import`, …). Full reference: [docs/architecture.md](./docs/architecture.md).

## CLI

```
monomem start | mcp | doctor | init
monomem setup [--dry-run] [--yes] [--only claude-code,claude-desktop,cursor,codex,gemini,muse,vscode,zed] [--hook] [--undo]   # connect your apps; safe, backed up, undoable
monomem import --claude [--dry-run] [--update] [--project <folder>]   # bring in CLAUDE.md files and Claude Code auto memory
monomem import --from claude-mem|mem0|basic-memory|mcp-memory [--path p] [--dry-run]   # switch from another memory tool (docs/switching.md)
monomem sync --git ~/my-private-memory-repo [--encrypt]   # keep your computers in step through YOUR private git repository
monomem changes --since last --consumer laptop
monomem runner-status                           # is each PC's runner listening? commands waiting?
monomem trust [list | distrust <w> | undistrust <w> | identity | attester-add <key> --server-id <id> | attester-remove <id> | attester-revoke <id>]
monomem trust [export-key --out <file> | rotate]         # EXPERIMENTAL: signed attestations (docs/trust.md)
monomem watch --consumer pc [--exec program args...]     # react to changes as they land
monomem backup [--out dir] [--include-approval-key] [--include-attest-key]   # hot copy of the database (+ keys)
monomem export --format md --dir ~/memory     monomem import --dir ~/memory
monomem export --format json [--attest] --out a.json     monomem import --file a.json [--require-attestation]
monomem supersede --old 12 --title "..." --body "..."   # replace a note: shows what you would lose, asks you to type the count
monomem supersede undo <id>     monomem history <id> | restore <id> <version> | purge <id>
monomem quarantine [list | approve <id> | reject <id>]
monomem approve-first [<namespace> on|off | --all on|off]   # hold every agent write (one namespace, or all) for your approval
monomem pin [<id>]     monomem unpin <id>     # agents can read a pinned note; only this CLI can change it
monomem rollback --writer stdio:cursor --since 2h [--include-conflicts]   # undo one writer's changes (preview, then confirm)
monomem access [--since 24h] [--writer label]   # who read memory, with which tool (never note text)
monomem flood     monomem resume <label>         # writers paused for too many writes in an hour
monomem quality [--json]     monomem decay [--dry-run]     monomem archive <id> | restore <id>
monomem label <id> [public|internal|private]    # show or set a note's sensitivity label
monomem connect <app> [--restricted]     monomem open     # one app with its own key and limit; open the dashboard signed in
monomem pii scan     monomem digest [--since 24h]     monomem scrub     monomem safety-report --out report.html     # checkups (docs/checkups.md)
monomem consolidate | rebuild-edges | reindex | relevant "…" | recall
monomem bench [--json] [--suite stale|contradiction|isolation|provenance] [--strict-gaps]   # provenance benchmark (docs/BENCHMARK.md)
```

`monomem help` explains each. Upgrading an existing OneMemory 1.3.x install (the earlier name of this project, not monomem 1.2.0): [docs/upgrading.md](./docs/upgrading.md). The CLI runs with full local trust (no
token).

---

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
banner, the session-start recall names the writer, and `state_list`, `state_search` and
`memory_since` take `written_by` / `not_written_by` (REST: `?written_by=`) so an agent can
ignore its own writes or distrust a client.
Details and limits: [docs/provenance.md](./docs/provenance.md).

**Trust.** `writer_id` (`<server_id>/<label>`) says which server a label came from. An admin can put a
writer on a per-namespace **distrust list** (`monomem trust distrust <writer> --namespace work`, the
`trust_policy` MCP tool, `/trust` REST): its notes, tasks, handoffs and feed entries are then left out of every
read path unless an **admin** passes `include_distrusted`, they stay hidden after anyone else edits them, and a
distrusted command task is never run. A JSON export made with `--attest` (`?attest=1`) carries a per-note Ed25519
**attestation**; an import that trusts the exporting server's key keeps the original author as `attested_writer`,
otherwise it marks the note `imported_unverified`. (Attestations are **experimental**.) What that proves and what it
does not: [docs/trust.md](./docs/trust.md).

## Benchmark

`monomem bench` checks the provenance behaviour a shared agent memory needs: that one agent cannot silently turn a weak
guess into shared truth. It is deterministic, offline, uses no model, and runs on a throwaway store through the real REST API
(`npm run bench` from a checkout; `--json` for every scenario with expected vs actual; exit 1 on any failure, so it can gate CI).
It has five suites, as plain JSON scenario files you can extend in [`bench/scenarios/`](https://github.com/calasdan-sketch/monomem/tree/main/bench/scenarios).

| Suite | Scenarios | What it checks | Headline number |
|---|---|---|---|
| A  Stale memory | 32 | a fact updated, replaced, deleted, aged: is the current value first and the old one never shown (or flagged)? Includes the two-step replace (preview writes nothing; the code is single-use, expires, and is bound to one caller) | `stale-hit-rate@1/@5`, `current-recall@1` |
| B  Contradiction recovery | 31 | writer A vs writer B, then a trusted correction; distrusting the bad writer; weak overwrite of a trusted note; restoring the trusted text from history; the trust guard on replacing | resolved to the correction, loser stays visible, overwrite protected |
| C  Permission isolation | 27 | cross-tenant read/write/search/export/import/merge/sweep, token scopes, admin-only flags, signed imports, and that one tenant cannot read another's history, preview, undo or reuse a confirmation code | `leakage-count` (must be 0), `unexpected-denials` |
| D  Provenance retention | 19 | source, writer, creator, timestamps, deletion deadline, confidence after export, import, merge, update | `fields-lost` |
| E  Memory poisoning | 20 | injected or malicious memories never reach an agent as trusted content: prompt-injection (plain, forged tags, zero-width-obfuscated, hidden in invisible Unicode tag characters, a booking-policy override) is quarantined; a sleeper trigger or curl-pipe-to-shell note is stored with a warning; a reworded override that passes the gate leaves all four booking answers once its writer is distrusted; a distrusted/low-trust writer cannot outrank or silently overwrite a trusted fact; secrets are redacted (capture) or blocked (write); a forged writer/namespace is stamped with the real one; an unsigned import cannot pose as verified; a captured web fetch is not trusted memory; a trusted writer claiming its note is its own is still checked; SessionStart injection carries the untrusted-data banner and leaves distrusted notes out; mass near-duplicate flooding cannot bury the answer | `poison-reach-count` (must be 0) |

**Retrieval quality.** `monomem bench --longmemeval` and `--locomo` score retrieval on the public datasets, with no model
and no judge (does the right conversation come back?). On one Windows PC, 2026-11-09, keyword search (the default, no model):

| Dataset | Recall@5 | Recall@10 | Search time (p50) |
|---|---|---|---|
| LongMemEval-S, 470 of 500 questions (the 30 abstention questions have no right answer to find) | 96.6 % | 98.3 % | 2.8 ms |
| LoCoMo-10, 1,982 questions, by session | 90.3 % | 95.5 % | 1.0 ms |
| LoCoMo-10, 1,982 questions, by turn (the hard one: our weakest number) | 57.8 % | 65.0 % | 1.1 ms |

Optional hybrid search (keywords plus a local embedding model, `nomic-embed-text` via Ollama) does better still: LoCoMo-10
by session 91.8 % / 96.7 %, by turn 66.3 % / 74.9 %, LongMemEval-S 98.5 % / 99.4 % (recall@5 / @10, full runs,
13 to 22 ms per search (p50), measured 2026-11-09 with this code). Ties between equal scores go to the newest note, so a re-run
can move a by-turn figure by about 0.1 to 0.2 points.

These are retrieval numbers, not the end-to-end QA accuracy memory vendors usually publish, so they are not comparable with
those. Every number, the per-type breakdown, where hybrid is worse, and the caveats: [docs/BENCHMARK.md](./docs/BENCHMARK.md#retrieval-longmemeval-s-and-locomo).

**What it does not measure.** The provenance suites above are not a retrieval-quality or semantic-search benchmark (keyword search, made-up unique words, no
embeddings). It does not measure speed, scale or concurrency, and "0 leaks" means none of *these* probes leaked; it is a regression gate,
not an audit. Details and the scenario format: [docs/BENCHMARK.md](./docs/BENCHMARK.md). Another memory system can be tested by
writing a small adapter (write, update, delete, search, plus the actor: writer and namespace).

**Replacing a memory** is always two steps on every surface: a preview that changes nothing and shows exactly what would
stop appearing in search, then a confirm with the preview's one-time code. Nothing is deleted, undo is one command, and every
edit keeps the text it replaces. See [docs/replacing-memories.md](./docs/replacing-memories.md).

**Known gaps in the benchmark:** none open. Scenarios for behaviour Monomem lacks are kept and marked rather than deleted, and the history
of each one and how it was fixed is in [docs/BENCHMARK.md](./docs/BENCHMARK.md#known-gaps-history), with the provenance-field breakdown.

Limits no scenario can show (what the benchmark cannot see) are listed next, under Known limits.

## Known limits

- The write check is pattern matching. A reworded attack it does not know passes; `monomem drill` replays the attacks it does know.
- Monomem guards what goes through it. A program that can run shell commands, or open the database file itself, is not stopped.
- Local apps connected over stdio have no key, so a limit on other apps does not apply to them. A note marked `private` is hidden from
  apps given a limit; apps with no limit (including your main Claude connection) still see it.
- The writer name of a local app comes from its config file: it tells your apps apart, but it is not proof.
- Keyword search finds words, not meaning. Semantic search needs a local embedding service (Ollama); without one you get keyword results.
- Upgrading the database is one way (older versions refuse a newer file). A backup copy is made first and `monomem restore` goes back.
- Needs Node 22.16 or newer, because it uses Node's built-in SQLite (Node 20 does not have it; checked). Docker is the way around that.
- Lowering a note's label does not rewrite its older saved versions.

## Honest numbers

- **Finding a note again (keyword search only, top 5 results, from a QA pass).** Questions that use the note's own words: the right note was
  in the top 5 about **95%** of the time. Reworded questions that share few words with the note: about **50%**. Semantic search
  (`MONOMEM_EMBEDDINGS=on`, needs a local Ollama) helps with the reworded ones; without it Monomem does not understand meaning. These come
  from a QA pass, not from the benchmark above: treat them as a rough guide and test on your own notes.
- **What it adds at the start of a session.** A store of 60 short notes at the default setting (`MONOMEM_RECALL_TOKENS` = 1,500) produced
  about 5,900 characters, roughly **1,500 tokens** (estimated at 4 characters a token), listing all 60 notes (measured 2026-11-09 with
  `node bench/recall-size.mjs`, which you can run yourself). The block is capped at 8,000 characters. `monomem meter` shows what yours actually costs and saves, as estimates.

## Security in one paragraph

Loopback by default and fail-closed: it refuses to bind a public interface
without an explicit `MONOMEM_TOKEN`. Constant-time bearer auth on every
data route, scoped tokens, DNS-rebinding Origin checks, per-client rate
limits, size caps, an append-only audit log without note content, a read access log (who read
what, with a redacted query preview and never note text) and a per-writer flood guard, the
write-time linter above, and an untrusted-data banner on every MCP read (REST responses do not
carry it) so agents treat note content as data, not instructions. Optional AES-256-GCM
encryption at rest for note bodies only (`monomem encrypt enable`; titles,
tags, timestamps and embeddings stay readable), per-note
TTL with reversible soft-archive, and `?explain=1` so a caller can see why
a memory was retrieved. **Per-token namespace permissions** pin a token to
one namespace so a single shared bridge stays isolated per agent — a pinned
admin token is still confined. Your notes stay in one
file on your machine; a tunnel only carries requests. Details and known
limits: [SECURITY.md](./SECURITY.md),
[docs/token-namespaces.md](./docs/token-namespaces.md), and
[docs/encryption-retention.md](./docs/encryption-retention.md).

**About the retrieval eval.** `evals/cross-device-tasks.json` is 10 tasks over
10 notes and lexically easy; its perfect score is a regression gate in CI,
not evidence of retrieval quality. Keyword-only `state_search` scores 1.00
recall@1 on it. See [docs/encryption-retention.md](./docs/encryption-retention.md#the-evaluation-set).

## Leaves no trace

Monomem writes to its data folder (`~/.monomem`) and, through `monomem setup`, to the one `monomem` entry in each
app's config, with a backup beside it. Nothing lands in your projects unless you name the folder (`--project`, `--dir`,
`--out`, `sync --git`), no `CLAUDE.md` is ever written, and every retry has a limit. `monomem uninstall` takes it out
of every app (byte for byte where it can), `--purge` also deletes the data after a final backup. Every file, and how to
remove it: [docs/footprint.md](./docs/footprint.md).

## Documentation

| | |
|---|---|
| [INSTALL.md](./INSTALL.md) | every MCP client |
| [INFRA.md](./INFRA.md) | tunnels, phone/web access, n8n |
| [docs/configuration.md](./docs/configuration.md) | all environment variables, server-side namespace resolution |
| [docs/search.md](./docs/search.md) | semantic, time-aware and relevant search; staleness; consolidation |
| [docs/change-feed.md](./docs/change-feed.md) | `memory_since` / `GET /changes` |
| [docs/tasks.md](./docs/tasks.md) | task board, claims, command tasks, handoffs, one-call catch-up |
| [docs/memory-linter.md](./docs/memory-linter.md) | `MONOMEM_LINT`, detection rules, quarantine |
| [docs/access-log.md](./docs/access-log.md) | read access log (`monomem access`), flood guard (`monomem flood` / `resume`) |
| [docs/live-claude-code.md](./docs/live-claude-code.md) | `monomem setup` step by step, checking it in live Claude Code, troubleshooting |
| [docs/file-sync.md](./docs/file-sync.md) | Markdown export/import, `sync --git` (optionally sealed), GitHub and Syncthing workflows |
| [docs/sessionstart-hook.md](./docs/sessionstart-hook.md) | automatic recall at Claude Code session start |
| [docs/encryption-retention.md](./docs/encryption-retention.md) | at-rest encryption, retention (TTL + archive), retrieval visibility |
| [docs/provenance.md](./docs/provenance.md) | who wrote a note: server-stamped `written_by`, filters, what is and is not trusted |
| [docs/trust.md](./docs/trust.md) | distrust list, writer ids, signed attestations: what each does and does not prove, upgrade and rollback |
| [docs/team.md](./docs/team.md) | shared memory for a team: one server, one token per person, namespaces, approve-first, sync, backups |
| [docs/sensitivity-labels.md](./docs/sensitivity-labels.md) | public / internal / private labels and per-token ceilings; what a hidden note looks like |
| [docs/give-an-app-limited-access.md](./docs/give-an-app-limited-access.md) | give one app its own key and a limit, step by step |
| [docs/two-developers-one-server.md](./docs/two-developers-one-server.md) | two people, one Docker server, a key each, private notes kept apart |
| [docs/checkups.md](./docs/checkups.md) | `pii scan`, `digest`, `scrub`, `safety-report`, `audit` |
| [docs/token-namespaces.md](./docs/token-namespaces.md) | per-token namespace permissions — one shared bridge, isolated agents |
| [docs/replacing-memories.md](./docs/replacing-memories.md) | replacing a note in two steps, undo, version history and restore, confidence, the trust guard |
| [docs/BENCHMARK.md](./docs/BENCHMARK.md) | `monomem bench`: stale memory, contradiction recovery, permission isolation, provenance retention; scenario format; adapting it to another memory system |
| [docs/footprint.md](./docs/footprint.md) | every file Monomem writes, where and when, how to remove it; `uninstall`; retry limits; every outbound call (none by default) and the token cost of memory |
| [docs/architecture.md](./docs/architecture.md) | modules, tools, REST API, schema |
| [SKILL.md](./SKILL.md) | when and how an agent should use the memory |
| [CHANGELOG.md](./CHANGELOG.md) | release notes |

## Credits

Several ideas were adapted from other open projects, with thanks:

- **[llmem](https://github.com/netrixone/llmem)** — consolidation candidates,
  the similarity-edge graph, access-count importance, `#status` staleness, and
  the context/relevant split with keyword extraction.
- **lontar** (rymanalu, described in *"One memory across AI agents: what it
  actually takes"* on dev.to) — the fail-silent SessionStart recall hook,
  server-side namespace resolution from the working directory, and
  one-directional `reads_from` grants.
- **[lossless-memory](https://github.com/aru-labs/lossless-memory)** —
  natural-language time phrases as a first-class query filter.

## License

MIT — see [LICENSE](./LICENSE). Built by Calas Automations Inc.
