# Replacing a memory, history and confidence (1.6.0)

Plain version: when a note is out of date, you can **replace** it with a newer one. Monomem never does that
quietly. It first shows you exactly what would stop appearing in search, you say yes, and only then does it
happen. Nothing is deleted, and you can undo it.

## Replacing a memory is always two steps

1. **Preview.** Changes nothing. It shows a warning headed **ARE YOU SURE YOU WANT TO REPLACE THIS?** with, for each
   old note: what it says, who wrote it, when it was first saved and last changed, its tags, how many other notes are
   very similar to it, and how many tasks depend on it. It also says what you lose (the old note stops showing up in
   search, lists and "what is relevant" lookups), what you do **not** lose (nothing is deleted; the old note keeps its
   text, writer, dates and tags and can be brought back), and, if it applies, a **RED FLAG** (see below).
   When one note is replaced, it also shows the change line by line (`- ` old, `+ ` new; the `diff` field over REST and
   MCP). It compares only the first 600 characters of each text, the same text the preview already carries, with
   control characters replaced and at most 40 lines.
   It returns a one-time **confirmation code**.
2. **Confirm.** The only step that changes anything. It needs that code. The code
   - works **once**,
   - expires (10 minutes by default; `MONOMEM_SUPERSEDE_TTL_SECONDS`, 1 to 3600),
   - works **only for the person who asked** (same writer, same scope, same tenant),
   - is tied to the exact notes and versions you were shown: if any of them is edited after the preview, the confirm is
     refused ("something changed; run the preview again"), and
   - is tied to the exact replacement text: if you previewed one text, you cannot confirm a different one.
   A damaged, made-up or copied-wrongly code is refused with the same short message, so a code cannot be probed.

The whole confirm is one database transaction: either every old note is retired and the replacement exists, or
nothing changed.

### Where you do it

| Surface | Preview | Confirm |
|---|---|---|
| Command line | `monomem supersede --old 12[,13] --title "..." --body "..." [--tags a,b] [--confidence 0.8]` (or `--new-id 40` to use a note that already exists) | At a terminal it asks you to **type the number of notes** you are replacing (or `yes`); anything else cancels and changes nothing. With no terminal (a script) it only previews, prints the code, and exits 2. A script must run `monomem supersede --confirm-token <code> --title ... --body ...` (the same text). There is deliberately **no `--yes`**. |
| REST | `POST /supersede/preview` `{ old_ids, new_note \| new_id }` | `POST /supersede/confirm` `{ token, new_note?, acknowledge_risk? }` |
| MCP | `memory_supersede_preview` | `memory_supersede_confirm` |
| Undo | `monomem supersede undo <id>` | `POST /supersede/undo` `{ id }` · `memory_supersede_undo` (recorded) |

At most 20 notes can be replaced in one go. Tasks and handoffs are managed with the task tools and cannot be replaced.
Replacing needs a write or admin token; a read token is refused.

**A limit you should know about.** For MCP and REST, the "Are you sure?" step is enforced by the code (nothing happens
without a valid code from a preview), but it is the **agent** that talks to you. A careless agent could show you a
shortened warning, or confirm without asking. The tool descriptions tell the agent to show the full warning and wait for
you. The command line is the strongest gate: it asks you, at your own keyboard, and cannot be answered by an agent.
For notes you care about, replace from the command line.

## Nothing is deleted

A confirmed replacement marks the old note **superseded** and links it to the note that replaced it
(`status: "superseded"`, `superseded_by`). Superseded notes are left out of search, lists, "what is relevant", similar-note
suggestions. To see them anyway, ask for them: `?include_superseded=1` on
`GET /search` and `GET /notes`, `?superseded=1` for only those, `include_superseded` on `state_search` / `state_list`.
They are always labelled. A superseded note cannot be edited until it is brought back.

**Undo** brings the note back exactly as it was. Undo is recorded (who, when, which note) like the replacement itself. A write token can undo only a replacement
it made itself; undoing someone else's (for example an administrator's, made to hide a bad note) needs an administrator.
**Hard delete is unchanged**: `DELETE /notes/:id` still deletes for good (admin), and takes the note's history with it. One exception, so nothing
is lost by accident: if you hard-delete a note that *replaced* others, those notes come back (logged), because nothing would be left to point at.

## The trust guard

Replacing hides a note, so it is held to the same trust rules as everything else:

- A writer an administrator has **distrusted** is refused outright ("NOT ALLOWED"), with the reason in plain words.
- A replacement that **claims lower confidence** than the note it replaces carries a **RED FLAG**.
- For a red flag the preview is only given to an **administrator**, the warning says so, and the confirm must also say
  `acknowledge_risk` (on the command line you must type `i accept the risk`). A write token cannot confirm a code that
  carries a red flag, even one an administrator previewed.
- Flags are judged again at confirm time, so a rule or a confidence that changed in between is caught.
- Confidence is only ever **what the writer claimed**. It is never used to override trust: a distrusted writer is
  blocked whatever confidence it claims.
- The warning also names notes written by **other** writers and notes a trusted server vouched for.

## Version history

Every edit that changes a note's title or body keeps the text it replaces (and the writer, tags, source and confidence it had).

- Bounded: `MONOMEM_HISTORY_VERSIONS` (default 20 per note; 0 turns it off; at most 500) and
  `MONOMEM_HISTORY_MAX_BYTES` (default 2,000,000 per note). When a note is over a limit, the **original version is
  never dropped**, a writer's older copies go before another writer's newest one (so one writer flooding edits cannot push out
  someone else's version), and otherwise the oldest goes.
- **Administrators only.** Old text can hold something that was taken out on purpose. `GET /notes/:id/history`, `memory_history`,
  `monomem history <id>`. Versions written by a distrusted writer are left out unless the admin asks for them.
- **Restore**: `POST /notes/:id/history/restore` `{ version, if_rev? }`, `memory_restore_version`, `monomem history restore <id> <version>`.
  A restore makes a **new version**; the text it replaces goes into the history, so a restore can itself be undone.
  A version written by a distrusted writer cannot be restored. Restoring a version this server saw being written takes the note's
  taint back to what that text had then (this is how an admin recovers a trusted original after distrusting an overwriter);
  a version that arrived by import is only a claim and can only add names.
- **Forget**: `DELETE /notes/:id/history`, `memory_history_purge`, `monomem history purge <id>` (asks first) removes the kept versions
  (use it after a secret was removed from a note). A hard delete of the note removes its history too.
- Encrypted at rest like note bodies when encryption is on, and bound to their own row.
- Carried by `export` (turn off with `?history=0` / `--no-history`) and `import` (every entry is a **claim**: names in the file are kept as
  `claimed_writer`, never as a verified writer; size and content checks apply).

## Pinned notes (CLI-only)

`monomem pin <id>` pins a note; `monomem unpin <id>` lifts it; `monomem pin` lists them. Over REST: admin-only `GET /pinned` and
`PUT /pinned { id, pinned }` (a namespace-pinned admin token reaches its own namespace only). No MCP tool pins or unpins. An agent with a shell tool can run the CLI itself, so a pin protects against MCP and REST agents, not against agents that can run commands.

Agents can still read a pinned note (reads show `pinned: true`, so an agent can tell why a change is refused). Only the local
`monomem` CLI (writer `cli`) can change it. Everyone else gets an error naming the note: MCP over stdio or HTTP, every REST call
(an admin token included, the same rule as approve-first: REST cannot tell an operator from an agent holding an admin token), the
server's own jobs and library callers. Refused for them:

- editing it (`state_write` with its id, `PUT /notes/:id`; a tags-only or source-only edit too);
- forgetting, restoring or hard-deleting it (`state_delete`, REST archive / restore / `DELETE /notes/:id`);
- replacing it (`memory_supersede_preview` refuses up front, the confirm refuses too) or bringing it back with supersede undo;
- putting back an older version (`memory_restore_version`) or forgetting its history (`memory_history_purge`);
- merging it (`memory_consolidate`; the background janitor skips it).

A pinned note is never archived by the expiry sweep (`forget_after`) or by decay. An admin REST token can unpin a note and then
change it, so a pin holds against every caller except the CLI and an admin token. A pin is local: export, import and vault sync do
not carry it. It is not the `pinned` tag, which only keeps captured rows from decay.

## Rolling back one writer

Undo everything one writer did since a moment, for example after an agent went wrong:

```
monomem rollback --writer stdio:cursor --since 2h          # or --since 2026-11-04T09:00:00Z
```

The writer name is matched exactly as stored in `written_by` (`token:ci`, `stdio:cursor`, a token label); `stdio` also covers
every `stdio:<app>`, as in distrust rules. For each note:

- **created** by the writer since then: **archived** (never deleted; `monomem restore <id>` brings it back);
- its title or body **changed** by the writer since then: the newest version kept from **before the writer's first change** since
  then becomes the current text again, as a new version (history reason `rollback`). The text it replaces goes into the history,
  so `monomem history restore <id> <version>` / `memory_restore_version` undoes it. There is no separate undo command;
- **another writer changed the text later**: a **conflict**, listed and skipped. `--include-conflicts` rolls it back anyway (the
  other writer's text stays in the history);
- the version needed is no longer in the bounded history (pruned by the limits above, or purged): **cannot fully undo**, listed
  and always skipped. Nothing is guessed;
- a replaced (superseded) or archived note is listed and skipped.

It is two steps, like a replacement: the preview writes nothing and lists exactly what would happen, plus a one-time code (it works
once, for `MONOMEM_SUPERSEDE_TTL_SECONDS`, default 10 minutes, and only for the caller it was made for). The confirm plans again
under the write lock and refuses if anything differs from the preview; it applies everything in one transaction, or nothing. The
CLI shows the preview and asks you to type yes (`--yes` skips the question; without a terminal and without `--yes` it only
previews). Each rollback writes an audit entry.

Also over REST (admin): `POST /rollback/preview { writer, since, include_conflicts? }` and `POST /rollback/confirm { token }`; and
the MCP tool `memory_rollback` (admin, operator-only: not registered over stdio unless `MONOMEM_STDIO_ADMIN_TOOLS=1`, and only
under `MONOMEM_TOOLS=all` or when named). Pinned notes and notes in approve-first namespaces are rolled back from the CLI only
(marked in its preview); REST and MCP list them as skipped (`operator_only`). Restores made by a rollback are not counted by the
flood guard; a paused caller is still refused.

Limits: only notes the writer created, and title/body changes it made, are rolled back. Tag, source, namespace or confidence edits,
notes it forgot (archived), replacements it confirmed (use supersede undo) and hard deletes are not. A change made while history
was off (`MONOMEM_HISTORY_VERSIONS=0`) left no saved version: it is reported as cannot fully undo only if history is still off and
the note still names the writer, otherwise it is not seen. The dropped-version check is kept per writer as a time span, so an
older drop that overlaps can also produce "cannot fully undo" (it errs on the side of skipping).

## Confidence (a claim, never a check)

A note may carry `confidence`, a number from 0 to 1 that the writer **claims** for how sure it is. It is validated (anything
else is refused), labelled with who claimed it (`confidence_claimed_by`), kept through edits, export and import, shown in
search results, and used in the replace warning. A `null` clears it. Monomem never ranks by it and never lets it override
the trust rules.

## Ranking: the newer of two near-identical notes comes first

When two notes are about the same thing (very similar, as in "similar-note suggestions") and the older one is flagged stale, the older one now stays
behind the newer one in search, even if it matches the words slightly better. It is still returned (and still flagged) so nothing disappears.

## Conflicts between writers

`monomem conflicts` (also in `monomem quality` and the dashboard's Quality view) lists live notes from different writers that
disagree. It only flags: nothing is changed, hidden or merged. Notes from distrusted writers are left out. Each side shows
the writer's label and what kind of label it is (a server-stamped marker such as `stdio`, or a token label from your config),
so a label cannot pass as a peer by its spelling.

- **Exact tier (`facts`).** An agent attaches `facts` when it writes (`state_write`, `POST /notes`): at most 10 keys, keys
  `[a-z0-9_.-]{1,40}`, values one line of at most 80 characters. They are stored as the tags `fact:<key>=<value>` (no schema
  change; the secret and injection scan runs on them like any tag). Two live notes in one namespace, from different writers,
  with the same key and different values (case and extra spaces ignored) are flagged. When such a note is written, the write
  succeeds and the reply carries `conflicts` so the agent can ask the user. Limit: the match is exact on the key, so one key
  reused for two subjects is flagged. Reuse a key from the reply's `similar_keys` or this list: `deploy_target`, `package_manager`, `test_runner`, `database`, `node_version`, `base_url`, `ci_provider`, `formatter`. Prefix a subject only when the project has several (`api.deploy_target`). When a write uses a key that is new to the namespace, the reply adds `similar_keys` (existing keys with the same last segment or a known synonym, e.g. `hosting` for `deploy_target`) so the agent can reuse one (each comes with the existing value, note id and writer, plus a `hint`; a prefixed key such as `api.deploy_target` against its base key is intentional scoping and is not flagged). A synonym key is also checked on write: `hosting=fly.io` against `deploy_target=render` is reported as a conflict. At session start, disputed keys appear as at most two "Monomem: writers disagree on ..." lines (values quoted, with note ids and writers; "+N more" when more are disputed), whether or not a namespace is configured.
- **Keep a fact.** The dashboard's "Keep <value>" removes only the disputed fact from the other notes (they stay, with their other facts) and tags each with `fact-removed:<key>`: the note's text may still mention the old value, so look it over. If the namespace is approve-first the dashboard says the change is held for review and nothing is removed yet. "Replace whole note instead" is the secondary choice and retires the whole note; Pin and Distrust sit under "More". From a terminal: `monomem fact remove <id> <key>`; `monomem facts [--namespace ns] [--as-of t]` lists the recorded facts (as-of shows the notes that existed then with their facts as tagged now; tag history is not kept). `monomem facts --check` prints one line and exits 1 if any fact is disputed (synonym spellings such as hosting / deploy_target count as one setting), 0 if none: for CI. Disputes are per namespace: the same key in two namespaces is not a dispute. `fact remove` on a pinned note needs the same terminal confirmation as other CLI edits of pinned notes. Conflicts are shown as one block per key listing every value and its notes; when the search is capped (500 pairs) the header says "showing N of at least M".
- **Possible tier (no facts).** The older text rule: both titles state the same `key: value`, or the titles are identical
  and the bodies hold different values for one key. Titles that merely differ ("Hosting" vs "Where the app runs") are not
  matched: loosening that gate was measured and flooded the list with look-alike notes.

Measured (test/conflicts-facts.test.ts; P = precision, R = recall; the realistic set is 20 true pairs with natural, different
titles and 12 look-alikes that are not conflicts; the facts are the ones an agent following SKILL.md would attach):

| Set | Exact tier (facts attached) | Possible tier (no facts) |
|---|---|---|
| Realistic pairs | P 1.00, R 1.00 (20/20) | P 0.00, R 0.00 (0/20; its one flag joins two unrelated notes both titled "Node version") |
| Bench suite B, 7 contradictions | P 1.00, R 1.00 (7/7) | R 0.00 (0/7) |
| Builder fixture (~200 notes, 15 true pairs) | P 1.00, R 1.00 (15/15) | P 1.00, R 0.80 (12/15) |

Exact-tier precision is 1.00 here because the test keys are scoped per subject; it is a property of the match, not a promise
about how agents name keys. Pairs written without facts get only the possible tier.

In the dashboard each conflict shows both values, "Keep &lt;value&gt;" for each side (a replacement that asks first and can be
undone), Pin, and Distrust writer. A pinned note cannot be replaced from the dashboard: change it from the CLI.

## Upgrading

The first start on 1.6.0 upgrades the database to schema v15 (columns for confidence and the replaced link, and tables for history and
one-time codes). As for every schema change, a verified copy of the old database is kept first at `<database>.pre-v18-backup`; the upgrade
does not run if the copy cannot be made. There is no downgrade path: to go back, stop everything, put that copy back as the database,
and install the older version. Upgrading from 1.3.x or 1.4.x: [upgrading.md](./upgrading.md).
