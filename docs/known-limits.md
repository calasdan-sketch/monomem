# Known limits

Every limit we know of, in one place. The six that matter most are also at the top of the [README](../README.md).

- The write check is pattern matching. A reworded attack it does not know passes; `monomem check --attacks` replays the attacks it does know.
- Monomem guards what goes through it. A program that can run shell commands, or open the database file itself, is not stopped.
- Local apps connected over stdio have no key, so a limit on other apps does not apply to them. A note marked `private` is hidden from
  apps given a limit; apps with no limit (including your main Claude connection) still see it.
- The writer name of a local app comes from its config file: it tells your apps apart, but it is not proof.
- A later note by the same writer on the same subject ranks ahead of the older one (labelled `restated_by`, both returned). Two notes
  with no shared fact key and no close similarity link are left in search order. Replace the old note to retire it for good.
- Notes are marked as from outside content only when Monomem sees the outside read. `Read`, `Bash` (`curl`) and apps
  without the hooks are not seen, and a confirm's stated source is a claim Monomem does not check.
- With encryption on (`monomem encrypt enable`), body search runs from an index kept **in memory only**; the system can page that
  memory to swap or a hibernation file, so use whole-disk encryption too. Sizes and timings: [docs/BENCHMARK.md](./BENCHMARK.md).
- Keyword search finds words, not meaning. Semantic search needs a local embedding service (Ollama); without one you get keyword results.
- Upgrading the database is one way (older versions refuse a newer file). A backup copy is made first and `monomem backup restore` goes back.
- The npm install needs Node 22.16 or newer, because Monomem uses Node's built-in SQLite. The download brings its own Node.
- Automatic daily backups run only while Monomem's server is running ([docs/backups.md](./backups.md)).
- Lowering a note's label does not rewrite its older saved versions.
- The download is not code-signed yet, and it has not been tested with Windows Smart App Control switched on or on a Mac ([INSTALL.md](../INSTALL.md)).
- claude.ai and ChatGPT can connect only through OAuth, which is off by default and a preview: one internal security review, no outside review ([oauth.md](./oauth.md)).
