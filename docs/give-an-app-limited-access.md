# Give an app limited access

You can let an app use your memory without letting it see everything. Each app gets its own key,
and each key has a limit on which notes it can see: `public`, `internal` or `private`.

## The one command

```
monomem token add cursor --max internal
```

This prints a key (once), a block to paste into the app, and one sentence saying what the app can
and cannot see. The running server notices the new key within a couple of seconds, with no restart.

| Option | What it does |
|---|---|
| `--max public` / `internal` / `private` | the most sensitive notes the app can see. If you leave it out you get `internal`, and Monomem says so |
| `--scope read` or `write` | read only, or read and write (the default) |
| `--namespace work` | the app lives in one space only and cannot see other spaces |
| `--admin` | lets the app change and delete anything it can see. Only for apps you fully trust |

See the apps and their limits (keys are never shown): `monomem token list`

Take access away: `monomem token remove cursor`. It stops working within a couple of seconds.

## Which apps this works for

A limit belongs to a key, and keys only exist on the **HTTP** connection. An app wired the default
way (`monomem setup`, which runs `monomem mcp` over stdio) has no key, so it can read everything.
To keep an app away from private notes, connect it over HTTP with its own key, as printed by
`monomem token add`. `monomem connect <app> --restricted` does this wiring for the apps it knows.

If an app can only use stdio, set `MONOMEM_STDIO_MAX_SENSITIVITY` in its `env` block. Treat that as
a safety net for well-behaved apps, not a lock.

## Try it

1. Start the server: `monomem start`
2. Ask who the key belongs to:
   - Mac / Linux: `curl -H "Authorization: Bearer YOUR_KEY" http://127.0.0.1:8790/whoami`
   - Windows PowerShell: `Invoke-RestMethod -Headers @{ Authorization = "Bearer YOUR_KEY" } http://127.0.0.1:8790/whoami`
3. The answer says the app's name, what it can do, and what it can see.

## Where keys are kept

In `tokens.json` inside your Monomem data folder (`monomem doctor` shows where). The file is private
to your user (mode 0600) and is written safely: a half-written file is never used, and the previous
copy is kept as `tokens.json.bak` (removing an app deletes that copy, so the removed key is not left behind).
**Keys are stored in plain text**, so keep that file out of cloud folders and repositories. Hashing the keys is on the
roadmap.

## Taking access away: how fast, and one catch

A running server re-reads `tokens.json` every 2 seconds, so a removed app stops working within about 3 seconds, with no
restart (the server that made the change applies it immediately). If the file cannot be read (for example you
edited it by hand and left a typo), the server **keeps the old list** rather than locking everyone out or letting
someone in, and says so in its log. A removal made by hand in a broken file therefore does not take effect until the
file is valid again. `monomem doctor` reports an unreadable `tokens.json`.

## A key with no limit

`monomem token add <name> --no-limit` (or the dashboard's "NO LIMIT: full trust" choice) makes a key that can read every
private note and change any label. It is only offered to someone who already has no limit, it asks for confirmation in the
dashboard, and it prints a warning. Most apps should keep the default (`internal`).

More: [sensitivity-labels.md](./sensitivity-labels.md), [token-namespaces.md](./token-namespaces.md).
