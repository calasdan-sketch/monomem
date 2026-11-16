# Read access log and flood guard

Two operator tools for a store several agents share: a log of **who read memory**, and a **flood guard** that pauses a
writer making far too many writes. Both are for the person running Monomem. No MCP tool reads the log, lifts a pause,
or changes either setting, so one agent cannot see another agent's queries.

## Read access log

Every memory read an agent makes adds one row:

| Column | What it holds |
|---|---|
| time | when the read happened (UTC) |
| writer | the same identity a write would be stamped with (`written_by`): the authenticated token's label, or a fixed marker for callers with no token (`stdio`, `cli`, `capture`, `server`, `runner`) |
| tool | the MCP tool (`state_search`, `memory_get`, ...), the REST route (`GET /search`, `POST /relevant`, `GET /notes/:id`, ...) or the hook (`hook:recall`, `hook:file-context`) |
| namespaces | the namespace the caller asked for, plus the namespaces of the results that came back |
| query | a preview of what was asked: the search text when there is one, otherwise the call's arguments (or the REST query string, or the file path for `hook:file-context`). It goes through the same secret redaction as captured events (`[REDACTED:...]`), is cut to **120 characters** on one line, and is encrypted when at-rest encryption is on |
| results | how many items came back: the count of entries with an `id` in the response (notes, index rows, changes, tasks) |

**Never logged:** note text, titles, tags, or anything else from the results. The query preview is the only free text,
and it is the caller's own question after redaction.

What counts as a read:

- MCP tools (stdio and HTTP): `state_read`, `state_search` (every mode), `state_relevant`, `state_list`, `catch_up`,
  `memory_since`, `memory_get`, `memory_index`, `memory_timeline`, `memory_history`, `memory_stats`,
  `memory_consolidation_candidates`, `session_list`, `task_get`, `task_list`. A call that returns an error is not logged.
- REST routes that answer 200: `GET /notes`, `/notes/:id`, `/notes/:id/history`, `/search`, `/index`, `/timeline`,
  `/sessions`, `/sessions/:id`, `/files/timeline`, `/changes`, `/stats`, `/tasks`, `/tasks/:id`, `/handoffs`,
  `/catch-up`, `/quality`, `/export`, and `POST /relevant`, `/get`. The dashboard uses these routes with its token, so
  its reads are logged under that token's label.
- The session-start context (`hook:recall`) and the per-file context (`hook:file-context`) the capture hooks inject.
  These run as local commands, so their rows carry `capture` (`monomem hook ...`) or `cli` (`monomem recall`).

Reads through the `monomem` CLI's own commands (`monomem relevant`, `monomem export`, ...) are not logged; the
operator is the one reading.

Writing a row never breaks the read: if it fails (a read-only file, a missing encryption key) the read goes on unlogged.

### Viewing it

```
monomem access                                 # newest 100 rows
monomem access --since 24h --writer laptop-agent --limit 500
monomem access --json
```

`--since` takes an ISO time or a duration (`90s`, `30m`, `24h`, `7d`, `2w`). `--writer` is an exact label.

Over REST: `GET /access?since=24h&writer=<label>&limit=100` returns `{ entries, paused }`. It needs an **admin** token
that is **not pinned to a namespace** (the log is store-wide: one writer's queries can cross namespaces). Reading the
log is not itself logged.

### Retention

`MONOMEM_ACCESS_LOG_DAYS` (default `30`) days, pruned by the hourly expiry sweep that the server and the stdio MCP
server already run. `0` turns logging off; the next sweep then deletes every row that is left.

## Flood guard

If one writer identity makes more than `MONOMEM_FLOOD_WRITES_PER_HOUR` (default `500`) counted writes in a rolling hour,
its next write is refused, the writer is **paused**, a `flood-pause` line goes to the audit log and a warning to
stderr of the Monomem process that took the write. Every later create, update, forget (archive) or restore from that writer is refused with
`writer "<label>" is paused by the flood guard ... monomem resume <label>` (HTTP status 429 over REST) until an
operator lifts it:

```
monomem flood                 # is anyone paused? what is the limit?
monomem resume laptop-agent   # accept its writes again (its count starts over)
```

Over REST (admin token, not namespace-pinned): `GET /flood` returns `{ paused, writes_per_hour }`, and
`POST /flood/resume` with `{ "writer": "<label>" }` lifts a pause. `monomem access` also lists paused writers.

The paused set is stored in the database, so restarting the server does not clear it.

**Never paused:** the `monomem` CLI and the main key (`primary`, the key the dashboard signs in with). The guard is there to
stop a runaway agent, not you. So do not hand the main key to an agent: give each app its own app key, which the guard counts.

**What is counted:** every create and update call from that writer that reaches the guard, whether it is then stored,
held in the quarantine queue, or refused by validation (a loop sending bad writes is still a flood). Replacing a note
counts as the create it makes.

**What is never counted or paused:**

- the local `monomem` CLI (writer `cli`), so the operator can always clean up;
- the server's own jobs (writer `server`, e.g. file sync);
- approving a held write and consolidation (internal re-writes of stored content);
- restoring a backup (`monomem import`, `POST /import`);
- library callers with no writer identity.

Hard deletes are not counted or refused (they are admin-only).

**Local apps are counted by their label.** An app that `monomem setup` labelled is stamped `stdio:<app>` (for example
`stdio:cursor`) and has its own count and its own pause. An app still on an unlabelled entry is stamped plain `stdio`,
and every such app shares that one count. The label is self-declared by the app's config, so it separates well-behaved
apps rather than containing a hostile one. Over HTTP each token has its own label and its own count.

`0` turns the guard off. Writers already paused stay paused until resumed.

### Limits

- The count is per writer label, not per agent: two agents sharing one token share one count.
- Two processes writing at the same moment can each pass the check, so a writer can go a few writes past the limit
  before it is paused.
- When the write that trips the guard runs inside a larger transaction (a task update, for example), the refusal rolls
  that transaction back, the recorded pause with it. The count is already over the limit, so the writer's next write
  trips the guard again and is refused.
