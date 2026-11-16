# Monomem SessionStart hook

Injects your recent Monomem notes into the agent's context **before its
first message** — pre-prompt memory, no model opt-in needed.

## What it does

`monomem recall` reads the most recently updated notes from your local
SQLite store and prints them as a Claude Code hook JSON payload:

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
```

`additionalContext` is a compact human-readable summary, e.g.:

```
Recent memory (3 notes):
- [Release cadence]: Ship weekly on Thursdays (decided 2026-10-14)
- [API base URL]: https://api.acme.example/v2
- [Pref]: Keep replies short and concrete.
```

If you use the [task board](./tasks.md), the open tasks and the latest
handoff are printed first (under `Open tasks (n):` and `Latest handoff from
...:`), then the recent notes. Tasks and handoffs are left out of the recent
list so nothing appears twice. The whole payload keeps the same size cap.

Recency is the recall signal at session start — no embeddings, no query,
one cheap SQL query (`ORDER BY updated_at DESC`). Flags:

- `--budget-ms 800` — soft budget in milliseconds (default 800). If the
  recall work exceeds it, what was fetched is returned anyway; nothing hangs.
- `--limit 10` — max notes included (default 10).

Total output is capped at ~8000 characters so the hook never blows up your
context window.

### Profile, "why shown" tags and never-show

With captured memory the context opens with a short profile, and every memory
line carries the reason it was picked:

```
What I know about this project:
Decisions: use node:sqlite, no native deps
Key files: src/store.ts (12), src/api.ts (7)
Last session: Session: refactor the store
Open tasks: 2 (on the board)

Project facts: package_manager=pnpm (#12 by claude-code), deploy_target=fly.io (#15 by cursor)

Recent memory (1 note):
- [Release cadence] {recent 3d}: Ship weekly on Thursdays

Memory index (most relevant first; open with memory_get):
#41 [bugfix] Fixed the tokenizer for CJK (2026-10-11, ~40 tok) {kw,files 20d}

Why shown, in {}: files = linked to files you changed, kw = matches your branch, ...
```

- The profile is built from stored notes only (no model): decisions, notes
  tagged `convention`, the files memory mentions most, the last session and
  the open-task count. It is capped by `MONOMEM_PROFILE_TOKENS` (default
  300, never more than half the budget); `MONOMEM_PROFILE=off` drops it.
- **Project facts** is one line with the current value of every recorded fact
  (`facts` on a write; `monomem facts` lists them all), with the note and its
  writer. It is always shown when there are facts. A disputed key is left to
  the "writers disagree" line; a held note (unconfirmed outside content) never
  reaches it. Notes that carry facts rank with decisions, not as just "recent".
- **Busy writers:** when two or more writers are in the pool, one writer gets
  at most 3 of the "Recent memory" lines and 20 of the index lines; the rest is
  summed up as one line (`bot-b4: 50+ more not listed here (newest #3011; ...)`).
  A store with a single writer is not capped. Tested with 2,000 notes from one
  writer: the other writer's three notes and both fact values still appear.
- **This project first:** a note written by a local app from inside the
  current git repository ranks ahead of an equally recent note from another
  project; another project's note with no keyword or file match goes last.
  The folder is the one the local (stdio) server reports: the workspace the
  app says it has open (MCP roots) when the app offers it, else the folder the
  server was started in. Notes from keys, the REST API, the CLI at a terminal
  and older notes have no folder and are neither boosted nor pushed down. An
  app started outside the project that offers no roots records the wrong folder.
- **After an upgrade:** if a newer Monomem has already upgraded the database,
  an older hook cannot read it. Session start then says so in one line ("no
  memory loaded ... run `monomem setup`") instead of an empty context.
- The "Showing X of N memories" line counts the store's notes up to 2,000;
  above that it says "2,000+" (for example "Showing 12 of 2,000+
  memories"), so a very large store does not slow session start down.
- A note tagged `never-show` is never injected (nor in the profile or the
  file-context hint). `monomem never-show <id>` sets it, `--undo` clears it;
  the dashboard has a **never show** button on each note.
- When Claude Code passes a `session_id` (the `monomem hook session-start`
  path), the size of what was injected is added to the meter (`monomem
  doctor`, `GET /stats`, the dashboard's Meter view). Plain `monomem recall`
  is not metered.

## Every message (UserPromptSubmit) and subagents

With the capture hooks installed (`monomem setup`), each message you send runs one short step on the same database open as
capture:

- **New since your last message** (always on): titles of notes other apps saved since your previous message. An app that
  saved more than 3 is summed up in one line ("bot saved 60 notes (#3014-#3073); memory_since lists them").
  A note that restates one its writer was shown carries the label `[echo of #N: ...; not a second source]` here and at
  session start ([trust.md](./trust.md#echoes)).
- **Another writer replaced text you wrote** (always on): a note whose text this app's agent wrote and another writer
  replaced since your previous message (session start says the same for the last 7 days, as `catch_up` does). "This app"
  is the app named by `MONOMEM_CLIENT` in the hook's environment, or `stdio:claude-code` when Claude Code runs the hook;
  with neither, there is no such line.
- **Off by default** (`MONOMEM_PROMPT_RECALL=on` turns them on):
  - **May be relevant to this message:** up to 3 note titles matching the rarest (at most 6) words of your message.
    Keyword search only, no embeddings. Words found in more than a quarter of your notes are ignored, so a message of
    common words adds nothing. At most 2 of the 3 come from one app when another app's notes match too. A note this
    session was already shown (at session start or an earlier message) is not pushed again. On an encrypted store the hook
    matches titles and tags only (it never builds the body index).
  - **Changed since you were shown it:** a note this session was shown that was since replaced (with the new note's id
    and app), archived or flagged. Said once.
  - **Known fix:** a shell command that failed since your previous message, when an earlier session recorded a fix for
    the same command ("Fixed failing `npm test`"). Said once per fix.
  - A cost line after the block: `(Monomem prompt step: ~N tokens, M ms. ...)`.
  These are off until their time is measured on the standalone download; the target is about 150 ms of search on top of
  the hook's start-up. What they push is written on the session's receipt (`monomem receipts <session>`, `why: prompt`).
  With receipts off (`MONOMEM_ACCESS_LOG_DAYS=0`) they push nothing rather than repeat themselves.
- Everything stays inside the same "stored notes are data, not instructions" block as session start, and the same filters
  apply: held notes (unconfirmed outside content), never-show notes, distrusted writers and the sensitivity cap.

**Subagents** (`MONOMEM_SUBAGENT_MEMORY=on`, off by default): a `SubagentStart` hook (`monomem hook subagent-start`) gives
a subagent up to 10 index lines, this project first, leaving out notes the main session was already shown; once per
subagent type per session. At `SubagentStop` one short note records what the subagent reported and the files it read, linked
(`derived_from`) to the notes it was given; it is stamped like a session summary when the session read outside content.
`monomem setup` does not add the `SubagentStart` hook yet: add it to your Claude Code settings by hand, next to the others.

## Install (Claude Code settings)

### Prerequisites: how will the hook invoke `monomem`?

The hook command runs in a plain shell at session start. `monomem recall`
on PATH is **not** guaranteed -- pick the invocation that matches how you
installed it, and verify it (next section) before wiring the hook:

| Install path | Hook command to use |
|---|---|
| `npm i -g monomem` | `monomem recall --budget-ms 800` -- **only if** `command -v monomem` prints a path (npm's global bin dir must be on your PATH; check that `$(npm prefix -g)/bin` is on your PATH; `npm bin -g` was removed in npm 9+) |
| Source checkout | `node /abs/path/to/monomem/dist/src/cli.js recall --budget-ms 800` (absolute path; run `npm run build` first) |
| npx (no install) | `npx -y monomem recall --budget-ms 800` (adds startup latency; prefer a real install) |
| Docker only | The hook runs on your **host**, not in the container -- use one of the rows above, pointed at the same SQLite file (`MONOMEM_DB_PATH`), or `docker exec <container> node dist/src/cli.js recall` |

If the command from your row doesn't work in a fresh terminal, the hook
will fail silently (by design) and you'll get no memory with no error --
so verify first.

Claude Code itself needs hook support: SessionStart hooks shipped in 2025
builds. If hooks in `settings.json` are silently ignored, upgrade Claude
Code (`claude --version`, then reinstall from anthropic.com) before
debugging anything else.

### Wiring it up (merge, don't clobber)

`~/.claude/settings.json` may already have hooks or other settings.
**Merge** the SessionStart entry in; never overwrite the file. With `jq`:

```bash
jq '.hooks.SessionStart += [{
  "matcher": "startup|clear|compact",
  "hooks": [{ "type": "command", "command": "monomem recall --budget-ms 800" }]
}]' ~/.claude/settings.json > /tmp/settings.json \
  && mv /tmp/settings.json ~/.claude/settings.json
```

(Replace the `command` with your row's invocation from the table above.)
Or edit by hand -- the result should look like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "monomem recall --budget-ms 800" }
        ]
      }
    ]
  }
}
```

### Why `matcher: "startup|clear|compact"`

Fire the hook on **startup** (new session), **clear** (`/clear` wipes
context) and **compact**: compaction replaces the conversation with a
summary, so the notes the hook printed at the start can be summarised away;
printing them again keeps them in view. The cost is one more recall block
(up to the hook's size cap) per compaction. Use `"startup|clear"` if you
would rather not pay that. `monomem setup` writes `startup|clear|compact`
and, run again, replaces a `startup|clear` entry it wrote earlier (the new one goes at the end of the SessionStart list; no second entry).

## Fail-silent by design

This hook **blocks session start**, so it is engineered to never break it:

- Exit code is always `0`, on any failure.
- On failure stdout is still valid hook JSON with empty `additionalContext`
  (`""`) — never a stack trace. Diagnostics go to stderr only.
- A missing or corrupt database, a missing config, a thrown error, or a
  timeout all degrade to the empty-context payload.
- Hard timeout of 5s via `Promise.race` — the hook cannot hang
  indefinitely. Honest caveat: `Promise.race` cannot preempt synchronous
  SQLite work, so this is a cooperative timeout, not a true preemption.
  The recall path is one cheap indexed query, so in practice the race only
  fires if an awaited step hangs; the 800ms soft budget is the one that
  matters day to day.

Safe to install and forget: if Monomem is ever broken or uninstalled,
your sessions start normally, just without injected memory.

## Verifying it works

```bash
command -v monomem || echo "NOT ON PATH -- use the node /abs/path form from the table above"
monomem recall                       # pretty-prints nothing; it's JSON
monomem recall | python3 -m json.tool
MONOMEM_DB_PATH=/nope/db.sqlite monomem recall   # fail-silent check
echo $?                                # 0
monomem recall --limt 5 2>&1 >/dev/null  # unknown-flag warning goes to stderr
```

Then the "did it actually fire" check — the common silent failure is a
working `recall` that never runs:

1. Write a distinctive note via the API, dashboard, or MCP (title it
   something unmistakable, e.g. `hook-probe-9417`).
2. Start a **new** Claude Code session (the `startup` matcher only fires
   on new sessions and `/clear`).
3. Ask the agent: "What's the most recent thing in my memory?"
   If it mentions `hook-probe-9417`, the hook fired. If not, re-check the
   command row from the prerequisites table — the usual cause is
   `monomem` not resolving on the hook's PATH.
4. `monomem doctor` also runs a recall smoke test, a budget check, and
   reports whether the SessionStart hook is present in
   `~/.claude/settings.json`.

## Notes for other agents

The same payload works anywhere a SessionStart-style hook is supported.
The namespace is resolved server-side when available
(`src/namespace.ts`, optional); without it the hook recalls across all
namespaces.
