# Upgrading

## Monomem 1.3.0 (database schema v18 to v19)

Applies to Monomem 1.2.x. A fresh install needs none of this.

- **What changes.** The first start migrates the database from schema v18 to **v19**: a sensitivity label on notes (every existing note
  becomes `internal`), one column on the change log and one on held writes. No note text is rewritten, and nothing becomes hidden until
  you give an app key a limit (`monomem connect <app> --max internal`). What it means: [sensitivity-labels.md](./sensitivity-labels.md).
- **A verified backup is made first**, at `<database>.pre-v19-backup` (for example `state.db.pre-v19-backup`). The upgrade does not run
  if that copy cannot be made. It still holds every note as it was, deleted ones included, so remove it when you are happy:
  `monomem backup --prune-premigration`.
- **One way only.** Monomem 1.2.x and older, and OneMemory, refuse a v19 database instead of opening it and ignoring the labels. If
  several machines share one database, upgrade all of them.
- **To go back to 1.2.x:** close Claude Code, Claude Desktop and every other app that uses Monomem, and stop the server. Then, with the
  OLD or the new build: `monomem restore <database>.pre-v19-backup --yes`. It copies your current database aside first
  (`<database>.before-restore-<time>`), removes the stale `-wal`/`-shm` files and checks the result. Then install the older version
  (`npm i -g monomem@1.2.1`) and start it. Anything written after the upgrade is not in the backup; the copy-aside keeps it.
  Without the `restore` command (an old build): put the backup in place of `state.db` by hand and delete `state.db-wal` and `state.db-shm`.
- Afterwards run `monomem doctor`, then `monomem health`. What is new: [CHANGELOG.md](../CHANGELOG.md).

## Monomem 1.2.0 (database schema v16 to v18)

Applies to Monomem 1.1.x and OneMemory 2.x. A fresh install needs none of this.

- **What changes.** The first start migrates the database from schema v16 to **v18**: the read access log, flood-guard
  counts, pinned notes and per-writer history for rollback. No note text is rewritten. The search index is rebuilt once
  for prefix search (about half a second per 50,000 notes).
- **A verified backup is made first**, at `<database>.pre-v18-backup`. The upgrade does not run if that copy cannot be made.
- **One way only.** An older Monomem or OneMemory cannot open a v18 database. If several machines share one database, upgrade all of them.
- **To go back:** stop every Monomem process (server, MCP clients, runners, the CLI). Put `<database>.pre-v18-backup` back
  as the database and delete the `-wal` and `-shm` files beside it. Install the older version and start it. Anything written after the upgrade is not in the backup.
- Afterwards run `monomem doctor`, then `monomem health`. What is new: [CHANGELOG.md](../CHANGELOG.md).

## Older upgrade notes (OneMemory)

> Unless a version is called Monomem, it is a **OneMemory** version (1.x and 2.x): OneMemory was this project's earlier name, and Monomem restarted at 1.0.0 ([CHANGELOG.md](../CHANGELOG.md)). Schema numbers (v14, v15, v18) belong to the database and carry on across the rename.

> **OneMemory 1.6.0 from 1.4.x or 1.5.0 (historical)?** The first start migrates the database from schema v14 to **v15** (confidence and replace columns,
> and tables for history, one-time codes and the replace log). Nothing is rewritten: no note text is touched. A verified copy is made first at
> `<database>.pre-v15-backup`, and the upgrade does not run if that copy cannot be made. To go back: stop everything, put that copy back as the
> database, install the older version. What is new: [replacing-memories.md](./replacing-memories.md). The rest of this page was written for OneMemory 1.3.x to
> 1.4.x. The copy is always named after the schema it upgrades to: `pre-v15-backup` then, `pre-v18-backup` for a current build (which is what the steps below show).

> **Moving to the release with sensitivity labels?** The first start migrates the database from schema v18 to **v19**: one new column on notes
> (`sensitivity`, every existing note becomes `internal`), one on the change log and one on held writes. No note text is touched, and nothing
> becomes hidden until you give a token a `max_sensitivity` ceiling. A verified copy is made first at `<database>.pre-v19-backup` (same rules
> as below). Older Monomem builds refuse a v19 database rather than open it and ignore the labels. What is new:
> [sensitivity-labels.md](./sensitivity-labels.md).


This page is for an existing OneMemory 1.3.x install moving to OneMemory 1.4.x (1.4.2 is the last 1.4.x; 1.5.0 only adds the benchmark and needs no migration). Nothing here is
needed for a fresh install.

**EXPERIMENTAL since OneMemory 1.4.x:** signed attestations, cross-server writer ids, `trust rotate`,
`trust attester-revoke` and the `--any-server` flag. They may change in a minor release. The local
distrust list and writer labels are the stable part. See [trust.md](./trust.md).

## What happens when you start 1.4.x (OneMemory)

1. **The schema upgrade is one-way.** The first start on a database at schema v1 to v13 migrates it to v14
   (new columns, three small tables, an index over note writers). No note text is touched. An older
   version cannot open a v14 database.
2. **A backup is made first.** Before migrating, Monomem writes a verified copy to
   `<database>.pre-v19-backup` (it is built as `.partial`, then checked: it must hold the same number of notes
   as the database, have the old schema version and pass an integrity check; only then is it renamed). If a
   valid copy from an earlier attempt exists it is kept under a dated name and a fresh one is made; a copy
   that cannot be read (permissions) is never deleted, only moved aside. **The upgrade does not run when the
   copy cannot be made** (for example the disk has no room: free about the size of the database plus its
   WAL). It stops with an error and the database is untouched. To upgrade anyway, take your own
   `monomem backup` and set `MONOMEM_SKIP_PREMIGRATION_BACKUP=1` for that start; there is then no way
   back to the older version.
3. **Expect a delay on the first start** of a large database: building the index takes a few seconds per
   hundred thousand notes. In Docker or a service manager, give the health check a start period
   (the image uses `--start-period=60s`; use a longer one for a very large database) so the container is not reported
   unhealthy (and restarted by an orchestrator) mid-migration.
4. **The data directory must be writable** (the migration, the backup copy and the signing key all write
   there). On a read-only mount Monomem stops with a readable message naming the directory (for new and existing databases alike).
5. **Stored writer labels are cleaned once.** Labels are compared after Unicode normalisation (NFKC) and with
   invisible format characters (zero-width joiner, bidi marks) removed. The first start of 1.4.2 re-writes
   the stored labels of older notes (and any distrust rule) that this changes, so a rule keeps matching them.
   It is automatic, runs once and touches only rows that change.

Run `monomem doctor` afterwards: it lists the pre-migration copies with size and age, and warns about
leftover `.partial` files.

## Rolling back

To roll back:

Stop every Monomem process (server, MCP clients, runners, the CLI). **Move** `<database>.pre-v19-backup`
over the database (a copy would leave the original; remove the `-wal` and `-shm` files next to it),
reinstall 1.3.x and start it. Anything written after the upgrade is not in the backup. Once you are happy
with 1.4.x, `monomem backup --prune-premigration` deletes the copies (they are plaintext even if you
later enable at-rest encryption). Stale `-journal` sidecars and old partial copies are swept
automatically.

## What behaves differently

- **Old notes have no writer.** Rows from before schema v13 have `written_by` of `""`. A distrust rule
  affects what is written from now on; it cannot say who wrote the older notes.
- **Runners older than 1.3.4** write a heartbeat with no writer marker, which 1.4.x no longer believes.
  Update the runner ([RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)), or set `MONOMEM_RUNNER_ACCEPT_LEGACY=1` as a stopgap.
- **The default export keeps its shape**: `{"notes": [...]}` with no header and no signatures. The notes in
  it carry extra fields (`merged_from_writers`, `written_by`, ...). `?attest=1` / `--attest` adds the
  signed envelope; `import` accepts the plain object, the envelope and a bare array.
- **Import streams.** `monomem import --file` reads the file in batches instead of loading it whole.
  For a file with several batches the similarity edges are not rebuilt per batch: run
  `monomem rebuild-edges` afterwards (the command prints that hint).
- **Notes imported without a verified attestation** are marked `imported_unverified: true` and the agent
  banner says so. The default still accepts them. To refuse them, use `--require-attestation`,
  `require_attestation` over the API, or `MONOMEM_IMPORT_REQUIRE_ATTESTATION=1`.
- **`include_distrusted`** is admin-only, and for a namespace-pinned admin with read grants it applies to
  that token's own namespace only. The primary `MONOMEM_TOKEN` is always an admin.
- **New variables** (all optional, documented in [configuration.md](./configuration.md)):
  `MONOMEM_ATTEST_MIN_VERSION`, `MONOMEM_IMPORT_REQUIRE_ATTESTATION`, `MONOMEM_TRUSTED_ATTESTERS`,
  `MONOMEM_ATTEST_KEY_FILE`.

## A short checklist

1. `monomem backup --out <dir>` yourself as well; the automatic copy is only the pre-upgrade state.
2. Check free disk space (database size, plus the same again for the copy).
3. Upgrade, start, wait for the migration, run `monomem doctor`.
4. If you use several servers: read [trust.md](./trust.md), decide whether you want attestations at all
   (they are EXPERIMENTAL), and back up the signing key (`trust export-key --out <file>`,
   `backup --include-attest-key`).
5. Update runners older than 1.3.4.
