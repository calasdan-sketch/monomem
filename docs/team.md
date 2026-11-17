# Shared memory for a team

One Monomem server, one token per person, and every note says who wrote it. This page is the short recipe. Each
step links to the page that has the detail.

What you get: a teammate's agent can read what the team has written down, you can see which person's assistant wrote
each note, and a write that looks like a planted instruction waits for a human instead of reaching everyone's agents.
What you do not get: Monomem has no user accounts, no sign-in page and no per-note permissions. A token is a password
that belongs to one person, and the namespace it is pinned to is the only fence.

## 1. Run it in HTTP mode, behind something that checks who is calling

```bash
export MONOMEM_TOKEN=$(openssl rand -hex 32)   # the main app key (admin), yours
export MONOMEM_BIND=0.0.0.0                    # only if the server must listen beyond this machine
monomem start                                  # dashboard + REST on :8790, MCP over HTTP on :8791 (/mcp)
```

On Windows PowerShell:

```powershell
$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$env:MONOMEM_TOKEN = -join ($b | ForEach-Object { '{0:x2}' -f $_ })   # the main app key (admin), yours
$env:MONOMEM_BIND = "0.0.0.0"     # only if the server must listen beyond this machine
monomem start
```

(That draws from the operating system's cryptographic random generator. `openssl rand -hex 32` does the same if you have it.)

By default the server listens on `127.0.0.1` only. It refuses to bind to anything else unless `MONOMEM_TOKEN` is set.
Do not put the plain port on the internet. Put an authenticated tunnel or a TLS proxy in front of it; the three checks
and the Cloudflare Access setup are in [INFRA.md](../INFRA.md).

## 2. One token per person

Give each person their own token, so the writer name on a note is that person. The easy way is to let Monomem make it:

```bash
monomem keys add --label alice --scope write --namespace team
```

It makes a strong random token, adds it to `~/.monomem/tokens.json` (the folder `monomem check --setup` reports) and shows the token once. It has to be run by a
person in a terminal (it asks you to type `yes`), so an agent running commands without a terminal cannot add one; anyone
who can edit `tokens.json` directly still can. The server reads the file once at startup, so a new token works, and a
removed one stops working, only after a restart. Repeat for `bob`, and for a read-only
person use `--scope read`. `monomem keys list` (formerly `monomem token list`) shows labels and scopes, never the tokens. If you run in Docker, set `MONOMEM_TOKENS` instead.

The alternative is to write the file yourself. It looks like this:

```json
[
  { "token": "<64 random hex characters>", "scope": "write", "label": "alice", "namespace": "team" },
  { "token": "<another one>",              "scope": "write", "label": "bob",   "namespace": "team" },
  { "token": "<another one>",              "scope": "read",  "label": "intern", "namespace": "team" }
]
```

Make each token with `openssl rand -hex 32` (in PowerShell, the one-liner above, run once per token); Monomem ignores tokens shorter than 32 characters.
The server reads this file once at startup, so restart it after a change. Each person then points their assistant at
`https://<your host>/mcp` and sends their token as `Authorization: Bearer <token>`. Copy-paste commands for Claude Code, Cursor and Codex are in
[INSTALL.md](../INSTALL.md#connect-to-a-shared-server-a-teammates-setup); n8n and other HTTP callers are in [INFRA.md](../INFRA.md).

`read` can only read, `write` can read and write, `admin` can also approve held writes and change policy. The
label becomes the note's `written_by`. The server stamps it from the token, so a caller with your token is you and a request body cannot
change it ([docs/provenance.md](./provenance.md)).

## 3. Namespaces: who sees what

A token with a `namespace` is confined to it: it writes there, reads there, and cannot see or touch another
namespace (a miss looks like "not found", not "forbidden"). Give everyone the same `team` namespace to share
notes, and add a personal namespace per person for what should stay private. Letting one namespace read another is
set by you in the operator's spaces file, never by a token. All of it: [docs/token-namespaces.md](./token-namespaces.md).

Keep one admin key that is not pinned (the main app key, `MONOMEM_TOKEN`). It sees every namespace and is the one you
use for review.

## 4. Approve-first for the shared namespace

For a namespace everyone reads, make every agent write wait for a person:

```bash
monomem approve-first team on     # agent writes to "team" now wait for approval
monomem approve-first             # list the namespaces that have it on
```

Held writes show in the dashboard's **Held** tab (admin key) and in `monomem review held list`; approve or reject each
one. This is on top of the linter, which holds writes that look like secrets or injected instructions even without
approve-first. The linter is pattern matching and misses things, so approve-first is the stronger setting. Notes
you write yourself with the `monomem` command are not held. See [docs/memory-linter.md](./memory-linter.md).

If one person's agent starts writing things the team should not trust, an admin can stop their notes reaching
anyone's session: `monomem trust distrust alice --namespace team` ([docs/trust.md](./trust.md)).

## 5. Keeping copies

**Backups of the server.** `monomem backup --out ~/monomem-backup` (in PowerShell: `monomem backup --out $HOME\monomem-backup`) makes a consistent copy while the server runs. If you
turned on encryption at rest, keep the key file apart from the backup. Detail: [INFRA.md](../INFRA.md#7-backups).

**Without a server at all.** If your team is small and trusts a private git repository, each person can keep their
own local store and run `monomem sync --git <repo-folder> --encrypt` to merge through that repository. Nobody needs a
shared server for this, and it is not the same thing as steps 1 to 4: each computer has its own copy, there are no
approve-first holds across computers, and deleting a note does not remove it from the other computers. See
[docs/file-sync.md](./file-sync.md#git-in-one-command-sync---git).

## When teammates' notes disagree

Two people can save notes that state different values for the same thing ("deploy day is Friday" and "deploy day is Monday"). Run `monomem review conflicts` to list them. It only flags: it matches exact facts and keys, so a disagreement that is reworded is missed, and it never changes or removes a note. You decide which note is right, then replace or archive the other.

To make agents' decisions comparable, tell them to attach `facts` under a shared key. Reuse a key from the reply's `similar_keys` or this list: `deploy_target`, `package_manager`, `test_runner`, `database`, `node_version`, `base_url`, `ci_provider`, `formatter`. Prefix a subject only when the project has several (`api.deploy_target`). At the start of a session, a disputed key shows up as at most two short lines ("Monomem: writers disagree on deploy_target: 'render' (#1 stdio:claude) vs 'vercel' (#4 stdio:gemini). Check with the user.") with the note ids and writers, so the agent asks you before acting. This works without a configured namespace (every namespace is checked), hidden (never-show) notes and distrusted writers are left out, and a writer who simply changed their mind counts once. `monomem facts` lists every recorded fact and marks the disputed ones; in the dashboard, "Keep a fact" removes just the disputed fact from the other note (it gets a `fact-removed:<key>` tag, since its text may still mention the old value), or `monomem fact remove <id> <key>` does the same from a terminal.

## A short checklist

- [ ] Server is behind a tunnel or proxy that checks who is calling, and `MONOMEM_TOKEN` is set.
- [ ] One token per person, each with a `label` and a `namespace`.
- [ ] `approve-first` is on for the shared namespace, and someone owns the Held tab.
- [ ] A backup runs on a schedule, and the encryption key (if any) is stored apart from it.
