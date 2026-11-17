# Taint gate: ask before a risky action once a session read outside content (opt-in)

Text from outside (a web page, another MCP server's answer) can carry instructions written by someone else. The usual
payoff for such an instruction is an action: push code, publish a package, send your data to a server, or read a key.
The taint gate is a Claude Code hook that notices when the session has read outside content and then **asks you** before
those actions. You answer in Claude Code's normal permission prompt.

**It is a speed bump, not a sandbox.** Read "What it does not do" below before you rely on it.

## Turn it on and off

```
monomem setup --taint-gate            # shows the exact change to ~/.claude/settings.json and asks y/N
monomem setup --taint-gate --dry-run  # only shows it
monomem setup --undo                  # takes it out again (when it was the last setup change)
```

It adds one `PreToolUse` entry (matcher `Bash|PowerShell|Read|Grep|Write|Edit|MultiEdit|NotebookEdit|WebFetch`) that runs
`monomem hook taint-gate`. Plain `monomem setup` never adds it. `monomem uninstall` removes it with the other Monomem
hooks. Restart Claude Code after the change.

It needs Monomem's automatic memory hooks (`monomem setup --capture`): those are what record that a session read outside
content. Without them the gate never asks, and setup says so.

## When it asks

Only when **this session** read outside content (WebFetch, WebSearch, or an MCP server other than Monomem, within
`MONOMEM_TAINT_WINDOW_HOURS`, default 12; `MONOMEM_LOCAL_MCP_SERVERS` names servers that do not count), and only before:

| Action | Seen as |
|---|---|
| Push code | `git push` in a shell command |
| Publish a package | `npm publish`, `pnpm publish`, `yarn publish` / `yarn npm publish` |
| A web request to a host not on your known-hosts list | `curl`, `wget`, `Invoke-WebRequest` / `Invoke-RestMethod` (`iwr`, `irm`), `fetch(` in a command, and the WebFetch tool. A command whose destination cannot be read (`curl $URL`) is asked about too |
| Credential files | reading or writing `.env` (not `.env.example`), anything in `.ssh`, `.gnupg`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, `id_rsa`-style keys, `credentials.json`, through Read, Grep, Write, Edit or a shell command |
| Instruction and settings files | writing `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/settings.json` (which could remove this gate) or Monomem's `known-hosts.json` |

The prompt says what it saw, for example: *"Monomem: this session read outside content (WebFetch) 4 min ago, and now
wants to push code (git push). Text from outside can carry hidden instructions: allow this only if you asked for it."*

It never denies and never approves on its own. Every other tool call gets no answer from it, so your own permission rules
apply as before. In a `-p` (non-interactive) run where nobody can answer, Claude Code treats the ask the way it treats any
unanswerable prompt.

## Known hosts

One list of hosts you expect data to go to. Requests to them (and their subdomains: `api.github.com` is under
`github.com`) are not asked about. `localhost` also covers `127.0.0.1` and `::1`.

```
monomem settings known-hosts                  # show the list (default: github.com, registry.npmjs.org, localhost)
monomem settings known-hosts add example.com  # a person at a terminal types yes: it loosens the gate
monomem settings known-hosts remove github.com
```

It is stored in `<data folder>/known-hosts.json` (see [footprint.md](./footprint.md)).

## Rules-file notice (AGENTS.md / CLAUDE.md)

Agents follow `AGENTS.md` and `CLAUDE.md` as instructions, so a line planted there works on every later session. With the
automatic memory hooks on, session start adds **one line** when either file in the session folder changed since the last
session Monomem saw there, and says whether the Monomem block (the part `monomem project-rules` writes) changed too.
It names the file, never prints its text, and never edits it. Monomem's own `project-rules` write is not reported. The
first session in a folder only records the files. Hashes are kept in the `rules_file_watch` table of the database.

## What it does not do

- **It matches command text.** An alias, a script file, a base64 string, `ssh`, `scp`, `nc`, a package manager's
  `postinstall` or any tool not in the table goes by without a question.
- **It sees outside reads only through Monomem's capture hooks.** A `curl` in the shell, a downloaded file opened with
  Read, or a host without hooks is not counted as outside content. The capture of a WebFetch runs in the background, so an
  action in the same instant can come before the read is recorded.
- **It does not know about unconfirmed notes Monomem served** over MCP in this session (that signal lives in the MCP
  server's process); only the session's own outside reads count.
- **Claude Code only.** Other apps have no `PreToolUse` "ask" that Monomem wires.
- It looks at the session folder's `AGENTS.md` / `CLAUDE.md` only, not parent folders or the git root.

## Cost

The gate decides from the tool call alone first; it opens the database (read-only, 150 ms lock wait) only for an action in
the table. Its own work is a few milliseconds plus about 12 ms to load (measured on Windows, Node 24). Each call still pays
Node's start and the `monomem` command's start, like every Monomem hook (about 120 ms in total on that machine, where a bare
`node` takes about 75 ms). On any problem it prints nothing and the call goes ahead as if it were not installed.
