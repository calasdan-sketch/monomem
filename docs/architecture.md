# Architecture

```mermaid
%%{init: {"theme":"base","flowchart":{"useMaxWidth":false,"htmlLabels":false,"curve":"basis","nodeSpacing":40,"rankSpacing":55},
  "themeVariables":{"fontFamily":"Arial, Helvetica, sans-serif","fontSize":"16px",
  "primaryColor":"#12233f","primaryTextColor":"#eef2fa","primaryBorderColor":"#2b3a5c",
  "lineColor":"#8a9bbd","clusterBkg":"#0d1626","clusterBorder":"#2b3a5c",
  "edgeLabelBackground":"#0b1220","tertiaryColor":"#0d1626"}}}%%
flowchart LR
  AG["Your AI agents<br/>Claude Code · Codex · Cursor<br/>Copilot · Gemini CLI · Zed"]
  AG2["Every agent, next session<br/>knows what the others saved"]

  subgraph mm["Monomem: one small Node process on your machine"]
    direction LR
    IN(["MCP · REST"])
    GATE{"Write check<br/>secrets refused<br/>known attacks held"}
    HELD[["Held queue<br/>waits for your OK"]]
    DB[("One SQLite file<br/>each note keeps<br/>who wrote it, its history<br/>and its privacy label")]
    OUT(["Reads<br/>private notes hidden<br/>from limited apps<br/>distrusted writers left out"])
    IN --> GATE
    GATE -- "clean" --> DB
    GATE -- "suspicious" --> HELD
    HELD -- "you approve" --> DB
    DB --> OUT
  end

  YOU(["You: dashboard and CLI<br/>approve · distrust · roll back · drill"])

  AG -- "save" --> IN
  OUT -- "recall" --> AG2
  HELD -.- YOU
  DB -.- YOU

  classDef agent fill:#0b2e45,stroke:#3fb4ff,stroke-width:2px,color:#e3f3ff;
  classDef entry fill:#12233f,stroke:#7f9cff,stroke-width:2px,color:#e6ecff;
  classDef gate  fill:#3a2c08,stroke:#f0c171,stroke-width:3px,color:#fff3d6;
  classDef held  fill:#3a1518,stroke:#ff7a85,stroke-width:2px,color:#ffe1e4;
  classDef store fill:#0c3a26,stroke:#35d0a5,stroke-width:3px,color:#eafff6;
  classDef read  fill:#12233f,stroke:#35d0a5,stroke-width:2px,color:#e6fff6;
  classDef you   fill:#2b2410,stroke:#f0c171,stroke-width:2px,color:#fff3d6;
  class AG,AG2 agent;
  class IN entry;
  class GATE gate;
  class HELD held;
  class DB store;
  class OUT read;
  class YOU you;
```

*The same diagram as an image (for npm and other viewers that do not draw Mermaid): [monomem-architecture.png](https://github.com/calasdan-sketch/monomem/blob/main/docs/monomem-architecture.png). Source: [monomem-architecture.mmd](https://github.com/calasdan-sketch/monomem/blob/main/docs/monomem-architecture.mmd).*

One store, reached three ways — all pointing at the same
`MONOMEM_DB_PATH`, so a note written through any one of them is
immediately visible through the others:

- **`src/store.ts`** — the shared state layer. SQLite via Node's built-in
  `node:sqlite` (no native module to compile), with an FTS5 index kept in
  sync by triggers so search never goes stale after a write. Notes carry a
  `rev` for compare-and-swap, a provenance `source`, tags, and namespaces.
- **`src/api.ts`** — a small HTTP/JSON API + a built-in web dashboard, on
  plain `node:http` (no framework).
- **`src/mcp-server-core.ts`** — the transport-agnostic MCP server with thirty-five tools, nine of them registered by default (see MONOMEM_TOOLS),
  tools, shared by both MCP transports.
- **`src/mcp-stdio.ts`** — stdio entry point for local Claude Code / Desktop
  / editors.
- **`src/mcp-http.ts`** — the MCP-over-HTTP (Streamable HTTP) endpoint the
  tunnel points at. Stateless: one shared store, a fresh server + transport
  per request.
- **`src/lint.ts`** — the write-time memory linter (secrets + prompt
  injection) and the `MONOMEM_LINT` policy; the store applies it on every
  create/update/import.
- **`src/changes.ts`** — the change feed service (`since` parsing, the
  per-consumer "last" marker) over `Store.changes()`.
- **`src/task-core.ts`** — the command-task queue rule shared by the runner and `runner_status` (no runner code,
  so the server can use it). `src/liveness.ts` builds on it (no import cycle).
- **`src/trust.ts`, `src/attest.ts`** — the distrust rule matchers (one JS, one SQL using a single `json_each` membership test per row, tested to agree), writer ids, and
  the Ed25519 export attestations ([trust.md](./trust.md)). `Store.readVisible` / `filterVisible` are the one gate
  every by-id and set read goes through (`test/trust-gate-guard.test.ts` enforces it).
- **`src/stream-json.ts`** — streaming reader for a JSON backup (`import --file`), so a restore holds one batch in memory.
- **`src/sync.ts`** — Markdown export / three-way import.
- **`src/start.ts`** — boots the API/dashboard **and** the MCP-over-HTTP
  endpoint in one process on a single store (what `npm start`, the CLI, and
  Docker run).

## MCP tools

| Tool | Scope | What it does |
|---|---|---|
| `state_write` | write | Create a note, or update one by `id` (optional `if_rev` compare-and-swap, `source` provenance) |
| `state_read` | read | Read one note; `neighbors: true` attaches up to 10 similar notes |
| `state_search` | read | Keyword / semantic / hybrid search, optional `when` time filter; `mode: "relevant"` does what `state_relevant` does |
| `state_relevant` | read | Extract keywords from a natural message, permissive OR search (not registered by default) |
| `state_list` | read | Newest-first page of notes |
| `state_delete` | admin | Forget a note: archives it (restorable); permanent delete is dashboard/CLI only |
| `memory_stats` | read | Totals, most-read notes, never-read and stale counts |
| `memory_receipt` | read | Opt-in: which memories a session start showed and why (ids, ranks, why-tags; titles looked up live) |
| `memory_why` | read | Opt-in: the story of one note in time order (writer, versions, replacements, holds, pin, sessions shown it, status); titles only, ends with what is not recorded |
| `memory_since` | read | Change feed: what was created/updated/deleted since a time ([change-feed.md](./change-feed.md)) |
| `task_put` | write | Create/update a task on the shared board (status, next_step, owner, priority, due, parent, blockers, `client_key`, `if_rev`; `command` + `target` queues a runner command) ([tasks.md](./tasks.md)) |
| `task_get` | read | One task in full (notes, command, approval state, result) |
| `task_list` | read | List tasks (default: all but done), filter by status/owner/parent |
| `task_claim` | write | Take / heartbeat / release a task with a lease (compare-and-swap) |
| `task_approve` | admin | Approve (or revoke) a command task for the PC's runner ([RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)) |
| `runner_status` | read | Is the PC's runner listening, and how many approved commands are waiting / expiring / expired ([RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)) |
| `session_handoff` | write | Leave a structured handoff (done / pending / decisions / next step) |
| `catch_up` | read | One call: changes since this consumer last looked + open tasks (compact) + latest handoffs |
| `memory_ack` | read | Confirm a manual-ack change-feed page (`ack_token`) |
| `memory_consolidation_candidates` | admin | Near-duplicate pairs (O(n²), single-flight, time-budgeted) |
| `memory_consolidate` | admin | Merge 2+ notes (`dry_run`, `keep_sources`) |
| `memory_rebuild_edges` | admin | Rebuild the similarity graph (confirmation gate above 2,000 notes) |
| `memory_quarantine` | admin | List / approve / reject writes the memory linter held ([memory-linter.md](./memory-linter.md)) |
| `memory_supersede_preview` | write | Step 1 of replacing notes: changes nothing; returns the plain-language "Are you sure?" warning and a one-time code ([replacing-memories.md](./replacing-memories.md)) |
| `memory_supersede_confirm` | write | Step 2: replaces the previewed notes, only with the preview's code (once, in time, for the same caller). Nothing is deleted. A RED FLAG also needs an admin and `acknowledge_risk` |
| `memory_supersede_undo` | write | Bring a replaced note back (recorded) |
| `memory_history` | admin | Earlier versions of a note (bounded per note) |
| `memory_restore_version` | admin | Put an earlier version back as a new version (`if_rev` supported) |
| `memory_history_purge` | admin | Forget a note's earlier versions (cannot be undone) |
| `memory_rollback` | admin | Undo what one writer did since a time: preview (writes nothing, returns a one-time code), then confirm with `code` (all or nothing). Operator-only: off over stdio unless `MONOMEM_STDIO_ADMIN_TOOLS=1`; skips pinned notes and approve-first namespaces ([replacing-memories.md](./replacing-memories.md#rolling-back-one-writer)) |
| `trust_policy` | admin | The distrust list and the trusted export signers: `list`, `distrust`, `undistrust`, `add_attester`, `remove_attester`. A namespace-pinned admin sees and changes only its own namespace's rules ([trust.md](./trust.md)) |
| `memory_index` | read | Automatic memory, step 1: compact rows (id, kind, type, title, date, files, ~tokens) over notes, captured observations and session summaries; filter by query / kind / obs_type / file / session / since (`GET /index`). The query runs the same keyword search as `state_search` (a whole question works), and a captured row next to another hit in the same session ranks higher |
| `memory_timeline` | read | Step 2: compact rows before and after an anchor (a note id, or the best match for query / file / session), oldest first (`GET /timeline`) |
| `memory_get` | read | Step 3: full notes for up to 20 ids, with their files, session and an `om:#id` citation (`POST /get`) |
| `session_list` | read | Recorded agent sessions with their summary; one session's observations (`GET /sessions`, `GET /sessions/:id`) |

## HTTP API

`POST /notes` · `GET /notes/:id` · `PUT /notes/:id` · `DELETE /notes/:id` ·
`GET /notes` · `GET /search` · `POST /relevant` · `GET /stats` ·
`POST /rebuild-edges` · `GET /export` · `POST /import` ·
`POST /notes/:id/archive` · `POST /notes/:id/restore` · `POST /sweep-expired` ·
`GET /changes`, `POST /supersede/preview` · `POST /supersede/confirm` · `POST /supersede/undo`,
`GET /notes/:id/history` · `POST /notes/:id/history/restore` · `DELETE /notes/:id/history` (admin), plus open
`GET /health` (liveness) and `GET /ready` (DB-touch readiness, used by the
Docker healthcheck) and the dashboard at `/`. Every route except `/health`,
`/ready`, and the dashboard requires `Authorization: Bearer <token>`.

`PUT /notes/:id` takes an optional `if_rev` (the `rev` you last read), as the MCP tool `state_write` does: if the note has
been changed since, the edit is refused with `409 { error: "stale write: ..." }` instead of replacing the newer write. Without
`if_rev` the last write wins, as before.
`POST /relevant` takes `{ message, limit?, namespace? }` and mirrors the
`state_relevant` tool (read-scoped, despite the POST method).
`GET /stats` mirrors the `memory_stats` tool (read scope, namespace-gated
like the tool). `POST /rebuild-edges` takes `{ threshold?, namespace?, confirm? }`
and mirrors the `memory_rebuild_edges` tool (admin scope; confined to the
server's own namespace when namespace resolution is active; above 2,000
notes in scope it answers `409` with `{ notes, pairs }` unless `confirm` is
`true`, and `409` while another rebuild is running). `GET
/notes/:id` accepts `?neighbors=true` to attach up to 10 same-namespace
similar notes with similarity scores and staleness fields, mirroring the
MCP `state_read` `neighbors` option.

This plain REST API is also how non-agent tools plug in. **n8n**, for
example, can read and write the store via an HTTP Request node (or its MCP
Client node) — see [INFRA.md](../INFRA.md) § "Use with n8n".

`GET /changes` mirrors `memory_since` (read scope; see [change-feed.md](./change-feed.md)); it requires a `since` parameter and answers `400` without one. `&wait=<0-55>` holds the request open until something changes ([live wait](./change-feed.md#live-wait)).
`POST /tasks` · `PUT /tasks/:id` · `GET /tasks` · `GET /tasks/:id` · `POST /tasks/:id/claim` · `POST /tasks/:id/approve` (admin) · `POST /handoffs` · `GET /handoffs` · `GET /catch-up` · `POST /ack` are the REST side of the task board, handoffs, catch-up and acknowledged reads ([tasks.md](./tasks.md), [change-feed.md](./change-feed.md)); writes need write scope, reads read scope, and namespaces apply as for `/notes`.

### Naming convention (REST vs MCP)

The two surfaces grew separately, so the names differ in a few predictable
ways. The rules, so you can guess the other side:

- REST uses nouns and kebab-case paths (`/catch-up`, `/changes`, `/tasks/:id/claim`);
  MCP uses snake_case verbs-or-nouns (`catch_up`, `memory_since`, `task_claim`).
  `catch_up` and `/catch-up`, `task_put` and `POST/PUT /tasks` are the same operation.
- Request fields are snake_case on both (`next_step`, `if_rev`, `client_key`,
  `ack_token`, `exclude_self`). REST query parameters are the same names.
- Old name wins where both exist: the live-wait length is `wait` on REST and
  `wait_seconds` on MCP. Both surfaces now accept **both** spellings
  (`wait` and `wait_seconds`), so either works anywhere. Prefer `wait_seconds`.
- Prefixes: `state_*` are note CRUD/search (kept for 1.0 compatibility),
  `memory_*` are store-level views and maintenance (`memory_since`,
  `memory_stats`, `memory_ack`), `task_*` and `session_handoff` / `catch_up`
  are the task board. New tools follow `task_*` / `memory_*`; nothing is renamed.
`GET /runner/status` mirrors the `runner_status` tool (read scope; per-runner `targets`, counts and ages, never command text). `GET /trust`, `POST /trust/distrust`, `DELETE /trust/distrust`, `POST /trust/attesters` and `DELETE /trust/attesters/:key_id` are the admin-only REST side of `trust_policy` ([trust.md](./trust.md)); `GET /export?attest=1` adds signatures (the default is the plain `{"notes": [...]}`). `include_distrusted` on any read route is admin-only (403 otherwise).
`POST /notes/:id/archive` and `POST /notes/:id/restore` soft-forget and bring back a note by id; `POST /sweep-expired` archives every note past its TTL (all three are admin scope; see [encryption-retention.md](./encryption-retention.md)).
`POST /notes` and `PUT /notes/:id` answer `202 { quarantined: { id, reasons } }`
when the memory linter holds the write, and add a `warnings` array under
`MONOMEM_LINT=warn`. `POST /import` adds `quarantined` / `rejected` arrays
when non-empty.

## Schema

SQLite, versioned with `PRAGMA user_version`; migrations run on open, all
in one `BEGIN IMMEDIATE` transaction that re-reads the version under the
lock (several processes can open an old database at once), and every step
is idempotent. v1 rev + source, v2 note_vectors, v3 access tracking, v4
similarity edges, v5 `_meta` + gated FTS trigger, v6 edge indexes, v7
`quarantine`, `sync_map`, `sync_base`, `idx_notes_updated`, v8 `change_log`
(+ triggers; replaces the 1.1.0-rc `note_tombstones`) and
`quarantine.set_namespace`, v12 `change_log.actor`, v13 `notes.written_by` /
`created_by` / `imported_written_by` (+ `change_log.written_by`,
`quarantine.written_by`; see [provenance.md](./provenance.md)), v14 (1.4.0) `notes.attested_writer` / `attested_by` /
`merged_from_writers` (+ the matching `change_log.note_*` columns) and three tables: `trust_distrust` (the distrust
rules, per namespace), `trust_attesters` (trusted export signers: key, pinned `server_id`, `label`, optional
`not_after`) and `trust_log` (who changed the policy; newest 1000 rows kept); see [trust.md](./trust.md), v15 (1.6.0) `notes.confidence` /
`confidence_by` / `superseded_by` / `superseded_at` / `superseded_by_writer` and tables `note_history` (earlier versions, bounded per note),
`supersede_used` (single-use confirmation codes) and `supersede_log`; see [replacing-memories.md](./replacing-memories.md), v17
`access_log` (the read access log) and `write_rate` (the flood guard's per-writer counter); see [access-log.md](./access-log.md), v18
`notes.pinned` (CLI-only notes) and `note_history_dropped` (when versions left the history, per writer; no text, for rollback); see
[replacing-memories.md](./replacing-memories.md#pinned-notes-cli-only). Opening an
older database first writes a verified `<db>.pre-v18-backup`. There is no downgrade path: once a 1.1.0 binary
has opened a database, don't go back to 1.0.x.
