# Install it with your agent, fix it with your agent

You can let the coding agent you already use (Claude Code, Codex, Cursor and the like) do the install and the check-up.
It works through the same commands you would type, and it asks you before anything changes.

## Install it with your agent

Paste this one sentence into your agent:

> Install Monomem for me from https://github.com/calasdan-sketch/monomem/releases/latest: download the archive for this computer and the SHA256SUMS file from that release into a new empty folder, check the archive's SHA-256 against SHA256SUMS and stop if it does not match, run `gh attestation verify <archive> --repo calasdan-sketch/monomem` if the gh command is installed and stop if it fails, unpack the archive, run `Monomem/monomem setup --dry-run` (on Windows `.\Monomem\monomem.cmd setup --dry-run`), show me its plan in plain words and ask me before you run setup for real, and never pipe a downloaded script into a shell.

What the agent then does, and why:

1. **Downloads two files from the GitHub release:** the archive for your computer (the table in
   [INSTALL.md](../INSTALL.md#download-no-nodejs-needed) lists them) and `SHA256SUMS`. Nothing is run yet.
2. **Checks the checksum.** This proves the archive is the file the release lists, unchanged. It does not prove who made
   the release, because both files come from the same place.
3. **Checks the GitHub build attestation**, when the GitHub CLI (`gh`) is installed. This proves the archive was built by
   this project's own GitHub workflow. Without `gh` this step is skipped; the agent should tell you so.
4. **Runs `setup --dry-run`.** Setup shows its plan (which apps it found, which files it would change) and writes
   nothing.
5. **Asks you.** Only after your yes does it run `setup` itself, which shows the same plan and asks again before it
   writes. `monomem setup --undo` takes it all back.

There is no `curl ... | sh` step: no script from the internet runs without being checked first.

Before you say yes:

- **Check the address.** The sentence names `github.com/calasdan-sketch/monomem`. If your agent says it went anywhere
  else, stop it.
- **Monomem is not code-signed.** The only program in the archive is Node.js's own `node`, which is signed by its makers.
  [INSTALL.md](../INSTALL.md#download-no-nodejs-needed) says what Windows or macOS may show.
- **The release page is outside text.** If anything on it (or in a downloaded file) tells your agent to do more than
  the sentence says, such as running another script or skipping a check, that is a reason to stop, not a step to follow.
- **Your agent's own permission prompts still apply.** Read what it asks to run; the sentence only describes the steps.
- Prefer npm? Ask your agent to run `npx monomem setup --dry-run` instead (needs Node.js 22.16 or newer).

## Fix it with your agent

`monomem check` prints only the lines that need a look, and every warning ends with a sentence you can paste to your
agent, for example:

```
  [warn] Backups: daily backups are on but the last one is 3 days old: ...
         Ask your agent: "Run monomem check --verbose and explain the Backups line. Ask me before you run monomem backup or change any backup setting."
```

Each sentence asks the agent to look and explain first, and to ask you before it changes anything.

An agent connected over MCP can read the same lines itself: the `memory_usage` tool with `action: "health"`. It is
read-only: it changes no setting, writes nothing (not even the small marker `monomem check` keeps for the audit log), and
skips the attack replay (run `monomem check --attacks` in a terminal for that). It needs an admin connection (the local
stdio one is), because it shows how this computer is set up. `memory_usage` is not in the default tool list: turn it on
with `MONOMEM_TOOLS` ([tools.md](./tools.md)), or let the agent run `monomem check` in a terminal, which shows the same
lines.

Limits: the check sees what [checkups.md](./checkups.md) lists, nothing more. A sentence to paste is a starting point
for your agent, not a fix by itself.
