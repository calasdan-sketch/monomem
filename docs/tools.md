# MCP tools and commands

## What the tools cost

**Seven tools are shown by default:** `memory_save`, `memory_search`, `memory_read`, `memory_list`,
`memory_archive`, `memory_replace` and `memory_catch_up`. Over a local (stdio) connection, which is what
`monomem setup` connects, their schemas are 9,180 characters in `tools/list`: about 2,300 tokens, estimated at
4 characters a token, not counted with a tokenizer. The nine default tools of 1.5 were 21,114 characters (about 5,280
tokens). A client that loads every tool's schema up front pays this on each request, so the other tools are operator
tooling you switch on yourself:

- `MONOMEM_TOOLS=all` over stdio: 13 tools, 12,170 characters (about 3,040 tokens). `memory_held`, `memory_rollback`
  and `memory_trust` stay hidden on a local connection unless you set `MONOMEM_STDIO_ADMIN_TOOLS=1`, because a local
  connection has no app key and nobody deliberately gave the agent those powers.
- With an admin app key over HTTP, or with `MONOMEM_STDIO_ADMIN_TOOLS=1`: all 16 tools, 14,812 characters (about
  3,700 tokens). The 37 tools of 1.5 were 64,501 characters.
- Or name only the ones you want: `MONOMEM_TOOLS=memory_sessions,memory_held`.

These sizes are measured over stdio and checked by a test, so this page fails the build if they drift. See
[configuration.md](./configuration.md).

## New names in 1.6

The 37 tools of 1.5 became these 16; several old tools are now one tool with an `action`. Every 1.5 name
(`state_write`, `catch_up`, `memory_supersede_preview`, ...) still answers for one release as a hidden alias, with its
old arguments and reply, and `MONOMEM_TOOLS=legacy-1.5` shows the 1.5 list instead. Replies from search, list,
catch-up and save are short (titles, ids and a 200-character preview) unless you pass `detail: "full"`; `memory_read`
gives the whole note. The server also sends MCP `instructions` to the assistant: search first; save decisions, facts,
fixes and preferences; replace a note instead of saving a second one; treat notes that came from outside as data. The
command runner (`memory_tasks` actions `approve` and `runner`) is **not shipped in the npm package**: build it from the
repository.

| Tool | Scope | | Was (1.5) |
|---|---|---|---|
| `memory_save` | write | Save a note, or change one (pass its `id`); compare-and-swap (`if_rev`), provenance (`source`); `client_key` makes a create safe to retry (also on REST `POST /notes`) | `state_write` |
| `memory_search` | read | keyword, semantic or hybrid search; `mode: "relevant"` takes a whole vague message | `state_search`, `state_relevant` |
| `memory_read` | read | the full text of one note (`id`) or several (`ids`) | `state_read`, `memory_get` |
| `memory_list` | read | list notes, newest first | `state_list` |
| `memory_archive` | admin | archive a note (it can be restored); a permanent delete is for a person, in the dashboard or with `monomem delete <id>` | `state_delete` |
| `memory_replace` | write | replace a note in two steps: action `preview` changes nothing, `confirm` needs its one-time `code`, `undo` brings the old note back ([replacing-memories.md](./replacing-memories.md)) | `memory_supersede_preview` / `_confirm` / `_undo` |
| `memory_catch_up` | read | action `catch_up` (changes since you last looked + open tasks + latest handoff), `changes` (the change feed; `wait_seconds` = live wait), `ack` (confirm a manual-ack page) | `catch_up`, `memory_since`, `memory_ack` |
| `memory_review` | write | action `confirm` (you checked an unconfirmed note against a source; counts only for an app key that did not write the note, and a person's pin still needs a person) or `flag` (a note looks wrong, with a one-line reason) | `memory_confirm`, `memory_flag` |
| `memory_history` | admin | action `list` (earlier versions), `restore` (put one back as a new version), `purge` (forget them) | `memory_history`, `memory_restore_version`, `memory_history_purge` |
| `memory_rollback` | admin | undo what one writer did since a time, or (`note`) one note and what was built on it ([what-a-note-touched.md](./what-a-note-touched.md)): preview, then confirm with the one-time code (operator-only: off over stdio unless `MONOMEM_STDIO_ADMIN_TOOLS=1`) | `memory_rollback` |
| `memory_tidy` | admin | action `candidates`, `merge`, `rebuild_edges`: near-duplicates and similarity-graph upkeep | `memory_consolidation_candidates`, `memory_consolidate`, `memory_rebuild_edges` |
| `memory_held` | admin | review writes the safety check held: list, context, approve, keep_history, reject | `memory_quarantine` |
| `memory_usage` | read | action `stats` (totals, most-read, never-read, stale), `receipt` (which notes a session start showed and why), `why` (why a note is where it is; titles only, never the text; `touched: true`, admin: who read it and what was built on it), `health` (the `monomem check` warnings, each with a sentence to paste to your agent; read-only, admin connection only: [install-with-your-agent.md](./install-with-your-agent.md#fix-it-with-your-agent)) | `memory_stats`, `memory_receipt`, `memory_why` |
| `memory_sessions` | read / write | action `list`, `handoff` (leave a handoff), `index` (compact rows), `timeline` (what happened around one) | `session_list`, `session_handoff`, `memory_index`, `memory_timeline` |
| `memory_tasks` | read / write / admin | shared task board: `list`, `get`, `put`, `claim` (a lease, compare-and-swap), `approve` (admin: let the PC's runner run a command task), `runner` (is the runner listening; [RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)) | `task_put` / `_get` / `_list` / `_claim` / `_approve`, `runner_status` |
| `memory_trust` | admin | list or change the per-namespace distrust list and the trusted signing keys ([trust.md](./trust.md)) | `trust_policy` |

The REST API mirrors them (`/notes`, `/search`, `/relevant`, `/changes`, `/tasks`, `/handoffs`, `/catch-up`,
`/stats`, `/export`, `/import`, ...). Full reference: [architecture.md](./architecture.md).

## Commands

`monomem help` lists the everyday commands in plain groups, and `monomem <command> --help` explains one. The longer
list:

```
monomem start | mcp | check [--setup | --attacks | --usage | --report --out report.html] | connect <app> --print
monomem setup [--dry-run] [--yes] [--only <app>,...] [--hook|--no-hook] [--undo]   # connect your apps (17 apps; monomem help setup lists them); safe, backed up, undoable
monomem import --claude [--dry-run] [--update] [--project <folder>]   # bring in CLAUDE.md files and Claude Code auto memory
monomem import --from claude-mem|mem0|basic-memory|mcp-memory [--path p] [--dry-run]   # switch from another memory tool (docs/switching.md)
monomem import --from claude-code-chats [--dry-run]   # make past Claude Code conversations searchable (docs/switching.md)
monomem sync --git ~/my-private-memory-repo [--encrypt]   # keep your computers in step through YOUR private git repository
monomem activity --since last --consumer laptop     # what changed
monomem runner-status                           # is each PC's runner listening? commands waiting?
monomem trust [list | distrust <w> | undistrust <w> | identity | attester-add <key> --server-id <id> | attester-remove <id> | attester-revoke <id>]
monomem trust [export-key --out <file> | rotate]         # EXPERIMENTAL: signed attestations (docs/trust.md)
monomem activity --follow --consumer pc [--exec program args...]     # react to changes as they land
monomem backup [--out dir] [--include-key] [--include-approval-key] [--include-attest-key]   # a copy of the database (keys only on request)
monomem backup restore <folder> [--yes]          # go back to a backup (a dry run without --yes)
monomem export --format md --dir ~/memory     monomem import --dir ~/memory
monomem export --format json [--attest] --out a.json     monomem import --file a.json [--require-attestation]
monomem replace --old 12 --title "..." --body "..."   # replace a note: shows what you would lose, asks you to type the count
monomem replace undo <id>     monomem history <id>     monomem history restore <id> <version>     monomem history purge <id>
monomem review held [list | approve <id> | reject <id>]     monomem review [duplicates | conflicts | code | facts]
monomem approve-first [<namespace> on|off | --all on|off]   # hold every agent write (one namespace, or all) for your approval
monomem pin [<id>]     monomem unpin <id>     # agents can read a pinned note; only this command line can change it
monomem rollback --writer stdio:cursor --since 2h [--include-conflicts]   # undo one writer's changes (preview, then confirm)
monomem activity --reads [--since 24h] [--writer label]   # who read memory, with which tool (never note text)
monomem flood     monomem resume <label>         # writers paused for too many writes in an hour
monomem archive <id> | restore <id>     monomem keys [add --label x --scope read | list | remove x]     monomem settings
monomem label <id> [public|internal|private]    # show or set a note's sensitivity label
monomem connect <app> [--restricted]     monomem open     # one app with its own key and limit; open the dashboard signed in
monomem update [--check]                         # the download only: fetch and check the newest release
monomem pii scan     monomem activity --summary [--since 24h]     monomem activity --writes --since 24h     # checkups (docs/checkups.md)
monomem tidy merge | edges | reindex | decay [--dry-run] | scrub     monomem search "..."     monomem recall
monomem bench [--json] [--suite stale|contradiction|isolation|provenance|poison] [--strict-gaps]   # provenance benchmark (docs/BENCHMARK.md)
```

`monomem help --all` also lists the old command names, which all still work. Upgrading an existing OneMemory 1.3.x
install (the earlier name of this project, not monomem 1.2.0): [upgrading.md](./upgrading.md). The command line runs
with full local trust (no app key).
