# Security & Threat Model — Monomem

Monomem is a note store exposed over MCP + HTTP. **Treat all stored
content as untrusted input to your agents** — see "Memory safety" below.

Monomem was renamed from OneMemory. Version numbers in this file that say OneMemory belong to the old name and its
numbering (1.x and 2.x); Monomem restarted at 1.0.0 (see [CHANGELOG.md](./CHANGELOG.md)).

To check your own setup, run `monomem drill` (replays 20 known memory-poisoning attacks on a copy of your store) and
`monomem health` (turns that and your security settings into one A to F grade, with the rule printed).

## Controls

- **Network:** binds `127.0.0.1` by default. Public exposure is opt-in
  (`MONOMEM_BIND`) and the server **refuses to start** on a non-loopback
  address unless you set an explicit `MONOMEM_TOKEN`. Public deployments
  are expected to sit behind an authenticated tunnel (e.g. Cloudflare Tunnel +
  Cloudflare Access). The **Origin** header is validated (DNS-rebinding
  defense); browser origins are blocked unless listed in
  `MONOMEM_ALLOWED_ORIGINS`.
- **Auth:** a bearer token is required on every route except `/health` and
  `/ready`, and the static pages `/`, `/ui`, `/dashboard.js` and `/favicon.ico`, which hold no notes. Each token is compared in constant time (a minor side-channel on
  token length/count is not fully eliminated, which is immaterial for the
  high-entropy tokens this uses behind a tunnel). Tokens are never placed in
  URLs and are never logged. The primary token file is created `0600` and is
  git-ignored. The `0600` mode applies on POSIX systems; on Windows (NTFS) it has no effect, so rely on the folder
  permissions of your user profile.
- **Scoped tokens:** besides the primary (admin) token, you can define extra
  `read` / `write` / `admin` tokens via `MONOMEM_TOKENS` (a JSON array)
  or a `~/.monomem/tokens.json` file, so a leaked read-only token can't write, delete
  or dump the store. Scopes are enforced identically on the REST API and the
  MCP tools; `/export` (a full-store dump), `/import` and all deletes require
  `admin`. If you use `~/.monomem/tokens.json`, it is re-`chmod`ed `600` on every start (POSIX) — it holds credentials
  and the app reads but does not set its permissions.
- **Rate limiting:** per-client fixed-window limiter (defaults configurable via
  `MONOMEM_RATE_MAX` / `MONOMEM_RATE_WINDOW_MS`) so a leaked token
  can't be brute-forced or hammered. Over-limit requests get `429`. The bucket is the
  socket address; with `MONOMEM_TRUST_PROXY=1` it is the rightmost `X-Forwarded-For`
  entry (the one your proxy appended, which a client cannot forge), or with
  `MONOMEM_TRUST_PROXY_HOPS=N` the Nth entry from the right (the leftmost one if
  there are fewer); with `MONOMEM_TRUST_CLOUDFLARE=1` it is `CF-Connecting-IP`.
- **Input validation:** per-note size caps (title/body/tags), a 1MB request
  body cap, and all values are bound as parameters; SQL text is
  built only from internal identifiers.
- **Secret guard:** writes are scanned for high-confidence credentials (AWS
  keys, private-key blocks, provider API tokens, etc.) and **rejected** by
  default (`MONOMEM_LINT`), since a memory store is where secrets get pasted
  by accident.
- **Audit log:** an append-only log records every mutation (op, id, namespace,
  byte count) — **no note content and no secrets** are logged. Archive, restore and the expiry and decay sweeps are
  logged from inside the store, so every path (MCP, REST, CLI, background sweep) writes a line. Each line carries
  `prev`, the sha256 of the line before it (carried across rotation), and `monomem audit verify` walks the chain and
  counts every break. Several apps append to one log, so two can race and one line then names an earlier line as its
  `prev`; verify counts that as a fork, not a break, and keeps going. This is **tamper-evident, not
  tamper-proof**: it detects lines edited or removed *inside* the chain. A forged line inserted with a valid `prev`
  also looks like a fork, and after a real race the line nobody points to can be edited or removed unseen; forks are
  reported, so a count you did not expect is worth a look. The hashes are not keyed, so any program
  running as you with a shell or file access (including an agent with a shell tool) can rewrite the whole chain or cut
  off its newest lines, and deleting rotated files is not detected. `audit verify` prints the head hash: note it
  somewhere else to catch a later rewrite. Lines written before this was added have no `prev` and are counted as
  unchained. Archive through MCP `state_delete` currently writes two lines (one from the store, one
  from the tool, which names the caller).
- **Supply chain:** committed lockfile + `npm ci`, Dependabot, `npm audit` in
  CI, and MIT-licensed with only two production dependencies.

## Threat model (short)

- **Assets:** note bodies, and the bearer tokens.
- **Attackers considered:** someone who obtained a token (leak, shared
  device); malicious text inside a note (stored prompt injection); a person
  who steals a disk image or backup.
- **Trusted:** the CLI and the stdio MCP transport run with full local trust
  and use no token. Anyone with shell access to the machine and its data
  directory owns the store. Since OneMemory 1.1.0 the *agent* on the stdio connection
  does not inherit all of that: its `state_delete` archives instead of
  erasing, and the operator-only tools (`memory_quarantine`, `trust_policy`,
  `memory_history_purge`, `memory_consolidate`, `task_approve`), the
  `include_distrusted` flag and `task_put` with `approve: true` are off for
  it unless the operator sets `MONOMEM_STDIO_ADMIN_TOOLS=1`.
- **Not covered:** a live attacker holding a valid admin token; an attacker
  who can read both the database and the key file; prompt injection is
  mitigated, not eliminated (OWASP GenAI #1); there is no OAuth, only static
  bearer tokens.

## Writer trust (OneMemory 1.4.0, hardened in 1.4.1)

A note's `written_by` is stamped by the server from the authenticated token for REST and MCP-over-HTTP callers (for a
local stdio app it is a label from that app's config, `MONOMEM_CLIENT`, which is not authenticated); an admin can put a writer on a
per-namespace distrust list that every read path honours (through one gate, with a guard test), and a JSON export
made with `--attest` / `?attest=1` carries Ed25519 attestations so a server you chose to trust can vouch for a
note's original author. Read [docs/trust.md](./docs/trust.md) for exactly what this proves and does not.

- A distrusted writer's content **stays hidden** after anyone else edits it (the taint set only grows); only the
  admin lifting the rule shows it again. `include_distrusted` is admin-only on every surface.
- A trusted key is **pinned to one `server_id`** (an unpinned key needs an explicit `--any-server`), can carry a
  `not_after`, and is rotated with `monomem trust rotate`. Version-2 attestations also sign `created_at`,
  `source`, `expires_at`, `archived_at`, `rev` and the export time.
- **Replay:** an old export stays validly signed. Replaying it into a server that trusts the key restores the old
  content (with its old provenance); `not_after` retires a whole key, but there is no per-note freshness.
  Import only files you hold, and treat `exported_at` as the signer's claim of when it exported.
- `.attest-key` is the identity: protect it like the encryption key and **do not keep the data directory in a
  synced folder** (Dropbox, iCloud, OneDrive copy it to every device). It is re-tightened to 0600 at every start and
  left out of `monomem backup` unless you pass `--include-attest-key`.
- It is a policy on labels, not protection against the operator; a trusted server can still export a hostile
  note; and a writer who obtains a new token under a new label is not on the list.
- Heartbeats from runners older than OneMemory 1.3.4 are no longer believed by default (`MONOMEM_RUNNER_ACCEPT_LEGACY=1`
  restores the old behaviour). A heartbeat counts only if the runner process wrote it and its own `alive_at` agrees
  with the server's clock within two minutes, so a tag-only touch of an old heartbeat does not make it fresh.
- **Replacing a note (OneMemory 1.6.0)** is two steps: a preview that changes nothing, then a confirm that needs the preview's one-time
  code. The code is signed with a key kept in the database, expires (default 10 minutes), works once, is bound to the caller
  (writer, scope, tenant), to the exact notes and revisions previewed and to the exact replacement text, and a wrong code gets
  one generic message. A distrusted writer, or a replacement that claims lower confidence, needs an administrator and an explicit
  `acknowledge_risk`. Nothing is deleted and undo is recorded. **Limit:** over MCP and REST an agent stands between you and the
  warning; the tool descriptions tell it to show the full warning and wait for you, and the code makes it impossible to confirm
  without a preview, but a careless or manipulated agent could still confirm on its own. The command line asks you at your own
  keyboard and is the strongest gate.
- **Version history (OneMemory 1.6.0)** keeps the text an edit replaces, so it can hold text someone removed on purpose. It is administrators-only,
  bounded per note, encrypted at rest when encryption is on (plaintext otherwise, like note bodies), included in `export` unless
  `?history=0` / `--no-history`, and removable with `history purge`. Treat an export that carries history like the database.
- Pre-upgrade copies (`<db>.pre-v16-backup`) are plaintext snapshots: remove them
  (`monomem backup --prune-premigration`) once the upgrade is checked, especially before enabling encryption.

## Encryption at rest (shipped in OneMemory 1.2.0)

`monomem encrypt enable` encrypts note **bodies** with AES-256-GCM. The
limits, stated plainly:

- **Titles, tags, timestamps and the writer (`written_by` / `created_by`,
  the token label that wrote a note) stay plaintext.** Search and namespace
  isolation need them. Keyword search covers title + tags only while
  encryption is on.
- **Embeddings bypass encryption.** If you enable semantic search, the
  decrypted body is sent to your `MONOMEM_EMBED_URL` endpoint, and the
  resulting vectors are stored unencrypted (vectors can leak information
  about the text). Leave embeddings off if that matters.
- **The key sits beside the database** (`~/.monomem/.key`, mode `0600`, or
  `MONOMEM_KEY_FILE`). A backup of the whole data directory contains both,
  so encryption protects against a stolen database file or a backup of the
  database alone, not against someone who gets the whole directory. There is
  no re-key command.
- **Binding of ciphertext to its row (AAD):** OneMemory 1.2.0 did not bind a body's
  ciphertext to its note id and namespace, so someone who could write to the
  SQLite file could copy ciphertext between rows. OneMemory 1.2.1 addresses this (see
  the CHANGELOG; confirm for the version you run).
- Quarantined (linter-held) writes are sealed too in OneMemory 1.2.1; in 1.2.0 they
  were stored in plaintext.
- `GET /export` returns decrypted bodies, so treat exports as sensitive.
- Details: [docs/encryption-retention.md](./docs/encryption-retention.md).

## Namespaces and tokens

- Besides the primary admin token you can define `read` / `write` / `admin`
  tokens. A token can also be **pinned to one namespace**; a pinned token
  (even an admin one) cannot read or write another namespace. See
  [docs/token-namespaces.md](./docs/token-namespaces.md).
- Rotate by setting a new `MONOMEM_TOKEN` or deleting
  `~/.monomem/.token`; a leaked token works until you do. Changing the main
  token does not touch the app tokens in `tokens.json`: a leaked admin token
  may have been used to make more of them, so also run `monomem token list`
  and remove every entry you do not recognise (`monomem token remove <name>`).
  Every token made or removed through `monomem token` or `/tokens` is written
  to the audit log (`token.add` / `token.remove`, with the caller's label and
  the new token's name, scope, namespace and limit, never the token itself),
  and so is every export (`export`).
- Over REST, `POST /tokens` needs an admin token with no sensitivity limit and
  no namespace pin; making an app with `admin: true` or `no_limit: true` there
  further needs the main (`primary`) token, and any other caller gets `403`.
  The CLI (`monomem token add --admin` / `--no-limit`) is unchanged.

## Memory safety

A note store whose contents are read back by autonomous agents is a **stored
prompt-injection / "memory poisoning"** channel. Layers:

- **Write-time linter:** secrets (API keys, private keys, JWTs,
  high-entropy tokens) are blocked; prompt-injection phrasing is
  **quarantined**, invisible to search and recall until an admin approves it
  (`monomem quarantine`). It is a pattern linter: it will miss novel
  phrasing and can flag harmless text. It matches patterns, so a reworded attack passes (`monomem drill` lists this as a
  known miss). Text written in invisible Unicode tag characters is decoded and scanned, and any such character
  is flagged, as is a run of four or more variation selectors (the England, Scotland and Wales flag emoji are
  exempt). The `source` field is not scanned; tag characters are removed from it when it is stored. See
  [docs/memory-linter.md](./docs/memory-linter.md).
- **Untrusted-data banner on every MCP read** (and `monomem recall`).
  REST responses do not carry it; REST callers must apply the same rule.
- **SKILL.md** tells agents to treat note content as data, never as
  instructions. If you integrate the tools yourself, enforce the same rule.

## Write controls and their limits

These protect memory from agents that reach it through MCP or REST. **An agent with a shell tool can run the `monomem`
CLI itself, so none of them stops an agent that can run commands.**

- **Operator gate on the CLI.** These commands lower protection, so they refuse to run unless both standard input and
  output are a terminal, and then ask for a typed `yes`; there is no `--yes` for them: `unpin`, `approve-first <ns> off`, `approve-first --all off`,
  `resume`, `quarantine approve`, `trust undistrust`, `trust attester-add`, `trust attester-unrevoke` and `token add`. The same gate applies to a **pinned** note: `archive`, `restore`, `delete` (with or
  without `--yes`), `supersede` (its `--old` notes and `supersede undo`) and `history restore` / `history purge` on a note you
  pinned need the terminal and the typed `yes`. Also gated: `merge --yes` when any note in a group is pinned. Not gated, even on pinned notes: `rollback`, `decay --purge`, `import`,
  and anything that calls the library directly (the gate is in the CLI, not the store).
  Raising protection (`pin`, `approve-first on`, `trust distrust`, `token remove`) stays scriptable. This raises the bar
  against an agent that runs the CLI through a non-interactive shell tool (it gets a clear refusal and nothing changes).
  It is **not a guarantee**: a tool that allocates a pseudo-terminal can pass the terminal check and type the word, and
  an agent that can edit the database file or `tokens.json` directly does not need the CLI at all. Other CLI commands are
  not gated, including ones that weaken protection (`encrypt disable`) or destroy data (`delete --yes` on a note that is not pinned).
- **Approve-first namespaces** (`monomem approve-first`): writes that do not come from the local CLI are held in the
  quarantine queue until approved. An admin REST token is treated like any other REST caller, so it is held too.
- **Pinned notes** (`monomem pin`): only the CLI can edit, forget, restore, replace or delete them, and the CLI asks for the terminal and a typed `yes` first (see the operator gate above). An admin token can
  unpin a note over REST and then change it.
- **Flood guard**: a writer label that makes too many writes in an hour is paused until `monomem resume`. The label is
  self-declared, so this stops runaway loops, not a hostile app that changes its label.
- **Rollback by writer** (`monomem rollback`): undoes what one writer label created or changed; it does not undo tag
  edits, archives, replacements or deletes, and it relies on the same self-declared label.
- **Read access log** (`monomem access`): records which writer read what (query preview, counts, no note text), kept
  30 days by default.

### Closing the shell gap, strongest first

None of the controls above stops an agent that can run commands as you. These do, to different degrees:

1. **A separate OS user owns the data (the real boundary).** Create a second account, give it the data folder
   (`MONOMEM_HOME`) with permissions only it can read, run `monomem start` as that account, and connect your agents
   over REST with their own tokens. An agent running as you can then neither open the database file nor run the CLI
   against it. Limits: stdio MCP does not work this way (the app starts the server as you, so it needs the files);
   an **admin** token can still unpin notes over REST, so give agents ordinary tokens; and anyone with administrator
   rights on the machine can still read the folder. We have not yet written up a tested step-by-step for Windows, macOS
   and Linux; until then, treat this as the approach, not a recipe.
2. **A container or devcontainer** for the agent, with the data folder not mounted and the server reachable only over
   REST. Same limits as 1, and only as strong as the container setup.
3. **Permission rules in the agent (a speed bump, not a boundary).** For Claude Code, in `~/.claude/settings.json`:

   ```json
   { "permissions": { "deny": [
     "Bash(monomem *)", "Bash(npx monomem *)", "Bash(npx -y monomem *)",
     "Read(~/.monomem/**)", "Edit(~/.monomem/**)"
   ] } }
   ```

   This stops the obvious commands. It does **not** stop a determined agent: `node <path>/cli.js`, `sqlite3`,
   `python -c`, `sh -c "monomem ..."`, `cmd /c monomem` or `cat` through a shell all get past prefix rules, and the
   rules only cover Claude Code. It also blocks you from asking Claude to run `monomem doctor` for you. It does not
   affect Monomem's own hooks or MCP server, which Claude Code starts directly rather than through its shell tool.
   Use your own data folder path if you set `MONOMEM_HOME`.

## Limitations (stated honestly)

- Single-user, single-node SQLite. No clustering, no multi-tenant isolation
  beyond namespaces on one process.
- Note history is bounded, not unlimited: `MONOMEM_HISTORY_VERSIONS` earlier
  versions per note (default 20, at most 500; **`0` keeps none at all, the
  original included**) and `MONOMEM_HISTORY_MAX_BYTES` of earlier text per
  note (default 2,000,000; 10,000 to 50,000,000). While history is on,
  pruning never drops the oldest kept version. Older versions beyond those
  limits are gone and cannot be restored, and an explicit purge
  (`monomem history purge`, `memory_history_purge`,
  `DELETE /notes/:id/history`) deletes **every** kept version, original
  included.
- The similarity-edge graph rebuild is O(n^2); large imports defer it.
- Keyword extraction for recall is English-oriented.
- Requires Node.js 22.16+ (built-in `node:sqlite`; added in 22.5.0 but behind `--experimental-sqlite` until 22.16.0).
- **Restore into an empty store.** `POST /import` does not de-duplicate:
  importing a backup into a store that already holds those notes creates
  duplicates.
- Rate limiting is per client address and runs before authentication;
  behind a shared tunnel, clients share a bucket.
- The audit log records operations, never note content. A failed audit write never fails the request: it is counted (`audit_failures` in `GET /stats`, a warning in `monomem health`) and the first failure, then every 1000th, is printed to stderr.
- **Dispute notices are a nuisance vector.** Any writer that can write a fact can make
  Monomem print "writers disagree on <key>" at the start of sessions in that namespace. The
  notice never shows a fact value that the injection or directive scan, or the fact-value
  check, flags (it prints "[value withheld: flagged, see monomem conflicts]"), but it can
  still be triggered with a harmless-looking value. Distrusting the writer
  (`monomem trust distrust <writer>`) removes it from the notice.
- Encryption limits are listed above.

## Your data

- **Stored on your computer:** your notes; the read access log (which writer read what, kept 30 days by default, with
  query previews that have secrets redacted and no note text); the audit log of operations (never note content); and
  memory receipts (which notes a session start showed, by id and reason).
- **Nothing is sent to Calas.** Monomem has no telemetry and, by default, makes no network calls. The only outside
  connections are ones you configure: an optional summarizer model, and optional embeddings (`MONOMEM_EMBED_URL`, which
  can be a remote host if you point it there).
- If a team runs Monomem on staff computers, the team is responsible for those records: who may read the access log
  and audit log, how long they are kept, and what staff are told.

## Reporting a vulnerability

Email **office@calasautomations.com**, or open a private security advisory on the GitHub repository
(github.com/calasdan-sketch/monomem, Security tab, "Report a vulnerability"). We reply within 7 days and coordinate
disclosure within 90 days. Please do not file public issues for security reports.


## Not done yet (roadmap)

These are known gaps, written down so nobody assumes they are covered:

- **Keys are stored as they are.** Tokens in `tokens.json` and the main token file are kept in plain text (mode 0600), not as one-way hashes. Anyone who can read your data folder can use them. Hashing them is planned; until then protect the folder.
- **No key rotation for at-rest encryption.** `monomem encrypt` uses one key. Changing it means decrypting and re-encrypting by hand (export, new store, import).
- **A backup does not carry the encryption key by default** (`monomem backup --include-key` does copy it). Keep your own copy of the key somewhere separate.
- **Host check is a second layer, not a wall.** A request under an unexpected host name is refused (see `MONOMEM_ALLOWED_HOSTS`), but a request through a proxy or tunnel is let through that check and still needs a valid key.
