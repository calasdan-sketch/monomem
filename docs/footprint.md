# Footprint: everything Monomem writes, and how to remove it

Monomem keeps to two places on its own: **its data folder** and **the config files of the apps you connect with
`monomem setup`**. It never writes into your project folders unless you ask for it with a command that names the
folder (`setup --project`, `export --dir`, `export --out`, `backup --out`, `sync --git`), or `commit-trail on` run inside
that repository. It never writes a `CLAUDE.md` or
`AGENTS.md` unless you run `monomem project-rules` (1.5.0) in that repository at a terminal and type yes; then it writes
only between its own `<!-- monomem:begin v1 -->` and `<!-- monomem:end -->` lines (delete those lines and what is between
them to remove it). It runs no background service you did not start (`monomem service install` adds one; see below), and every queue it keeps has a size or retry limit. A running server makes one backup a day inside the data folder (`backups/`, below).

To take it all out: `monomem uninstall` (configs) or `monomem uninstall --purge` (configs and data, after a final
backup). Both show the plan first and change nothing until you type `y`; `--dry-run` only shows it.

## The data folder

`MONOMEM_HOME`, else `~/.monomem` (in a git checkout of Monomem that already has `./data/state.db`, that `data`
folder). `monomem check --setup` prints which one, and its size.

| File | Written when | Remove |
|---|---|---|
| `state.db`, `state.db-wal`, `state.db-shm` | every note, task, capture event (`MONOMEM_DB_PATH` moves the database elsewhere) | `uninstall --purge` |
| `state.db.pre-v<N>-backup[-<time>]` | once per schema upgrade: the database as it was before | `backup --prune-premigration` |
| `backups/<YYYY-MM-DD>/` (`state.db`, `README.txt`) | automatic daily backup (1.6.0) while the server runs (`monomem start`, `open`, `service`): checked a minute after start, then hourly, at most one a day. Keeps the 7 newest days plus the newest of each of the 4 weeks before them, so at most 11 copies of the database. The encryption key is never copied (the server says once where it is and that it needs its own copy). The dashboard's Settings switch or `MONOMEM_AUTO_BACKUP=off` (wins when set) turns it off | older ones by itself; all: delete the folder, or `uninstall --purge` |
| `state.db.before-restore-<time>` | `backup restore`: the database as it was before the restore (the undo) | by hand |
| `.last-backup`, `backup-status.json`, `.backup-key-warned` | each backup / how the last automatic or dashboard backup went (a failure shows in `monomem check`, the dashboard's Needs you and at session start, until the next good one) / the one-time key reminder | `uninstall --purge` |
| `known-hosts.json` | `monomem settings known-hosts add/remove`: the hosts the opt-in action guard trusts (no file = the defaults: github.com, registry.npmjs.org, localhost); no secrets | `uninstall --purge` |
| `ui-settings.json` | the dashboard's Welcome and Settings (prompt-time recall and daily backups switches, apps you said no to); no secrets | `uninstall --purge` |
| `.token`, `tokens.json` | first start (the API token) / by you | `uninstall --purge` |
| `.key`, `.attest-key`, `.sync-key` | `encrypt enable` / first signed export / first `sync --git --encrypt` (`MONOMEM_KEY_FILE`, `MONOMEM_ATTEST_KEY_FILE`, `MONOMEM_SYNC_KEY_FILE` move them) | `uninstall --purge` (a key moved elsewhere: by hand) |
| `audit.log`, `audit.log.1..5` | every API write; rotated at 5 MB, 5 kept (`MONOMEM_AUDIT_LOG`, `_MAX_BYTES`, `_KEEP`) | `uninstall --purge` |
| `server.log`, `server.log.1..5` | a server with no terminal (`monomem open`, `monomem service`, `start --log`): what it prints (paths, ports, errors; no note text, no key); rotated like `audit.log` | `uninstall --purge` |
| `capture-spool.jsonl` (+ `.draining`) | a capture hook could not open the database; capped at 10 MB, drained by the next hook | `uninstall --purge` |
| `capture.json`, `spaces.json` | by you | `uninstall --purge` |
| `setup-history.json` | each `setup` that changed a file (what `--undo` / `uninstall` replay) | `uninstall --purge` |
| `claude-import-held.json` | `import --claude` (files you chose to hold back) | `uninstall --purge` |
| `claude-import-state.json` (beside the database) | `import --claude` and the optional Claude Code refresh (1.6.0): per imported file, the hash of its text and the ids of the notes it became, so the next run reads only changed files; no note text | `uninstall --purge` |
| `oauth.json` | `monomem oauth on` (1.6.0, off by default): the switch, your public address, the connected apps and SHA-256 hashes of their refresh tokens, never a key (mode 0600). Approved apps also add `oauth:<name>` keys (hashed) to `tokens.json` | `monomem oauth off` ends every app; delete the file and remove the `oauth:` keys to remove every trace; `uninstall --purge` |
| `app-detect.json` | a running server, once a day (1.6.0): which supported apps it found, which are new since the first check and which entries need repair; app names only | `uninstall --purge` |
| `old-names-seen.json` | an old command name typed at a terminal (1.6.0): when each one last printed its "now called" line, so it prints at most once per 12 hours | `uninstall --purge` |
| `.sync-work-*`, `sync-conflicts/<time>/` | `sync --git --encrypt` (work folder, removed after); the losing side of an edit conflict | `uninstall --purge` |
| `sync-git-seen-<id>.json` | `sync --git`: the highest version synced per file, one per repository | `uninstall --purge` |
| `sync.json`, `sync-status.json`, `sync-repo/` | `sync setup`: where to sync and whether the timer is on; the last sync's time and result; the local copy of a git address | `uninstall --purge` |
| `monomem-task.xml` | Windows only, `monomem service install` (the task definition it hands to Task Scheduler) | `service uninstall` / `uninstall --purge` |
| `.migrate.lock` | a few ms while a 1.0.x database is moved out of the package | removed by itself |

## The program folder (only with the download)

The download's `monomem setup` copies the unpacked `Monomem` folder (about 100 MB: Node's official runtime plus Monomem's
code) to one fixed place, so app settings never point into your Downloads folder. No admin rights are needed.

| Folder | Written when | Remove |
|---|---|---|
| `%LOCALAPPDATA%\Programs\Monomem` (Windows), `~/Applications/Monomem` (Mac), `~/.local/share/monomem` (Linux; `XDG_DATA_HOME` moves it) | `monomem setup` from the download | close your apps, then delete the folder by hand: `monomem uninstall` takes Monomem out of your apps and says where the folder is, but a running program cannot delete its own folder on Windows |
| `<program folder>/.old-<version>/` | `monomem update`: the previous version, moved aside during the swap (apps that were open keep running from it) | removed by the next `monomem update`; or delete it by hand once your apps have restarted |
| `<program folder>/.update-<version>/` | `monomem update`: the downloaded archive while it is checked and unpacked | removed by the next `monomem update`; or by hand |
| The **Monomem** entry in the Start menu, `~/Applications`, or the Linux applications menu | `monomem setup` from the download | `monomem setup --undo` / `monomem uninstall` |
| One entry in your per-user PATH (Windows) or one line marked `# added by monomem setup` in your shell's startup file | `monomem setup` from the download, only if you said yes to it | `monomem setup --undo` / `monomem uninstall` |

Your notes are not in the program folder; deleting it does not touch them.

## App config files (only with `monomem setup`)

`setup` changes only the `monomem` entry and, if you agree, the Monomem hooks, in:
`~/.claude.json`, `~/.claude/settings.json` (hooks), Claude Desktop's `claude_desktop_config.json`, `~/.cursor/mcp.json`,
`~/.codex/config.toml` and `~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.config/muse/settings.json`, VS Code's
user `mcp.json`, Zed's `settings.json`, and `./.mcp.json` only with `--project`. Since 1.6.0 also, for the apps it finds:
`~/.cursor/hooks.json` (Cursor's start-of-session hook, only if you say yes to it), Windsurf's
`~/.codeium/windsurf/mcp_config.json`, Devin's `~/.config/devin/mcp_config.json` (on Windows
`%APPDATA%\devin\mcp_config.json`), `~/.kiro/settings/mcp.json`, Cline CLI's
`~/.cline/data/settings/cline_mcp_settings.json` (or `CLINE_MCP_SETTINGS_PATH`), `~/.copilot/mcp-config.json`,
Antigravity's `~/.gemini/config/mcp_config.json`, `~/.qwen/settings.json`, OpenCode's `~/.config/opencode/opencode.json`
(or `.jsonc`) and Kilo Code's `~/.config/kilo/kilo.jsonc` (or `kilo.json`). [apps.md](./apps.md) lists each one. Before each change it saves
`<file>.monomem-backup-<time>` beside the file; `setup --undo` and `uninstall` save `...-before-undo` when the file had
changed since. `setup --action-guard` (opt-in) adds one more `PreToolUse` entry to `~/.claude/settings.json`
([action-guard.md](./action-guard.md)), recorded the same way.

`monomem uninstall` replays every recorded setup in reverse: a file setup created is deleted, a file nobody touched
since is put back byte for byte from its backup, and a file the app changed since keeps those changes and loses only the
Monomem part. An entry setup did not add (one you wrote by hand) is listed, not removed. `--purge` also deletes the
`.monomem-backup-*` copies setup recorded; `...-before-undo` copies are always kept for you to check.

## The background service (only with `monomem service install`)

| OS | Writes | Remove |
|---|---|---|
| Windows | Task Scheduler task `Monomem` (at sign-in, restarted if it stops) and `<data folder>/monomem-task.xml` | `monomem service uninstall`, or `uninstall --purge` |
| macOS | `~/Library/LaunchAgents/io.monomem.server.plist` (RunAtLoad, KeepAlive) | `monomem service uninstall`, or `uninstall --purge` |
| Linux | `~/.config/systemd/user/monomem.service` (Restart=always) | `monomem service uninstall`, or `uninstall --purge` |

`uninstall --purge` finds the service and removes it (through `monomem service uninstall`) before it deletes any data:
left behind, it would start the server again at the next sign-in and make a new data folder and token. If that removal
fails, nothing is deleted and the command to run is printed. Plain `uninstall` lists the service and the command, and
leaves it running. On Windows the task is found by its `monomem-task.xml` in the data folder.

## Written only where you point it

| Command | Writes |
|---|---|
| `setup --project` | `./.mcp.json` |
| `commit-trail on` (1.6.0, asks first) | `.git/hooks/prepare-commit-msg` in that repository, which adds a `Monomem-Notes: #12 #40` line to commit messages. Not written when the repository uses a hook manager (`core.hooksPath`). `monomem commit-trail off` removes it (only Monomem's own hook) |
| `export --format md --dir <d>` / `export --format json --out <f>` | that folder / file |
| `backup [--out <d>]` | `<d>`, default `~/monomem-backup-<time>`, or next to the data folder when `MONOMEM_HOME` is set (never the current folder: a backup and its key must not land in a repo) |
| `uninstall --purge` | the final backup, `~/monomem-final-backup-<time>` (unless `--no-backup`) |
| `sync --git <repo>` | `<repo>/monomem/` or `<repo>/monomem-enc/`, and git commits in that repo |
| `sync setup <folder>` / `sync` | `<folder>/monomem-enc/` (sealed note files `*.enc` and this computer's sealed name `*.mach`) |
| `npm run runner` (a Monomem checkout only, not in the npm package) | `<checkout>/data/runner.lock`, `runner-seen.json` |

## Network calls and AI cost

**By default Monomem makes no outbound connection and no AI-model call.** It listens on `127.0.0.1` only
(`MONOMEM_BIND` changes that). Every outbound call in the code is listed here, each off until you set it; the test
`test/network-allowlist.test.ts` fails if a new one is added without updating this table.

| Call | Off until | Goes to |
|---|---|---|
| Embeddings (`src/embeddings.ts`) | `MONOMEM_EMBEDDINGS=on` or `auto` | `MONOMEM_EMBED_URL` (default `localhost:11434`); a non-local host prints a warning once |
| Session summary by a local model (`src/llm.ts`) | `MONOMEM_LLM_URL` and `MONOMEM_LLM_MODEL` | a loopback address only, unless `MONOMEM_LLM_ALLOW_REMOTE=1`; redirects refused |
| Capture hook posting to a server (`src/hook.ts`) | `MONOMEM_HOOK_URL` and `MONOMEM_HOOK_TOKEN` | your own Monomem server |
| Runner `--post` (`src/runner-sign.ts`) | `MONOMEM_URL` and `MONOMEM_TOKEN` | your own Monomem server |
| Dashboard page (`src/ui/js-core.ts`, served by `src/dashboard.ts`) | opening the dashboard | the Monomem server that served the page (API calls, and the one-time sign-in code that `monomem open` hands over). Its Settings "Check for updates" and "Update now" buttons run `monomem update` only when pressed |
| `monomem stop` (`src/cli/stop.ts`) | running the command | `http://127.0.0.1:<port>/health` on the port `monomem open` recorded, to be sure it is still your server before stopping it |
| Dashboard Update (`src/ui/js-settings.ts`, `src/update.ts`) | pressing "Update now" | the server that served the page (`/health`), and after the swap `http://127.0.0.1:<api port>/health`, to see the new version is up |
| `monomem open` (`src/cli/connect.ts`) | running the command | `http://127.0.0.1:<api port>/health`, to see whether your own server is up |
| `monomem backup restore` (`src/cli.ts`) | running the command | `http://127.0.0.1:<api port>/health`, only to print a hint when something answers there (whether the database is in use is judged by its lock) |
| `monomem setup` (`src/embeddings-offer.ts`) | running the command (not `--no-embeddings`, `--undo`, or with `MONOMEM_EMBEDDINGS` / `MONOMEM_EMBED_URL` already set) | `http://127.0.0.1:11434/api/tags`, to see whether a local Ollama has `nomic-embed-text`; if so, new app entries get `MONOMEM_EMBEDDINGS=auto` (0.8 s timeout) |
| `monomem check --setup` (`src/doctor/server.ts`) | running the command | `http://127.0.0.1:<api port>/health`, to warn when the server running there is older than the CLI (`MONOMEM_NO_SERVER_PROBE=1` skips it) |
| Encrypted session start (`src/local-server.ts`, `src/recall.ts`) | the store is encrypted and a Monomem server for this store runs on this computer | that server on `127.0.0.1`: `GET /proof` (to check it holds the same main key; the key itself is never sent) and `POST /relevant` (to match note bodies; falls back to titles and tags if nothing answers) |
| `monomem update` (`src/update.ts`) | typing the command (never automatic, never in a hook) | `api.github.com` for the latest release of `calasdan-sketch/monomem`, then that release's archive for this platform and its `SHA256SUMS` (checked before anything is replaced); an npm install only prints the npm command and calls nothing |
| `monomem check --attacks --set poisonedrag-nq` (`src/attack-sets/index.ts`) | typing the command with that set name (the other sets ship with Monomem and call nothing) | `raw.githubusercontent.com` for one file of the PoisonedRAG repository at a pinned commit; its SHA-256 is checked before any of it is used, and nothing is written to disk |

Not Monomem's own calls: `npx monomem` downloads the package from npm, and `sync --git` runs `git`, which pushes where your
repository's remote points. `sync setup <git address>` runs `git clone` of that address once, then each `monomem sync` runs
`git fetch` / `git push` to it. With `sync setup --auto on` (off by default) the server runs `monomem sync` every 30 minutes
(`--every`), so those git calls then happen on a timer; a shared-folder sync makes no network call itself.

**What memory costs your agent.** Monomem itself spends no model tokens, but what it returns lands in your agent's context.
The SessionStart hook injects up to 1,500 tokens per session (`MONOMEM_RECALL_TOKENS`, of which the project profile is up to
300, `MONOMEM_PROFILE_TOKENS`; `MONOMEM_PROFILE=off`). Search results are whatever the agent asks for (`limit`). The
dashboard's **Usage** view shows the estimate (about 4 characters a token).

## Processes and loops

Nothing runs unless you start it (`start`, `mcp`, `watch`, the runner) or an app runs a hook. The session-end hook may
start one short detached child for the optional local-model summary; it makes one call with a timeout (at most 5
minutes) and exits. Every retry is bounded:

- **embeddings** (`MONOMEM_EMBEDDINGS=auto`): a failed call stops all calls for 60 s; each call has a timeout.
- **capture spool**: capped at 10 MB; an event that fails to store is retried by at most 5 drains, then dropped; a
  `.draining` file left by a killed hook is picked up by the next drain after 10 minutes.
- **local-model summary** (`MONOMEM_LLM_URL`): one call per session, timeout at most 5 minutes, no retry.
- **runner**: a note is marked seen before it is acted on, so a failing note is not retried; each poll reads at most 20
  pages and runs a capped number of commands.
- **watch**: gives up with an error after 10 failures in a row (a failed wait or a failing `--exec` handler).
- **device sync timer** (only after `sync setup --auto on`): one `monomem sync` child at a time; a tick is skipped while
  the last one runs, and each tick re-reads the setting, so `--auto off` stops it without a restart.
- **setup**: a busy file is retried for a few seconds, a file rewritten under it at most 5 times.
- **daily backup** (server only): one `VACUUM INTO` copy a day, checked hourly; a failure is recorded, not retried until the
  next hourly check. The copy runs on a worker thread (since 1.6.0), so serving does not pause for it; one at a time.
- **Claude Code memory refresh** (server only, off unless `MONOMEM_CLAUDE_REFRESH=on` or the Settings switch): every 10
  minutes it reads only Claude Code's memory files that changed; one run at a time, and the switch is read on every tick.
- **app check** (server only): two minutes after start, then hourly, at most one look a day for supported apps installed
  later (file reads only; it never changes an app's file). It runs on the server thread and reads a few dozen small files.

`monomem check --setup` reports the data folder size (warns over 1 GB), the spool size (warns when anything is waiting, and
when it is full) and the capture backlog: events no session summary has taken in yet (warns over 10,000).
