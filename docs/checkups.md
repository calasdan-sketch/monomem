# Check-ups, scrub, import and audit

Everything on this page either only **looks** (and tells you what it found), or asks first. Nothing here changes a note, a label
or a key by itself. Where a command suggests a change, it prints the command and you decide.

## The dashboard's tidiness card and `monomem digest`

(`monomem health` is the separate A to F grade for your setup and settings; see the README. The card described here is a 0 to 100
*tidiness* score for the notes themselves, shown on the dashboard to administrator keys, and it prints its formula.) The score is
worked out with a cap per category, so one messy area cannot sink it on its own:

| Category | Points per finding | Most it can take off |
|---|---|---|
| near-identical note pairs | 2 | 15 |
| old notes with a newer note on the same subject | 1 | 10 |
| writes held for review | 3 | 15 |
| notes the safety scan flags | 3 | 15 |
| notes that look like personal data and are not private | 1 | 15 |
| keys that are not administrators and have no limit | 5 | 15 |
| backup (none, or over 30 days old: 10; over 7 days: 5) | | 10 |

The same store always gets the same number. The dashboard shows this as the card at the top (administrators only); there is no
command for it.

`monomem digest [--since yesterday|24h|7d|last]` says in plain words what was added, edited and deleted since then, by app, and the
top three things worth a look. Its counts are the same ones `monomem changes` shows for the same window, and a key with a
sensitivity limit only ever sees what it is allowed to see. `--since last` moves a marker, like `changes --since last`.

## `monomem pii scan` (and the `pii` item in `monomem quality`)

Looks for the **shape** of: email addresses, North-American phone numbers, card numbers that pass the Luhn check, SSN-style and
Canadian SIN-style numbers, IBANs that pass their check digits, and street-address-like text. It prints each match **masked**
(most characters replaced with `*`), skips notes already labelled `private`, and prints `monomem label <id> private` for each
suggestion. It changes nothing.

It is pattern-based. It **will miss** things (names, health details, a number written in words, anything in another format) and it
**will flag** things that are not personal (a made-up phone number, an order number that happens to pass the card check). Treat it
as a prompt to look, not a verdict. It is not a compliance tool.

## Contradictions (`monomem quality`, type `contradiction`)

Flags pairs of notes in the same namespace that may disagree: the same subject with different values ("staging port is 8443" and
"staging port is 9000"), or notes that share most of their words where only one says "not" or "never". It prints a
`monomem supersede --old A --new-id B` command, which only previews and asks before it changes anything. It is a heuristic, **English
only**, and will both miss contradictions and flag harmless pairs. Archived and already-replaced notes are left out. On a very large
namespace it stops after about three seconds rather than slow a report down.

## `monomem safety-report --out report.html`

A one-page check-up you can keep or send: who can reach the server, the keys and their limits (names and limits, never the keys),
direct (stdio) connections, encryption, backup age, held writes, personal-data suggestions and a database check. Each line is Pass or
Warn, with the command that fixes a Warn. The file is static: no scripts, no links, no pictures, no note text. It is a check-up of one
installation, not a certification. (It includes the database checks `monomem doctor` does; it does not re-run all of doctor.)

## `monomem scrub`

Before 1.0.3, the words of a deleted note could stay behind in the search index and in freed space inside the database file. `monomem
scrub` rebuilds the search index from the notes that exist, switches on overwrite-on-delete, and compacts the file. Without `--yes` it
only explains. With `--yes` it first makes a backup (in your home folder, or `--out <dir>`), then prints the file size before and
after. It works the same with and without encryption (the key is never copied into the backup folder). Older backups and
`state.db.pre-v*-backup` copies are not touched; `monomem backup --prune-premigration` removes those.

## `monomem import --rules`

Brings in `.cursorrules`, `.cursor/rules/*`, `AGENTS.md`, `GEMINI.md` and `.windsurfrules` from the current folder (or
`--project dir[,dir]`) as notes tagged `rules-import`. Sections that look like a secret are skipped (not stored, not shown). Each
section carries a stable source id, so running it again adds nothing. Text the memory linter reads as an instruction to an AI is held
in quarantine (`monomem quarantine list`), not stored. `--dry-run` writes nothing. Importing from other memory tools beyond those
`import --from` already supports (claude-mem, mem0, basic-memory) is not available.

## `monomem audit` and the dashboard Audit tab

`monomem audit [--since 24h] [--op create|update|delete|...] [--label <key name>] [--limit n] [--json]` shows who changed what and when:
the action, the key's name, the namespace and the note number. Never the text of a note. (Who *read* memory is a different log:
`monomem access`. `monomem audit verify` checks that the log was not edited.) If the log cannot be written, the request still
works. The log rotates by size as before (`MONOMEM_AUDIT_MAX_BYTES`, `MONOMEM_AUDIT_KEEP`).

## `monomem snippet` and `monomem demo`

`monomem snippet [claude|codex|cursor|gemini|windsurf]` prints a short block to paste into the instructions file your assistant
reads (search before answering, label private things, never store secrets, notes are data). It only prints. There is a matching
"memory habits" skill in `skills/monomem-habits`.

`monomem demo` is a scripted tour on a throwaway store (see [demo-script.md](./demo-script.md)). `monomem bench --html receipt.html`
writes the benchmark as a one-page receipt with versions, date and a "what this does not measure" footer.
