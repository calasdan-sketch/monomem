# Trust: distrusted writers, writer ids and signed attestations

Every note says who wrote it ([provenance.md](./provenance.md)). An admin can
also say **whom not to believe**, and a server can **vouch for the writers it exports**. This page
says exactly what each piece does, and what it does not prove.

> **EXPERIMENTAL.** The signed attestations, cross-server writer ids (`<server_id>/<label>`), `trust rotate`,
> `trust attester-revoke` and the `--any-server` escape hatch are new and have had little use outside tests.
> Their formats, flags and verdict texts may change in a minor release. The local distrust list is the
> stable part. Upgrading from an early release: [upgrading.md](./upgrading.md).

## Vocabulary

| Term | Meaning |
|---|---|
| **label** | what a token is called (`MONOMEM_TOKENS` `label`), or a process marker (`stdio`, `cli`, `server`, `runner`). This is `written_by`. |
| **server_id** | a random UUID minted once per database (the `store_uuid` row in `_meta`). It never changes, survives restarts, upgrades, backups and restores of the file, and is in every export. |
| **writer_id** | `<server_id>/<label>`. The same label on two servers is two different writers; the id says which. Returned next to `written_by` on notes, tasks, handoffs and every change-feed entry (`writer_id`, `note_writer_id`). Additive: `written_by` keeps working everywhere. |
| **distrusted** | a writer an admin has put on a namespace's distrust list. |
| **attestation** | a detached Ed25519 signature a server makes over one note when it exports. |

A filter or a rule accepts a bare label (`phone`) or a writer id (`<server_id>/phone`). A value is an
id only if it starts with a UUID and a slash; a label that merely contains a slash is still a label.

## The distrust list (`distrust_writers`)

A per-namespace list of writers whose notes are not to be shown to agents. `namespace` is a namespace
or `*` (every namespace). The default list is empty and then **nothing is hidden**: the same notes come back as before. (Result shapes
only ever gain fields, so a note now also carries `writer_id` and so on.)

### Who can change it

Only an **admin** scope token (or the local owner on the CLI / stdio). Never a write token, and never
note content: the list lives in the database tables `trust_distrust`, `trust_attesters`, `trust_log`,
not in any note. A token pinned to a namespace can manage only that namespace's rules (never `*`) and
cannot change the server-wide attester list. A pinned admin also **sees** only its own namespace's
rules, the global (`*`) rules that apply to it and the matching log lines: never another namespace's
rules, never the attester list, never another namespace's runner host names. Every change is
recorded in `trust_log` (who, when, what) and in the audit log. The log is pruned **per namespace**
(the newest 1000 lines of each namespace, and of the global `*` bucket, are kept), so a busy namespace cannot push
another one's history out. A pinned admin does not see the server-wide `attester-*` and `key-rotate` lines.

**The primary token (`MONOMEM_TOKEN`) is always an admin, and is never pinned.** It is the only token that can
set `*` rules and see everything. A deployment that has distrust rules but only that one token gives every
client admin rights, so `monomem doctor` warns about it: give clients their own `MONOMEM_TOKENS` entries.
For a namespace-pinned admin that has `readsFrom` grants, `include_distrusted` is honoured **only for the
token's own namespace** (pass `namespace=<own>`); asking for it across a granted namespace is refused.

Names are compared after **NFKC normalisation** (full-width and compatibility forms fold to their plain
form) with zero-width and other format characters removed, so `ａｄｍｉｎ` and `ad\u200bmin` are `admin`.
Case is **not** folded: `Phone` and `phone` are two writers (tokens are case-sensitive).

A distrusted-but-active write token **cannot edit the metadata** (tags, source, namespace) of a trusted
note either, unless it is that note's own writer; otherwise it could re-label notes it does not own.

| Surface | How |
|---|---|
| MCP | `trust_policy` (admin): `action` = `list`, `distrust`, `undistrust`, `add_attester`, `remove_attester`, `revoke_attester`, `unrevoke_attester` |
| REST | `GET /trust`, `POST /trust/distrust {namespace, writer}`, `DELETE /trust/distrust?namespace=&writer=`, `POST /trust/attesters {public_key, server_id, label?, not_after?, any_server?}`, `DELETE /trust/attesters/<key_id>`, `POST /trust/revoked {key_id, reason?}`, `DELETE /trust/revoked/<key_id>` (all admin, including the GET) |
| CLI | `monomem trust [list]`, `trust distrust <writer> --namespace <ns\|*>`, `trust undistrust ...`, `trust attester-add <public-key> --server-id <id> [--label text] [--not-after <ISO time>] [--any-server]` (a base64url key can start with `-`: pass it as `--public-key <key>` or after `--`), `trust attester-remove <key-id>`, `trust attester-revoke <key-id> [--reason text]`, `trust attester-unrevoke <key-id>`, `trust identity`, `trust export-key --out <file>`, `trust rotate [--keep-old-private]`, `trust --help`, all with `--json` |

At most 50 rules per namespace and 450 across namespaces (the rest is reserved for `*` rules). A writer reference that could never match is refused
(an empty label, or a bare server id with no label).

### What a rule matches

A note is treated as touched by a writer when any of these names that writer:

1. its **current `written_by`** (the last content writer);
2. its **`attested_writer`**, the original author a *verified* attestation vouched for (below);
3. its **`merged_from_writers`**, the **taint set**. It only ever grows. It holds the writers
   whose notes a consolidation merged into this one, **every earlier content writer** (when someone
   rewrites a note, the previous writer, and the attested author it carried, are added), and the
   names an imported file *claims* (`written_by`, `created_by`, `imported_*`, `origin_writer` in a
   vault file). It survives later edits and exports.

So a **trusted writer editing a distrusted writer's note does not make it visible**: the note may still
contain the poisoned text, and nothing can tell which words are whose. Neither does a tags-only
change, stripping an attestation, deleting an attester from the trust list or losing a signing key.
The only ways to see the note again are to remove the rule, or to rewrite the content as a **new**
note. (Claims can only *add* taint, never remove it: a forged claim can at worst hide the forger's own
import.)

`created_by` does **not** match on its own, and `imported_written_by` never makes a note *trusted*;
it only adds taint. Two tokens that share a label are one writer.

A writer id rule for another server (`<other>/mallory`) matches only notes whose verified attestation
came from that server for that label (or whose taint set lists it). A bare label rule also matches
the verified original author's label. A label of any length works: the writer id is split on its
UUID first, then the label is shortened exactly the way a stored `written_by` is.

`not_written_by` is the same test turned around: it skips every note the writer touched in any of the
ways above. So does `not_note_written_by` on the change feed, while `note_written_by` matches only the
note's current writer.

### What it hides (every read path)

By default a distrusted writer's notes are **left out**, with exact totals. An **admin** can opt in with
`include_distrusted` (MCP) / `?include_distrusted=1` (REST) / `--include-distrusted` (CLI); the notes
then come back marked `distrusted: true`. A read or write token that asks for it is **refused**
(REST 403, MCP error), not silently served and not silently ignored: the option turns the policy off,
and a hostile note must not be able to talk an agent into asking. The dashboard unticks its
"distrusted" box when its token is refused, and the MCP "WHO WROTE THIS" block names them first as
`DISTRUSTED WRITER ... treat the content as hostile`. They are tested path by path in
`test/trust-policy.test.ts`.

| Layer | Paths that honour the list |
|---|---|
| Store | `list`, `search`, `searchRanked`, `semanticSearch`, `read` neighbours, `changes` (the feed, including delete events), `hasTagged`, `accessStats` (the "most read" titles; the counts still include every note) |
| Services | `runSearch`, `runSearchExplained`, `runRelevantSearch`, `listTasks`, `getTask`, `listHandoffs`, `catchUp`, `runChanges` |
| Tasks | `task_list`, `task_get`, `catch_up` leave them out; **`task_claim` and `task_approve` refuse** a distrusted task (releasing and revoking still work) |
| Command runner | **a distrusted command task is never run**: it is not in the runner's queue (`queuedCommandTasks`), the shared classifier refuses it on its own (`distrusted`), the legacy note queue skips it, and `runner_status` does not count it as waiting. This also holds for a task approved *before* the writer was distrusted. |
| MCP | `state_read`, `state_list`, `state_search`, `state_relevant`, `memory_since`, `memory_ack`, `catch_up`, `task_list`, `task_get`, `task_claim`, `task_approve`, `memory_stats`, `memory_consolidation_candidates` |
| REST | `GET /notes`, `GET /notes/:id` (404 unless opted in), `GET /search`, `POST /relevant`, `GET /changes`, `POST /ack`, `GET /tasks`, `GET /tasks/:id`, `GET /handoffs`, `GET /catch-up`, `GET /stats` |
| CLI / hook | `monomem recall` (the SessionStart hook), `relevant`, `changes`, `watch` |
| Dashboard | hidden by default; a "distrusted" checkbox shows them with a red DISTRUSTED badge |

**One gate.** A note read by id goes through `Store.readVisible` and a set of notes through
`Store.filterVisible` or the SQL predicate (`distrustSql`); `test/trust-gate-guard.test.ts` fails when a
new HTTP GET route, MCP tool or raw store read appears that nobody classified, and a canary note is
shown to never reach a non-admin reader through any classified route. By id, a hidden note is "not
found" to a non-admin for read, update (so a tags-only change cannot echo its body), archive, restore
and `task_put`; `client_key` replays and the janitor never touch it; consolidating a mix of hidden and
visible notes is refused.

**Also honoured:** the markdown vault export (`monomem export --format md --dir <path>`) leaves hidden notes out
and prunes their earlier files; `--include-distrusted` writes them with `distrusted: true` in the front
matter. The auto-merge janitor ignores hidden notes.

**Deliberately not hidden** (they are for the owner): the full JSON export / backup (a backup must be
complete; the notes keep their writer fields and taint, so another server applies its own policy), and
admin operations by id (delete, consolidate, quarantine). A pinned token's namespace and scope
isolation is unchanged on every path. Anyone who can read the database file is outside this model.

### Setting it up

```
monomem trust distrust phone --namespace work       # one namespace
monomem trust distrust phone --namespace "*"        # everywhere
monomem trust list
monomem trust undistrust phone --namespace work
```

Take a writer off with `undistrust`; its notes come back at once (nothing was changed or deleted).

## Outside content: limits first (1.4.0)

The writer label says **who** saved a note. It cannot say where the text came from: an agent that read a poisoned web page
and wrote the payload in its own words is still a trusted writer (the drill's known miss `SELF`). Since 1.4.0 Monomem marks
notes written after an outside read **when Monomem can see it**, keeps them out of session start until confirmed, and
refuses to make them pinned notes until a person confirms them. Read what it cannot do before relying on it:

- **It only sees what it can see.** Not seen: `Read`, `Grep` and `Bash` (`curl`, `git pull`), and apps without Monomem's
  capture hooks (Cursor, Codex over plain MCP). A note **without** the mark is not thereby safe. Every note is still
  untrusted data.
- **It does not judge truth.** A marked note may be correct; an unmarked one may be poisoned.
- **The read signal is per connection** (one stdio server, or one key on one server: REST and MCP over HTTP share it)
  and **resets when the server restarts**. Since 1.5.0 it also fades: a write is marked `via:memory` only while a note the
  connection read within the taint window is still unconfirmed, so a person's confirm ends it. A reply that carries an
  unconfirmed note counts as a read on every route and tool, not only the read ones. Session start says how many unconfirmed
  notes wait and why (web session / read of unconfirmed notes / declared), and `monomem health` never grades A with 10 or more
  waiting or one waiting more than 7 days (capped at B).
- **A local (stdio) app's confirm never counts.** Its name (`stdio:<app>`) comes from its config file, so one process could
  play two writers.
- **A stated source is a claim.** Monomem never fetches it. A second agent's confirm is corroboration, not verification:
  a lying agent can name any source.
- **A key proves which key wrote, not which agent.** App keys sit in the app's own config file (and the primary key in `.token`);
  any program running as your user, including an agent with a shell tool, can read them and act as that app. That is why a second
  key's confirm is only corroboration ("two keys agreed") and never lifts the promotion block. The full list of files is in SECURITY.md.
- **`derived_from` only works if agents fill it in**, and it looks one hop back. A copy without it is not linked.
- **An admin key can release the session-start hold.** REST cannot tell a person from an agent holding an admin key; only
  the pin block needs a person at the terminal. An admin key that was handed the note while unconfirmed is refused like
  any agent; only the dashboard opened with `monomem open` **at a terminal** (its sign-in session: 8 hours, bound to the
  key it signed in as) is treated as a person looking at it. `monomem open` from an agent's shell or a script signs in
  without that session and says so. Whoever holds the primary key can make more keys, and so can forge corroboration.
- **A shell that looks like a terminal counts as a person.** "At a terminal" means stdin and stdout are terminals; an
  agent tool that opens a pseudo-terminal passes that check, for the typed-yes commands and for the CLI's exemption from
  the session signal below alike. Monomem cannot tell that apart.

The word "taint" below means this outside-content mark (reserved `obs.origin:*` tags). It is separate from the **taint set**
of writers described above (`merged_from_writers`).

## Outside content and taint (1.4.0)

A note is **marked** (tainted) when it carries a reserved `obs.origin:*` tag. Only Monomem sets one. Three signals, each
of which only adds:

| Mark | When |
|---|---|
| `obs.origin:tool:<name>` | A hook-equipped session recorded output from an outside tool (`WebFetch`, `WebSearch`, any MCP server except Monomem and those in `MONOMEM_LOCAL_MCP_SERVERS`) within the last `MONOMEM_TAINT_WINDOW_HOURS` (default 12; `0` = off), has not ended and had an event in the last 30 minutes (an idle or crashed session stops counting at once). Up to 3 tool names, or `other`. **1.5.0: the window follows the writer, not the namespace.** It marks only local writers that have no key of their own: a stdio server (matched by the folder it was launched in: the same folder as the session, or one containing the other) and the `monomem` command run without a terminal. The namespace a write names does not matter. A local server whose folder matches no active session is an unknown origin and gets the worst case (any open window). Apps with their own key (REST, MCP over HTTP, the admin key, the dashboard) are **not** marked by it; set `reads_outside` on such a key, or declare writes with `outside: true`. A person can close the open windows with `monomem taint clear [--all | --session <id> | --here]` (terminal and typed yes; marks already written stay). Writes by capture, the server's own jobs, the runner and imports are not marked by this signal, and neither are writes by the `monomem` CLI **at a terminal** (stdin and stdout both terminals). Run from an agent's shell tool, a script or a pipe, `monomem add` is marked like any other writer. |
| `obs.origin:via:memory` | The connection writing the note had been handed an unconfirmed note (in a read, a search or a list), or the note names an unconfirmed note in `derived_from`. |
| `obs.origin:declared` | The writer said so: `outside: true` on MCP `state_write` or REST `POST`/`PUT /notes`, `monomem add --outside`, or a token entry with `"reads_outside": true` ([configuration.md](./configuration.md)). `outside: false` removes nothing. |

The session signal is per namespace on purpose: the MCP server never learns the host's session id, so a browsing session
can mark a sibling session's notes. A person's confirm clears that. An outside-tool event that was spooled (the database was
busy) marks, when it is stored, the notes written in that namespace within the window after it.

**It cannot be removed.** Every update path re-adds a dropped `obs.origin:*` tag (REST, MCP, file sync, restoring an older
version). An agent's write cannot add or remove `obs.` tags itself; only the `outside` flag adds one.

**Unconfirmed.** A marked note that has no counted confirm for its current version is **unconfirmed**. It is:

- kept out of session start: its text, its title, the pinned list, the profile, the fact-dispute line, the task board
  (an unconfirmed task or handoff is left off it), the per-prompt new-notes block and the file-context hook (which says how
  many notes about the file it held back, without titles). One
  line, with no titles, says how many: `Monomem: 3 notes from outside content wait for confirmation (not shown). Review:
  monomem review`;
- labelled `[unconfirmed - from outside content]` in search, reads, index lines and the dashboard (records carry
  `unconfirmed: true` and `unconfirmed_label`);
- ranked slightly lower in search (score x0.9) and still returned;
- never hidden, archived or deleted.

A marked note that **is** confirmed is shown at session start as an index line only, never its text. Notes that existed
before the 1.4.0 upgrade are exempt from this hold (`grandfathered_at`) until an edit brings outside content into them
(a mark, new or one they already carry) or a spooled outside read marks them. They are **not** exempt from the promotion
block below.

**Who has read an unconfirmed note.** A connection is marked once it is handed an unconfirmed note: in a read, search,
list, task or handoff read, `catch_up`, `memory_why`, `memory_receipt`, `memory_supersede_preview` or the held-write
context. Over HTTP this is kept per key and shared by the REST API and MCP over HTTP on the same server, so a read over
one and a write over the other is the same writer.

## Confirming notes

A confirm records who checked a note, when, and against what. It is bound to the note's current version: an edit makes a
marked note unconfirmed again.

| Surface | How | Counts as |
|---|---|---|
| CLI | `monomem confirm <id> [--source "what you checked"]` (asks you to type yes in a terminal) | **human**: always counts |
| CLI | `monomem review` lists what waits (id, namespace, title, writer, why); `--confirm-all [--source s]` confirms them all as you after one typed yes | human |
| Dashboard | **Confirm** button on an unconfirmed or expired note (admin key; source "checked in the dashboard") | **admin** |
| REST | `POST /notes/:id/confirm {"source": "..."}` (write scope; an admin key confirms as admin). Answers 200 with `counted` | admin, or corroborated, or not counted |
| MCP | `memory_confirm {id, source}`. Not in the default tool set: turn it on with `MONOMEM_TOOLS` | corroborated, or not counted |

```
$ monomem confirm 42 --source "vendor site"
Confirmed "Acme pricing" by cli at 2026-11-13 14:02. Checked against: vendor site. Next check due 2026-12-13.
```

("Next check due" appears unless re-confirmation expiry is off; see [search.md](./search.md#re-confirmation-expiry).)

**An agent's confirm (corroborated) counts only when all of these hold:** it connects with its own key (not stdio); it did
not write the note (`written_by`, `created_by`, `attested_writer` or the taint set); it is not distrusted; its connection
has not been handed this note while unconfirmed; it has not written a note built from this one (`derived_from`); and it
names a source whose key differs from the note's own `source` and from every earlier counted confirm of this version (a URL
or bare host name, with or without a path or port, compares by host, lowercased, without `www.` or a trailing dot,
international names as punycode; other
text as lowercased text). With expiry on, a confirm older than the expiry period no longer blocks the same writer or the
same source. One counted confirm per writer per version. Confirms by agents count toward the flood guard.

The dashboard's **Confirm** button, in a dashboard opened with `monomem open` at a terminal, is not refused because the dashboard listed
the note: a person is looking at it, and an admin confirm only releases the session-start hold. Any other key (the primary
admin key included) that was handed the note while unconfirmed is refused with `read_it`. A dashboard signed in by pasting
a key has no sign-in session, so it is treated like that key. The reply to an agent or a key names the note by id, not by its title (the title
is outside text); `monomem confirm` in your terminal shows the title.

Otherwise the confirm is **recorded but not counted**, and the reply names the rule:

```
Not counted: research-bot wrote this note, so it can't confirm it. A person or a different agent must confirm.
```

A local stdio app is told `Not counted: ... is a local connection without its own key, so its name is a claim, not an
identity.` Every confirm, counted or not, is kept in the `confirmations` table and the audit log (a repeat of a confirm
that already counted is answered but not stored).

**What each kind releases.** Human, admin and corroborated confirms all let the note back into session start. Only a
**human** confirm lifts the promotion block below. Only a confirm at least as strong as the note's current one for this
version (human > admin > corroborated) replaces it. Only a human or admin confirm restarts the expiry clock: a corroboration
("two keys agreed") releases the session-start hold but never restarts it, and the reply says so. An agent's corroboration
after a person's or an admin's confirm is recorded but changes nothing: if that confirm has expired, a person or an admin
must confirm again. A metadata-only edit (tags, confidence, source) keeps a confirm of the current version; a content edit does not.

## No promotion without a person

A marked note without a **human** confirm for its current version cannot be (this includes notes from before the 1.4.0
upgrade that carry a 1.3.5 outside-content stamp: they keep their session-start treatment, but promoting one needs a person):

- pinned (`monomem pin`, REST `PUT /pinned`, the dashboard);
- used as the replacement in a replace (`monomem supersede`, the replace preview and confirm on every surface);
- used in **Keep as history**, as the held write or as the note that replaces it
  ([memory-linter.md](./memory-linter.md#quarantine));
- approved as a command for the runner, or claimed as a task (`task_approve`, `task_claim`, the REST routes, `approve: true`
  on create). This one also covers a task built on a note from a distrusted writer, and a flagged task. The runner checks
  again on every pass, so a mark or flag added after approval stops the run (reason `held`). Revoking an approval and
  releasing a claim always work. `approve: true` on create leaves the task queued and unapproved, with a warning.

The refusal reads:

```
Can't pin: this note came from outside content. A person must confirm it first: monomem confirm <id>
```

Admin keys and agents are refused too. The only way through is the `monomem` CLI in a terminal: `monomem pin`,
`monomem supersede` (also with `--confirm-token`) and `monomem quarantine keep-history` ask you to type yes first, and that
yes is recorded as your human confirm, in the same transaction as the pin or replace (if that fails, no confirm is left). An agent that can run shell commands can run the CLI itself; see SECURITY.md. A marked note can still be replaced
**by** a clean note.

## `derived_from`

A write may list the notes it was built from: `derived_from` on MCP `state_write` and REST `POST`/`PUT /notes` (up to 20
ids, numbers or digit strings), or `monomem add --derived-from 3,7`. Each id must be a note you can read, never the note
itself. Links are only ever added: an update adds new ones, and `[]` or leaving it out changes nothing. Reads show
`derived_from: [ids]`.

- A note built from an **unconfirmed** note gets `obs.origin:via:memory`. A confirmed parent passes nothing on.
- A note built from a note that a **distrusted** writer touched (one hop: the parent's own writers) is labelled
  `[built on a distrusted writer]` and kept out of session start. Unlike the distrusted writer's own notes, it is still
  listed and searchable.
- A writer that built a note from the target cannot confirm the target.

### The writer folder (stdio)

A local stdio server is matched to hook sessions by its folder: the folder it was launched in, or, when the app offers
exactly one workspace folder over MCP (`roots`), that folder. The same folder drives the live hook-session mark, the late
mark of a spooled outside read (`notes.writer_cwd`), the echo guard and project-first ranking at session start. Both are
the app's own claim: the app chose the launch folder too, and an agent cannot set either. An app that offers several
folders keeps its launch folder, because picking one could miss a session that read outside content in another; a launch
folder that matches no open session gets the worst case (every open window applies). Adopting a root is written to the
audit log (`mcp.root`). Limit: an app that names a folder it is not really working in can avoid that folder's marks, as
it could by launching the server there.

### Echoes

A new note that restates a note its writer was just shown is an **echo**, not new evidence. "Shown" means what Monomem
recorded giving that writer: the unconfirmed notes that connection read, and what session start showed an open session in
the same folder (local apps only). When the new title and body match one of those closely (and are not too short to tell),
the note gets `obs.echo_of:<id>`, the label `[echo of #<id>: restates a note this writer was shown; not a second source]`,
and a `derived_from` link to the original. So it keeps the original's unconfirmed or distrusted status, its writer cannot
confirm the original, and `monomem facts` does not count it as a second writer agreeing. It is a label only: an echo is
never refused. The match is word overlap, so a reworded restatement can slip through, and a short generic note is never
called an echo.

Measured (1.6, `test/echo-precision.test.ts`): on 50 hand-written pairs of developer notes (25 restatements, 25 notes on
the same topic with new facts), split by topic into a half to look at and a half to report, the current rule (word
similarity 0.8 or more, at least 6 words) scored, on the reported half: precision 1.00 (5 of 5), recall 0.42 (5 of 12).
When it says "echo" it was right every time in this set; it misses more than half of the reworded restatements. The
threshold was not changed (precision was already above 0.9). The looked-at half scored the same (5 of 5 right, 5 of 13
found). The set is small and written by one person, so read these as a rough guide, not a guarantee.

Limits: it only works when agents fill it in, it looks one hop back, a held write keeps its mark but loses its links, and
there is no session-start count line for notes built on a distrusted writer.

## Agent flags (1.5.0)

An agent that thinks a note is wrong or out of date can say so without overwriting it: `memory_flag {id, reason}` (not in
the default tool set; add it with `MONOMEM_TOOLS`) or REST `POST /notes/:id/flag {reason}`. The reason is one line of at
most 200 characters. The note itself does not change.

- A flag counts for the version (rev) it was about. Reads show `flagged: [{by, reason, at}]` and the label
  `[flagged by stdio:codex]`; MCP adds `FLAGGED by "stdio:codex": "reason"` to the "who wrote this" block.
- A flagged note that no person confirmed for its current version leaves session start (search and lists still show it). A
  note a person confirmed stays at session start with the label: a poisoned agent cannot erase confirmed memory.
- The reason is the agent's text: it is shown on reads, never at session start. With encryption on it is sealed at rest.
- Refused or ignored: flagging your own note (change it instead), flags from a writer on the distrust list (ignored when
  read, so a later distrust entry also cancels earlier flags), more than 20 flags per writer per day. Each flag counts toward
  the flood guard. With a namespace-pinned key, only notes in its own namespace can be flagged.
- A person decides: `monomem review` lists flagged notes with who flagged them and why. `monomem review keep <id>` keeps the
  note as it is (clears the flags on that version; they stay on record); `monomem supersede --old <id> ...` replaces it.

Limits: an edit that makes a new version leaves the old flags behind (flag again if it is still wrong); flags from a session
that read outside content are not marked differently yet.

## Notes about code that changed (1.5.0)

A note can name the files it is about: `files: ["src/auth.ts"]` on `state_write` or `POST /notes` when creating it (at most
20). Each file must be tracked by git in the writer's repository: the folder a local MCP server was started in, otherwise the
folder the Monomem process runs in. Monomem records the file's id in git's index, the commit and the repository folder, using
the local `git` program only (no network, short timeout, the repository's fsmonitor and hooks switched off).

- When a later commit changes or removes one of those files, reads carry `code_changed: [{path, since_commit}]` and the label
  `[code changed since this was written: src/auth.ts]`, at session start too. The note is not hidden, deleted or unpinned for
  it: a pinned note stays pinned, with the label.
- It is compared with the **committed** code (HEAD), not with unsaved or uncommitted edits. HEAD is read from the `.git`
  files; git itself runs once per new commit per repository, not once per read.
- `monomem stale --code` lists these notes; `monomem review` lists them too. `monomem review keep <id>` says the note is still
  right (its files count as checked against the current commit); `monomem supersede --old <id> ...` replaces it.
- Refused: a path with `..`, a path outside the repository (absolute, or through a symlink), a folder, a file git does not
  track. No git, no commit yet, or a folder outside a repository: `files` is accepted and nothing is recorded, as before.
- Not covered yet: files cannot be added to an existing note (write a new one, or a person runs `review keep`), a write held
  for approval drops its files, captured observations are not anchored, and anchors are not exported or synced (a backup
  copy of the database keeps them). The file paths are stored plain, also with encryption on (docs/encryption-retention.md).

## Confirmed notes in AGENTS.md / CLAUDE.md (1.5.0)

`monomem project-rules [--file AGENTS.md|CLAUDE.md] [--ns <namespace>] [--dry-run]` copies notes into a fenced block of the
current git repository's rules file, for apps that read only rules files. A rules file is read as instructions, so the gate
is stricter than session start. A note goes in only when **a person** confirmed its current version (`monomem confirm` at a
terminal) or pinned it, and none of these holds:

- it is outside content no person confirmed (a pin alone does not let it in), or built on a distrusted writer's note;
- its writer is on the distrust list, it is `private`, an agent flagged it, it is disputed by another note's fact, or a file
  it is about changed in git since;
- it is held back from session start (for example past its re-confirmation date with `confirm-mode enforce`);
- its line fails the memory linter when checked again now.

An admin key's confirm and an agent's corroboration do not count. Each note becomes one line, `- <title>: <text> (om:#12)`,
cut to 300 characters. The command prints what goes in, what is left out and why, and the change to the block; then a
person types yes at a terminal (a script, a pipe or an agent's shell tool is refused, and there is no `--yes`). Only the
text between `<!-- monomem:begin v1 -->` and `<!-- monomem:end -->` is replaced; the rest of the file is kept byte for byte,
and fence lines that are broken (one missing, twice, out of order) are refused rather than guessed. Running it again with
nothing new writes nothing. No hook runs it, and Monomem never writes these files any other way.

The block holds the notes' **decrypted** text, and a rules file is usually committed, so check which namespaces go in. Without
a namespace setting for the folder (and without `--ns`), notes from every namespace qualify; the command then names the
namespaces it drew from and suggests `--ns <namespace>` to keep it to one.

Limits: it looks at the 1,000 most recently changed notes of the namespace; the block is a copy, so it is only as fresh as
the last run.

## Writer record (1.5.0)

`monomem trust` (and `monomem trust --json`, field `writer_record_30d`) shows, per writer, what happened to its writes in the
last 30 days: held by the linter (approve-first holds are not counted: that is the namespace's rule, not the write), rejected
by a person or admin, rolled back, flags upheld (a flagged version that was then replaced) and replaced by someone else (the
two-step supersede, which only admin keys and the terminal can do). The numbers are only shown. Monomem does not hold, hide
or rank anything because of them, and they can only count against a writer, never for it. Counting starts with 1.5.0; older
events are not reconstructed. Decide yourself whether a writer belongs on the distrust list.

## The outside-content stamp on session summaries (1.3.5)

Before 1.4.0 only captured session summaries were stamped. That path still works, and is one of the signals above.

**What sets it.** When automatic capture distills a Claude Code session, the session summary gets the reserved tag
`obs.origin:tool:<name>` for each tool in that session that returns outside content and gave output: `WebFetch`,
`WebSearch`, and any MCP tool except Monomem's own (at most 3 names, sorted). The tool name comes from the hook payload
Claude Code sends, never from text the model wrote. MCP servers you name in `MONOMEM_LOCAL_MCP_SERVERS` (a code index,
say) do not count.

**Why the summary.** It quotes the session's error lines and the agent's closing words, which can carry what an outside
tool returned. Observations are not stamped: their text comes from your prompts and local commands, never from tool
output. A stamp, once set on a summary, stays when the summary is rebuilt later in the session.

**What it changes.**

- At session start, a stamped latest summary is named but its text is **not pasted in**: the agent sees its title, the
  reason, and how to open it.
- Index lines end with `(session read outside content: WebFetch)`, and one legend line explains it.
- The `WHO WROTE THIS` block on every MCP read says `Monomem saw this session read outside content through "WebFetch"
  (stamped, not claimed)`.

**It cannot be dropped.** Once a note has the stamp, every update path keeps it (REST, MCP, file sync, JSON import, the
CLI): the stamp only grows. `obs.` tags are reserved, so an agent's note write can neither add nor remove one, and a
trusted writer cannot quietly promote a stamped summary into a clean note. Two admin-level routes can *create* a note that
already carries a stamp: `monomem import` / `POST /import` and a synced vault file. That can only add caution, never remove
it. A tool name that is not plain name characters (letters, digits, `_ . -`, up to 80) is stamped as `other`, and so is
one the write-time linter refuses, so a hostile name can neither reach the agent's context nor cost the session its
summary. A stamped note's text is never pasted into the session-start block, pinned or not.

Since 1.4.0 a summary stamped after the upgrade is also unconfirmed like any other marked note (out of session start
until confirmed). A summary stamped before the upgrade keeps the treatment above.

**What it is not.** A note **without** the stamp is not thereby safe. Every note is still untrusted data. Not covered:

- an agent that paraphrases outside text into an ordinary `state_write` when Monomem saw no outside read (the drill's
  `SELF` miss stays a reported miss: the write check still cannot tell). Since 1.4.0 the session window above marks such a
  note when the outside read happened in a hooked session in the writer's folder (local apps only; an app with its own key is not covered by the session window, so set `reads_outside` on its key, and an agent can start a stdio server from a folder that has a clean hooked session; `Bash` `curl` is still not seen);
- clients without Monomem's capture hooks (Cursor, Codex over plain MCP): nothing is stamped there;
- local reads (`Read`, `Grep`) and `Bash` (`curl`, `git pull`), which run in nearly every session, so a downloaded README
  read with `Read` is not stamped;
- injection that acts inside the live session before anything is stored.

An agent's own claim of origin stays a claim: the free-text `source` field is shown as `claims source="..." (unverified)`.
Imported notes keep their own stamped label (`imported WITHOUT a verified attestation`).

The safety does not rest on the stamp: the benchmark's E20 checks that a trusted writer which claims its note is its own is
still held by the write-time linter. E21 and E22 (1.4.0) check that a trusted writer's paraphrase of a web page, and an
agent's summary of an unconfirmed note, are marked and cannot be pinned.

## Stable writer identity

`server_id` is per **database**, not per token. `writer_id = <server_id>/<label>`. A token that is
renamed is a new writer; two tokens with one label are one writer. The id's job is the other half:
two servers with a token called `phone` are different writers, and a rule or a filter can say which.

Restoring a backup of the database **file** keeps the `server_id` (it is in the file). Importing an
export into a fresh database does not: the new database mints its own.

## Signed writer attestations

When notes move between servers (export, then import), the importer stamps every note with the
importing admin and keeps the payload's `written_by` only as a claim (`imported_written_by`). That is
safe, and it loses the information. An attestation brings it back **for servers you chose to trust**.

### How it works

- Each database has one Ed25519 key pair. The private key is the file `.attest-key` beside the
  database (mode 0600, re-tightened at every start, created on the first note write (1.5.0: it signs the audit log),
  the first signed export or `monomem trust identity`, written atomically; `MONOMEM_ATTEST_KEY_FILE` overrides the path).
  It is **never** exported or sent anywhere. `monomem trust list` never creates one. A corrupt key
  file is an error, never silently replaced by a new identity, and it does not break an import of
  unsigned notes. (Two databases in one directory share a key file; use one directory per database.)
- `GET /export?attest=1` and `monomem export --format json --attest` write a header
  (`"export": {format, format_version, server_id, key_id, public_key, algorithm}`) and, on every
  note, a detached `attestation`. **The default export is the plain shape**: `{"notes": [...]}`
  with no header and no signatures (an early release added them by default and was changed back, because a plain
  backup consumer expects the old shape). `/import` and `import --file` accept the plain object, the
  attested envelope and a bare array alike.
- The signature (version 2) covers `{server_id, exported_at, note id, namespace, content hash,
  written_by, created_by, updated_at, created_at, source, expires_at, archived_at, rev,
  attested_writer, attested_by, merged_from_writers}`; the content hash is a SHA-256 of the title,
  body and sorted tags. Version 1 attestations (from early exports) still verify, but they do not
  cover `created_at`, `source`, `expires_at`, `archived_at` or `rev`, and they carry no signed export
  time, so a key with a `not_after` rejects them. If the key cannot be created (read-only directory)
  the export is still written, without signatures.
- On import, each attestation is checked against the **trust list**: public keys an admin added
  (`trust attester-add`) plus `MONOMEM_TRUSTED_ATTESTERS`. **A key is pinned to one `server_id`.**
  Without the pin a trusted key could claim to be any server (including a peer you pinned another key
  for), so `attester-add` needs `--server-id`, and an unpinned entry needs the explicit `--any-server`
  (it is flagged `unpinned` in every listing and in the audit log). Even an unpinned key cannot claim
  this database's own server id. A server's own key is trusted for its own server id only. An entry (or env
  entry) naming **this** server's id is accepted when it is a *retired own key*; the current key cannot be
  added, it is already trusted. `MONOMEM_TRUSTED_ATTESTERS` and `attester-add` follow the same rules.
- **Expiry is not revocation.** `--not-after <ISO time>` ends trust in a key **at that time**. It is judged
  against the **time of verification**, not the date an export claims: once the date has passed, the key is
  not believed for anything, old exports included, so an import done today rejects everything that key signed, whatever date the file claims
  (a v1 attestation has no signed export time, so it is rejected too). But before that date a key whose
  holder has misbehaved is still believed. For a planned rotation do not set `--not-after` on the old key (`trust rotate` keeps it trusted without one). To stop trusting a key **now**, use `trust attester-revoke
  <key-id>` (a list kept in the database that wins over every other source, including
  `MONOMEM_TRUSTED_ATTESTERS`; `attester-unrevoke` lifts it). Notes already imported keep their
  recorded provenance either way.
- **Minimum version.** `MONOMEM_ATTEST_MIN_VERSION=2` refuses version 1 attestations (the first format,
  which does not cover `created_at`, `source`, `expires_at`, `archived_at` or `rev`).
- **Imported without a verified attestation.** A note that arrived without a verifiable attestation is
  marked `imported_unverified: true` (shown in reads and in the provenance banner an agent sees). The
  default still imports such notes, so backups and plain exports keep working. To refuse them instead, use
  `monomem import --file x --require-attestation`, `POST /import` with `require_attestation: true`, or
  `MONOMEM_IMPORT_REQUIRE_ATTESTATION=1`; they land in the report's `rejected` list.
- **Verified**: the note keeps the original `written_by` in `attested_writer` and the attester's id in
  `attested_by`; the stamped `written_by`/`created_by` is still the importing admin. The attester's own
  earlier hops are kept in the taint set, so distrust follows the content through a chain of servers.
- **Not verified** (no attestation, a key nobody trusted, a server id that does not match the pinned
  one, an expired key, a malformed `server_id`, or a signature that does not match): the note is
  imported with the importing admin as writer, and the file's claims recorded in `imported_written_by`
  and **added to the taint set** (so a distrust rule on the claimed name still hides the note).
- The import result reports `attestations: {verified, unverified, reasons, untrusted_keys}` whenever a
  note carried an attestation (REST `POST /import`, CLI `import --file`, the dashboard). An imported
  backup without attestations keeps the old, unchanged response. `untrusted_keys` lists keys seen but
  not trusted, so a person can decide to `trust attester-add` one. The CLI prints only sanitised
  text from the file (control characters and escape sequences are removed) and never splices file
  text into a suggested command.
- A later content edit of an imported note clears `attested_writer` as the writer of record (the
  editor is the writer now) but moves it into the taint set; tag changes keep it.

Tampering with the **content** (title, body, tags), the **writer** (`written_by`, `created_by`), the
**namespace**, `updated_at`, `created_at`, `source`, `expires_at`, `archived_at`, `rev`, the note id,
the export time or the attestation itself makes the signature fail, and the note is imported as
unverified. Each of these has its own test (`test/trust-attest.test.ts`, `test/trust-141.test.ts`). A
signed note cannot be moved into another namespace either: a namespace-pinned import rewrites the
namespace, which breaks the signature.

### What an attestation proves, and what it does not

It **proves**: a key you trust signed exactly this record, so the content, the namespace and the writer
labels were not altered after that server exported them.

It does **not** prove:

- that the content is true, safe, or not an injection: a trusted server can export a hostile note;
- that the exporting server's operators labelled honestly: the label is whatever that server's tokens
  were called, and anyone with that server's admin access can mint any label;
- that the note is *current*: an old export is still validly signed, and replaying it gives the old
  version. `not_after` retires a whole key from a date on; there is no per-note revocation or
  freshness;
- anything about a key nobody added to the trust list;
- who the key belongs to: the trust list is a decision a person makes; `trust identity` prints a
  server's key so it can be checked out of band.

Anyone who can read the signing key can sign anything as that server: protect `.attest-key` like the
at-rest encryption key (do not put the data directory in a synced folder). If it leaks, set
`trust attester-revoke` on its key in every trust list, then `monomem trust rotate`. Rotation takes
effect **in a running server** (no restart: the key file is re-checked on every use). The old public key
is recorded as a *retired key of this server*, so notes this server exported earlier still verify when they
come back; the old private key is not kept unless you pass `--keep-old-private` (then it is written as `.attest-key.<old key id>.old` next to
the key file, mode 0600). The new key has a new `key_id`, the same `server_id`.

### Setting it up between two servers

```
# on server A
monomem trust identity                     # prints server_id, key_id, public_key
# on server B, once, after checking the key with A's admin
monomem trust attester-add --public-key <public_key> --server-id <A's server_id> --label "server a"
# move notes
monomem export --format json --attest --out a.json   # on A
monomem import --file a.json                          # on B  (or POST /import)
```

The same pair as an environment variable on B: `MONOMEM_TRUSTED_ATTESTERS=<A's server_id>=<public_key>`
(a bare key is refused and logged: it would be a key with no pin).

### Keys, backups and restores

- `monomem backup` leaves `.attest-key` out by default and says so; `--include-attest-key` copies it
  (mode 0600) like `--include-approval-key` does. Guard such a backup like the encryption key.
- Restoring a database **file** keeps `server_id` but, without the key, the new machine makes a **new**
  key. The warning "restored without its key" is printed only when the database remembers a previous key
  (`_meta.attest_key_id`) that no longer matches: peers must add its public key. To trust your own earlier
  exports again after such a restore, run `trust attester-add --server-id <this server's id> <old public key>`
  (or put the entry in `MONOMEM_TRUSTED_ATTESTERS`). To keep
  the identity, restore the key too (`trust export-key --out <file>` writes a 0600 copy to keep
  somewhere safe). `export-key` refuses to write through an existing file or a symlink (also a dangling one).
- A restored database that imports its **own** earlier export verifies it with its own key, for its
  own server id only.

## Signed audit log and write receipts (1.5.0)

The same `.attest-key` signs the audit log and the write receipts. There is no second key and no second rotation command.

- **Each audit line** carries `kid` and `sig`: an Ed25519 signature over the line, which includes `prev`, the hash of the
  line before it. The first signed line of a log is `sign-start` (it names the public key and the head of the unsigned
  lines before it). `trust rotate` first writes a `key-rotate` line signed by the old key that names the new public key;
  the next lines are signed by the new key. A line signed by a retired key, or by a key no `key-rotate` line handed over
  to, is a bad signature. A process that cannot read the key writes an unsigned line, as before 1.5.0.
- **Each write receipt** (accepted, held or refused, from MCP `state_write` and REST `POST`/`PUT /notes`, same shape on
  both) is signed too and carries `note_id`, `rev` and `content_hash` (the hash of the exact title, body and tags). The
  content hash is only in the receipt, never in the log.
- **Check a receipt offline** with only the public key: `monomem verify-receipt --file r.json --pubkey <key or file>`, or
  without Monomem: `node verify-receipt.mjs r.json <key>` (the 30-line script is
  [docs/verify-receipt.mjs](https://github.com/calasdan-sketch/monomem/blob/main/docs/verify-receipt.mjs), plain
  `node:crypto`). `monomem trust identity` prints the public key; keep a copy of it with the receipts. A receipt signed
  before a rotation verifies with the old public key (`monomem trust list` shows it as a retired key of this server).
- **Against the log:** `monomem verify-receipt --file r.json` (no `--pubkey`) also checks the line is still in the
  unbroken, signed log. `--note <id>` prints "unchanged since the receipt" or "changed later (rev N)".
- **Checkpoints:** `monomem audit checkpoint --out cp.json` signs the current head. Keep it off the machine (a git commit, a
  password manager, an email to yourself) and check later with `monomem audit verify --checkpoint cp.json`. Every receipt
  you hold works as a checkpoint too.
- `monomem audit verify` reports signed lines, bad signatures and unsigned lines before and after signing began.
  `--all-signatures` checks every line (about 0.1 ms each); by default it checks the newest line, the anchor and the key
  hand-overs, because the newest signature covers everything before it through `prev`. `--strict` fails on unsigned
  lines after signing began.

**What it proves and what it does not.** Anything before a receipt or checkpoint someone holds cannot later be edited
or removed undetected, even by someone with the key, and a process that can write `audit.log` but cannot read
`.attest-key` cannot forge or edit a line. It does **not** protect against you or anything running as you: a program
running as the store's user can read `.attest-key`, then rewrite and re-sign everything after the last receipt or
checkpoint someone else holds, or cut the newest lines off (the shorter log still verifies). It does not prove the content
is true or who a stdio writer was. The full list is in SECURITY.md.

## Upgrading and rolling back

The step-by-step version is [upgrading.md](./upgrading.md). In short:


Schema v14 adds columns and three small tables; no note text is touched. The first time a database at
v1 to v13 is opened by an early release of this line, Monomem writes a consistent snapshot to
`<database>.pre-v18-backup.<pid><random>.partial`, **checks it** (non-empty, the old schema version, the same
number of notes as the database, an integrity check) and only then renames it to `<database>.pre-v18-backup`.
A crash leaves a `.partial` file (swept at the next upgrade), never a half-written backup under the real name.
A valid copy already there is kept when it holds the same notes, otherwise it is moved to a dated name; an
empty or garbage one is replaced, and one that merely cannot be read is moved aside, never deleted. The upgrade
**refuses to run** when the copy cannot be made (for example no room on the disk): it stops with an error and
the database is untouched; `MONOMEM_SKIP_PREMIGRATION_BACKUP=1` upgrades without a copy. The upgrade runs in one transaction. `monomem doctor` lists the copies with size and age. To roll back:
stop every monomem process, **move** the backup file over the database (remove its `-wal` / `-shm`
files; a copy would leave the original), install the older version. Writes made after the upgrade are
not in the backup. When you are happy: `monomem backup --prune-premigration`. If you later turn on
at-rest encryption (`monomem encrypt enable`), those copies are still **plaintext**: it tells you to
prune them. `monomem recall` never upgrades a database.

Runners from an early release write a heartbeat with no writer marker, which Monomem no longer believes: see
[RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md) for the one-step upgrade (or `MONOMEM_RUNNER_ACCEPT_LEGACY=1` as a stopgap).

## Limits

- It is a **policy on labels**, not a security boundary against the operator. Anyone with the database
  file, or an admin token, can change the list, the notes and the audit trail.
- Two tokens that share a label are one writer; distrusting the label distrusts both.
- A hostile writer who can obtain a *new* token under a *new* label is not on the list. The list is a
  response, not a gate. Keep one label per client, and review what new labels write.
- Unknown writers (`written_by` of `""`: rows from before schema v13) are never matched by
  `not_written_by` or by a rule, because nobody can say who they were.
- File sync carries the writer in front matter as `origin_writer`, an unverified claim: an imported file
  is stamped with whoever imports it, the claim is shown as `imported_written_by`, and it is added to
  the taint set. **A file that simply omits every writer field carries no taint**: an unsigned file
  cannot prove who wrote it; only a verified attestation can.
- A file whose `origin` is another store (a note written on another machine) is also flagged
  `imported_unverified` when it creates or updates a note, so `why` and the provenance banner say it came in
  without a verified attestation. In an approve-first namespace such a create or update goes to quarantine, as
  an agent's write would, and is not live until approved. Approving it applies it as the approver (`cli`); the
  approved note does not carry the `imported_unverified` flag. Files this store wrote itself merge as before.
- Taint stays with the note when an admin **moves it to another namespace**: a rule in the new namespace
  matches the same names, a rule only in the old one no longer applies.
- The taint set is capped (200 names per note, on import and on edit; names that match a rule are kept first), and a rule list is bounded (50 per namespace).
- Performance: with rules, `list`/`changes` evaluate the policy per row, with one `json_each` membership test
  over the taint set (an earlier version ran one `instr` probe per label). Measured on 100,000 notes that each carry a
  30-name taint set (median of 7, first page of `list`, before -> after that change): no rules 0.17 s -> 0.17 s, 10 `*` rules
  1.31 s -> 1.09 s, 100 `*` rules 10.9 s -> 1.06 s; `/changes` with 100 rules 11.2 s -> 0.96 s. Cost grows with
  the number of notes scanned times the taint-set size, not with the number of rules. Typical deployments have a
  handful of rules and empty taint sets. Numbers from one Linux machine; yours will differ.
- The unverified `imported_written_by` and `source` are claims; the "WHO WROTE THIS" block labels them so.
