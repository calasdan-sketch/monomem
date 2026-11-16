# Plain-file sync (Markdown)

## Use Monomem on your other computers (the easy way)

You need one of these, and nothing else:

- a **shared folder** that your computers already keep in step: OneDrive, Dropbox, iCloud Drive, Google Drive, a network share
  or a USB disk; or
- a **private git repository** you own (GitHub, GitLab, your own server).

There is no Monomem server and no account. Every file Monomem puts there is sealed (encrypted), so the folder or repository
holds no readable note, title or computer name.

**On your first computer**

1. Run `monomem sync setup "C:\Users\you\OneDrive\Monomem"` (a folder), or
   `monomem sync setup git@github.com:you/my-private-memory.git` (a private repository; git must be installed and able to sign
   in to it). Add `--name "Work laptop"` to choose how this computer is named on the others (the default is a neutral
   `computer-1a2b`, not your computer's name).
2. Setup syncs once and prints where your **sync key** is: `.sync-key` in your Monomem data folder.
3. Copy that key file to your other computer with a USB stick or your password manager. **Never put it in the shared folder or
   the repository**: anyone with the key and the folder can read your notes.

**On each other computer**

1. Install Monomem and put the copied `.sync-key` in its data folder (`monomem doctor` shows where that is).
2. Run the same `monomem sync setup ...` with the same folder (as that computer sees it) or the same address.

**After that**

- Run `monomem sync` when you switch computers, or let it run by itself: `monomem sync setup --auto on` (every 30 minutes while
  Monomem's server is running; `--every 10` for another interval; restart Monomem once after turning it on). `--auto off` turns
  it off. It is **off by default**.
- `monomem show <id>` and `monomem why <id>` say which computer a note came from ("from computer: Work laptop"). Your AI
  tools see it too: session start adds "(from computer: Work laptop)" to that note's line, and MCP reads carry
  `from_computer`. A note written on this computer has neither.

**What is never synced:** your sync key, your at-rest encryption key, app keys (`tokens.json`), the database itself, settings,
backups and logs. Only note files (sealed) and each computer's chosen name (sealed) travel. Notes above
`MONOMEM_EXPORT_MAX_SENSITIVITY` stay home; without it, notes labelled private do travel (sealed), and sync warns you.

**What happens when ...**

- **you forget (archive) a note on one computer:** it is archived on the others too at their next sync. It is kept, never deleted,
  and `monomem restore <id>` brings it back. Restoring it on the computer that archived it brings it back everywhere.
- **you delete a note:** the others archive their copy (a delete never deletes anything on another computer).
- **one computer archived a note that another had just edited:** the edit wins; the note comes back on both, and sync says so.
- **the same note was edited on two computers:** the newer text is live and the other text is **held** for you
  (`monomem review`): approve it to use it instead. Nothing is overwritten unseen; a copy is also kept in
  `<data folder>/sync-conflicts/`.
- **the folder's sync tool made a conflict copy** (`... (conflicted copy).enc`, `...-PCNAME.enc`): Monomem skips it and names it;
  nothing in it is read. The real file wins at the next sync.
- **a computer has no key yet:** sync stops and tells it to copy the key; nothing changes.

**Privacy notes.** A forgotten note's sealed text stays in the folder or repository (and in git history), marked archived, so
the other computers learn about the forget. A git repository is reached over the network at each sync (`git fetch`/`git push`
to the address you gave); a shared folder is only read and written locally. Do not run two syncs at once on one computer.

The rest of this page is the manual way and the details.

## Plain files by hand

Your memory as a folder of Markdown files you can read, grep, edit in any
editor, diff in git, and sync with anything that syncs files.

```bash
monomem export --format md --dir ~/memory     # store -> files
monomem import --dir ~/memory --dry-run       # what would merge back?
monomem import --dir ~/memory                 # files -> store
```

## Layout

```
~/memory/
  work/
    release-cadence--b48d83f6-12.md
  home/
    dentist--b48d83f6-3.md
  .conflicts/            # only after a conflict; never imported
```

One file per note, in a folder per namespace (unsafe characters become
`_`, Windows-reserved names such as `CON`/`NUL`/`COM1` get a `_` prefix,
trailing dots are dropped, at most 64 chars; the folder is cosmetic, the
front-matter `namespace` is authoritative). The filename is
`<title-slug>--<origin store, 8 hex>-<id>.md`; the slug keeps Unicode
letters (Greek, CJK titles stay readable) and is shortened so the full path
stays under Windows' 260-char limit.

```markdown
---
id: 12
origin: "b48d83f6-2fdc-4df8-899b-98d7bc60bdc5"
namespace: "work"
title: "Release cadence"
tags: ["decision"]
source: "claude-code"
origin_writer: "claude-code-token"
created_at: "2026-10-14T09:00:00.000Z"
updated_at: "2026-10-15T10:30:00.000Z"
rev: 3
hash: "9b1f0c2a7d3e4f51"
---
Ship weekly on Thursdays.
```

`origin_writer` is who wrote the note on the exporting store (its writer id when known). It is
shown for information only: a file is stamped with whoever imports it, and the value arrives as the
unverified `imported_written_by`; it never counts for distrust rules or `written_by` filters. Files are not signed.

A note you pinned (`monomem pin`) is exported with `pinned: true`, and import pins it on the other store, so agents
there cannot change it either. A pin only adds protection: a file without the line never unpins a note, and a file
never pins a note from outside content that nobody has confirmed (pinning counts as your confirm; a file is not you).
Pin it by hand there after you check it.

Values are JSON-encoded, which is valid YAML. The body is stored verbatim
(one trailing newline is added on export and removed on import; files are
LF-only and CR/CRLF in a body counts as the same content, so a round trip
never bumps `rev`). `hash` is the content hash at export.

**Deterministic:** fixed key order, notes in id order, LF endings, and a file
is only rewritten when its bytes change — re-exporting an unchanged store
produces no diff. `--namespace ns` exports one namespace.

**Export never clobbers an unimported edit.** If a file was changed since
this store last synced it (by you, or another machine's export), export
skips it and reports it: run import first. The `force` option (API:
`exportMarkdown(store, dir, { force: true })`) overwrites anyway after
copying the file to `.conflicts/<name>.overwritten.md`. One file that cannot
be written (bad path, permissions) is reported and the rest still export.

Export **prunes** only stale copies it can account for: the old file of a
note this store renamed, and the earlier file of a note now hidden (a distrusted writer, or above the export ceiling) — and
only while the file still holds what was last synced. Another machine's file
this store never imported is never pruned, nor are files without Monomem
front-matter. `--no-prune` keeps everything.

**Tombstones (archived and deleted notes).** A note this store archived (forgot) after it was synced keeps its file, with the
body unchanged and two extra lines at the end of the front-matter:

```
archived_at: "2026-11-16T09:00:00.000Z"
archived_by: "b48d83f6-2fdc-4df8-899b-98d7bc60bdc5"
```

`archived_by` is the store that archived it. The content hash does not cover these lines, so an older Monomem (1.5) sees no
edit and never blanks or deletes its copy; it ignores the lines. A deleted note's file gets the same two lines instead of being
removed (removing it made the other computer write it back on every sync, forever). An archived note that was never synced stays
out of the folder. A newer Monomem importing a marked file archives its live copy (never deletes it), unless the note was edited
here since (the edit wins and travels back, and the other computer restores it), it is pinned here, or its namespace needs
approval here: then it stays live and the report says why (`monomem forget <id>` to match). Each marker is acted on once
(`_meta.sync_marks`), so restoring the note here is not undone by the next sync. When the marker goes away (the computer that
archived the note restored it), the note is restored here too.

With an older (1.5) computer in the mix, the older one rewrites a marked file without the marker and the newer one adds it
back: one commit per sync for each archived note, until both are upgraded. No note is lost either way.

**Deleting an imported note is remembered.** When you delete a note that
came from another machine, the store keeps its sync identity and merge base
(table `sync_deleted`), so the next import treats the file as deleted here
(`skipped`) instead of creating the note again; only a file edited since
brings it back (`restored`). Its file gets the archive marker (above), so the other machine archives its copy.

**Symlinks:** every write, prune and `.conflicts/` copy checks each path
segment under the sync folder with `lstat` and refuses symlinks, and right
before each write, rename or delete re-checks that the real (resolved)
directory is still inside the sync folder. Writes go through an
owner-only (0600) temp file opened with `O_EXCL`/`O_NOFOLLOW` + rename, so
a planted `work -> ~/.ssh` link cannot redirect a write.

## Writing new notes as files

Drop any `.md` file into the folder. Front-matter is optional: without
`title`, a leading `# Heading` (or the filename) becomes the title; without
`namespace`, the folder name (or `default`). Plain YAML (`title: My note`,
`tags: [a, b]`, block lists) is accepted. After the import creates the note,
the file is rewritten with full front-matter so the next import updates it
instead of creating it again.

A file may only claim a note of **this** store (`origin` = this store) if
this store exported or merged that note before; otherwise it is `rejected`,
so a dropped-in file cannot overwrite an arbitrary local note. A file that
would move a note to another namespace is `rejected` unless moves are
allowed (API: `importMarkdown(store, dir, { allowMove: true })`).

## How import merges

Import is three-way. The **base** is the content hash this store last
exported or merged for the note (kept per store in `sync_base`); for a note
this store never synced, the file's own `hash` is used.

| File vs base | Store vs base | Result |
|---|---|---|
| same | same | `unchanged` |
| changed | same | `updated` — file wins (compare-and-swap on the note's rev) |
| same | changed | `skipped` — store is newer; the next export refreshes the file |
| changed | changed, same content | `unchanged` |
| changed | changed, different | `conflict` — the **newer** side wins; the loser is written to `.conflicts/` and held as an edit of the note (`monomem review`: approve to use it) |

"Newer" compares the store's `updated_at` with the file's front-matter
`updated_at` (file mtime is ignored: sync tools rewrite it). An applied file edit keeps the file's `updated_at` (never earlier
than the note's own), so two computers agree on it and stop rewriting the file. A hand edit
that leaves `updated_at` alone therefore loses a conflict — its text is kept
in `.conflicts/`. Nothing is silently lost: a
conflict always leaves the losing version in `.conflicts/` and is listed in
the report. After a conflict is resolved it is not raised again.

Other outcomes: `created` (new file or another store's note), `restored`
(the note was deleted here but the file was edited afterwards — your own
note's file is rewritten with the restored note's new id so it is restored
once; another machine's note is re-linked to its origin; an unedited file of
a deleted note is `skipped`), `quarantined` / `rejected`
(every import write goes through the [memory linter](./memory-linter.md);
re-importing content that is already pending in quarantine reports it again
without queuing a duplicate).
**Import never deletes notes.** Deleting a file does not delete the note. A forget or a delete reaches the other stores as an
archive, through the marker above. Files under `.machines/` hold each computer's chosen name (one line); they are not notes.

`--json` prints the full per-file report.

## Several machines, one folder

Every store has a UUID (`_meta.store_uuid`). A note's identity is
`(origin store, id)`, so ids that collide between machines never get mixed
up: importing another store's file creates a local note and remembers the
mapping (`sync_map`), the next import updates that same note, and this
store's export writes it back under its **original** identity and filename.
Two machines exporting into one git repo converge on the same files.

### GitHub (private repo)

```bash
# once
mkdir ~/memory && cd ~/memory && git init && git remote add origin git@github.com:you/memory.git

# on each machine, e.g. from cron or a shell alias
cd ~/memory
git pull --rebase
monomem import --dir .          # merge others' edits in
monomem export --format md --dir .
git add -A && git commit -m "memory sync $(hostname) $(date -u +%FT%TZ)" && git push
```

Import before export, so your store absorbs remote edits before it rewrites
the files. Add `.conflicts/` to `.gitignore` if you would rather review
conflicts locally only. Use a **private** repository: notes are plaintext.

### Git, in one command (`sync --git`)

```bash
git clone git@github.com:you/my-private-memory.git ~/my-private-memory     # a PRIVATE repository you own
monomem sync --git ~/my-private-memory --dry-run      # look first: nothing is fetched, written or pushed
monomem sync --git ~/my-private-memory --encrypt      # fetch, merge, write back, commit, push
```

There is no Monomem server in this: it is the export/import above with git carrying the files. Each run fetches, merges what
your other computers pushed (git's own merge first; if git cannot, it stops and leaves your memory untouched), merges the files into
the local database with the same three-way rules as `import --dir`, writes the result back, commits and pushes. Only the
`monomem/` folder (or `monomem-enc/` with `--encrypt`) of the repository is ever committed; other files in the repository are
not touched. A push that loses a race with another computer is retried once after merging again. `--no-push` commits locally only.

- **Readable or sealed.** Without `--encrypt` the repository holds your notes as readable Markdown (the command asks you to confirm the
  repository is private; from a script pass `--yes`). With `--encrypt` every file is sealed with AES-256-GCM (the same primitives as
  [at-rest encryption](./encryption-retention.md)) before it is committed: the repository holds only opaque file names and ciphertext,
  not even titles. File names are a keyed hash (HMAC-SHA-256 with the sync key) of the note's path, so a name cannot be matched to a guessed note title without the key; the number of notes, their approximate sizes and when they change are still visible. (Files sealed by an unreleased OneMemory 1.7.0 build used an unkeyed hash and are not readable by later builds: seal them again from a plain vault.) The sealed text is kept byte-for-byte when a note did not change, so git history stays small.
- **The key stays out of the repository.** It is a 32-byte file on your computers: your at-rest key if you use one, otherwise
  `<data folder>/.sync-key`, created on the first `--encrypt` run (or `--key-file`, or `MONOMEM_SYNC_KEY_FILE`). A key file inside
  the repository is refused. **Copy the key to your other computers yourself, never through the repository.** A computer without the
  key is told so and does not invent a new one over sealed notes; the wrong key stops everything before the database is changed.
  Lose the key and the sealed copies cannot be read: keep a copy of it somewhere safe, apart from the repository.
- **No rolling back (1.5.0).** Each sealed file carries a version number inside the encryption, and each computer remembers the
  highest version it synced per file (`<data folder>/sync-git-seen-<id>.json`). If the repository serves an older sealed file than
  one this computer already synced (someone with access to the remote replayed or rewound its history), the sync stops and changes
  nothing. If you reset the repository on purpose, delete that file and sync again. A computer that has never synced a file cannot
  tell its first copy is old: this protects computers that were already in sync, not a brand-new one.
- **Remote addresses.** Sync refuses a remote whose address has a password or token inside it (`https://user:pass@host/...`), because git saves that in `.git/config` in plain text; use a credential helper or an SSH key. Any address in text sync prints has its `user:pass@` part replaced by `***`.
- **Two computers settle.** A note that came from another computer keeps the writer name its file came with (`origin_writer`), so once both computers agree, a sync commits nothing.
- **While it runs**, the readable notes of a sealed sync exist only in a temporary folder inside the data folder, removed afterwards.
- **Conflicts.** A note edited on two computers keeps the newer version live, holds the other as an edit for you to pick
  (`monomem review`), and saves a copy (under `<data folder>/sync-conflicts/` for a sealed sync, `.conflicts/` otherwise); nothing is
  lost silently.
- **Forgets and deletes arrive as archives** (see Tombstones above): the other computers archive their copy, keep the text, and stop
  committing. A deleted note does not come back on the computer that deleted it.
- **Computer names** travel sealed as `<keyed hash>.mach` files next to the `.enc` notes (older versions ignore them). A sealed file
  whose name is not one Monomem writes (a sync tool's conflict copy) is skipped and named, never read.
- **Encrypted database, plain sync:** at-rest encryption covers the database only. `sync --git` without `--encrypt` writes readable
  files, and says so when your database is encrypted. `monomem sync setup` always seals.
- Do not run two syncs at once on the same repository.

### Syncthing / Dropbox / iCloud

Point the sync tool at the folder and run the same two commands on each
machine (import, then export) on a timer. The sync tool's own conflict
copies (`*.sync-conflict-*.md`, Dropbox "conflicted copy") carry the same
note identity as the original, so import **skips** them and reports them —
merge them by hand.

## Limits

- Not a live sync: run the commands (or a timer). The CLI uses full local
  trust and ignores server-side namespace resolution, like the other
  maintenance commands.
- Conflicts are whole-note, not line-level merges.
- Deletes travel only as archives (see Tombstones); nothing is ever deleted on another computer.
- `monomem sync setup` uses its own key (`.sync-key`), never your at-rest key, so copying it does not expose your database.

**Tasks and handoffs.** Import is a local admin command (no token can reach it), so
notes carrying the reserved `task` / `handoff` / `task.*` tags are restored as
written: an export/import round trip keeps your tasks, handoffs and any older notes
you tagged `task`. The `task.approval:` tag is never imported (approvals are bound
to the store's own key). If any file is `rejected`, the command prints a loud count
on stderr and exits with status 1.

**Distrusted writers.** An export leaves out notes touched by a writer on the distrust list
([trust.md](./trust.md)) and removes their earlier files (pruning is the default; `--no-prune` keeps them), so a vault synced to another
machine or an editor plugin does not carry the content an agent is told not to trust. `--include-distrusted`
writes them anyway, with `distrusted: true` in the front matter. A file's `origin_writer` is a claim, not a
proof; on import it is recorded as `imported_written_by` and added to the note's taint set, so a distrust
rule on that name hides the imported note. A file that omits `origin_writer` carries no taint.
