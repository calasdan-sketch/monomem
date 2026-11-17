# Where your data lives, and backups

## Where your data lives

Everything (the database, the main app key, other app keys, the spaces config) lives in `~/.monomem`
(Windows: `%USERPROFILE%\.monomem`). That is outside the program, so `npm update`, an npx cache cleanup or
`monomem update` never touches it. Set `MONOMEM_HOME` to put it somewhere else, or `MONOMEM_DB_PATH` for just the
database. On macOS and Linux the folder is owner-only (`0700`, files `0600`). A from-source git checkout that already
has `./data/state.db` keeps using it. `monomem check --setup` shows which folder is in use.

The program itself is a separate folder. With the download it is `%LOCALAPPDATA%\Programs\Monomem` on Windows,
`~/Applications/Monomem` on a Mac and `~/.local/share/monomem` on Linux; with npm it is wherever npm puts global
packages. Every file Monomem writes, and how to remove it: [footprint.md](./footprint.md). Upgrading or moving from
another tool: [upgrading.md](./upgrading.md), [switching.md](./switching.md).

## Automatic daily backups

While Monomem's server is running (`monomem start`, or "Start Monomem with my computer" in the dashboard's Settings),
it makes one backup a day in `<data folder>/backups`. It keeps the 7 newest days plus one backup from each of the 4
weeks before them, and deletes older ones. The encryption key is never copied into them. When the server is not
running, no daily backup is made: `monomem check` says how old your last backup is. Turn them off in the dashboard's
Settings, or with `MONOMEM_AUTO_BACKUP=off` ([configuration.md](./configuration.md)).

## Backing up by hand

```bash
monomem backup --out ~/om-backup     # a consistent copy; safe while the server runs
```

`monomem backup` writes `state.db` (through SQLite `VACUUM INTO`) and a `README.txt` that says what is and is not in
the folder. It leaves the keys out unless you ask:

- **The encryption key** (`.key`, only when at-rest encryption is on) is copied only with `--include-key`. **Keep the
  key apart from the backup**: a backup without its key cannot be read, and a backup stored next to its key is not
  protected at all. See [INFRA.md](../INFRA.md#7-backups) and [encryption-retention.md](./encryption-retention.md).
- **The command-task approval key** is copied only with `--include-approval-key`. Without it, command tasks that were
  approved before a restore have to be approved again.
- **The attestation signing key** (`.attest-key`) is copied only with `--include-attest-key`. Without it, a restored
  copy keeps its server id but makes a new signing key, so other servers that trusted the old key must be given the new
  one ([trust.md](./trust.md#setting-it-up-between-two-servers)).

To go back to a backup: `monomem backup restore <folder>` (formerly `monomem restore <folder>`, which still works). It
is a dry run until you add `--yes`, copies your current database aside first and prints the exact command to undo it.
Stop the server and close the apps that use Monomem before you restore.

## JSON export and import

The JSON route works too (it needs the main app key):

```bash
TOKEN=$(cat ~/.monomem/.token)
curl -H "Authorization: Bearer $TOKEN" localhost:8790/export > backup.json   # or: monomem export --format json --out backup.json
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @backup.json localhost:8790/import                           # main (admin) app key only
```

- **Import into an empty store.** `POST /import` does not remove duplicates: importing a backup into a store that
  already holds those notes creates a second copy of each.
- **Exports carry edit history.** Each note exports with its latest text *plus* the earlier versions an edit
  replaced (`history`), so an export grows with how often you rewrote a note, not only with how many notes you have.
  `?history=0` / `--no-history` leaves them out. **An export with history can hold text someone removed on purpose:
  treat it like the database** (see [SECURITY.md](../SECURITY.md)). The change feed's per-edit log is separate: it holds
  titles, never note text, is pruned after 90 days, and is never part of a JSON backup.
- **Exports stream.** `GET /export` and `monomem export --format json` page through the store and write as they go,
  so they use about one page (500 notes) of memory whatever the size of the store.
- **Imports keep the history that exists.** `created_at`, `updated_at`, `source` and the `rev` counter all survive the
  round trip (a note at rev 26 stays at rev 26, so `if_rev` checks and the change feed stay accurate). Imports of more
  than 200 notes finish in seconds and leave the similarity graph to be rebuilt later: the response says so, search
  works straight away, and `monomem tidy edges` brings neighbour ranking back. Imported notes are given meaning-search
  vectors again automatically when semantic search is on.
- Markdown (one file per note, git-friendly) is a separate path: `monomem export --format md --dir ~/memory`; see
  [file-sync.md](./file-sync.md).

## Docker

If you would rather run the server in Docker (for example on a machine that several people share):

```bash
git clone https://github.com/calasdan-sketch/monomem && cd monomem
cp .env.example .env     # set MONOMEM_TOKEN to a long random value (openssl rand -hex 32)
docker compose up -d     # dashboard at http://localhost:8790
```

[two-developers-one-server.md](./two-developers-one-server.md) walks through a shared server step by step.
