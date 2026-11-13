# Configuration

All environment variables are optional. This table lists **every** `MONOMEM_*` variable the code reads (a test fails when one is missing):

| Variable | Default | Purpose |
|---|---|---|
| `MONOMEM_HOME` | `~/.monomem` (Windows `%USERPROFILE%\.monomem`) | Data directory: database, `.token`, `tokens.json`, `spaces.json`. A git checkout that already has `./data/state.db` keeps using `./data`. 1.0.x data found inside the package is copied here once on start. Created owner-only (`0700`, files `0600`) on POSIX and re-tightened on every start |
| `MONOMEM_DB_PATH` | `<data dir>/state.db` | SQLite file path (overrides the data dir for the database only) |
| `MONOMEM_WAIT_POLL_MS` | `1000` | Live wait (`wait` / `wait_seconds`): how often a parked request checks for writes made by another process. Same-process writes wake it immediately. 20-60000 |
| `MONOMEM_WAIT_MAX_PER_TOKEN` | `16` | Live wait: max parked requests per token (more: REST 429 / MCP tool error that names the limit) |
| `MONOMEM_WAIT_MAX_PER_NAMESPACE` | `32` | Live wait: max parked requests per namespace scope, across all tokens |
| `MONOMEM_WAIT_MAX_TOTAL` | `64` | Live wait: max parked requests per process |
| `MONOMEM_AUDIT_LOG` | `<data dir>/audit.log` | Audit log path (create/update/delete, task / handoff / catch_up / approve entries with the token label and kind; never note text or tokens) |
| `MONOMEM_AUDIT_MAX_BYTES` | `5000000` | Rotate audit.log when it reaches this size (`0` = never) |
| `MONOMEM_AUDIT_KEEP` | `5` | Rotated audit files kept (`audit.log.1` ... `.N`) |
| `MONOMEM_ACCESS_LOG_DAYS` | `30` | Days the read access log is kept (who read memory, with which tool, a redacted 120-character query preview and a result count; never note text). `0` = nothing is logged and the next hourly sweep empties it. See [access-log.md](./access-log.md) |
| `MONOMEM_FLOOD_WRITES_PER_HOUR` | `500` | Flood guard: a writer label that makes this many counted creates/updates in a rolling hour is paused (its writes are refused) until `monomem resume <label>`. `0` = off. See [access-log.md](./access-log.md) |
| `MONOMEM_RUNNER_TASK_NAMESPACE` | unset | Runner and server: namespace whose admin-approved command tasks the runner executes. Unset = command tasks off. See [RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md) |
| `MONOMEM_RUNNER_STALE_SECONDS` | `600` (30 s - 7 d) | API/MCP/CLI side: heartbeat age after which `runner_status` calls the runner stale. Never less than three of the runner's own beat intervals (the heartbeat publishes its interval), so a slow beat cannot read as permanently offline. See [RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md) |
| `MONOMEM_APPROVAL_TTL_SECONDS` | `86400` (60 s - 30 d) | How long an admin approval of a command task stays valid before it expires and needs approving again |
| `MONOMEM_RUNNER_ID` | `COMPUTERNAME`, else `HOSTNAME`, else `default` | The runner's machine name (the runner's own heartbeat wins). Server side: fallback for the name when no heartbeat has been seen. Counted commands are the ones whose `target` is this name. Note: `COMPUTERNAME` is set on Windows and `HOSTNAME` is usually **not exported** by Linux/macOS shells, so on those set `MONOMEM_RUNNER_ID` explicitly or the name is `default` |
| `MONOMEM_RUNNER_ACCEPT_LEGACY` | unset | Server side: `1` = also believe runner heartbeats with no writer marker (runners older than 1.3.4). Default off since 1.4.0; a stopgap until the runners are updated. See [RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md) |
| `MONOMEM_TRUSTED_ATTESTERS` | unset | Export signers whose note attestations an import believes. Either comma/space/newline separated `<server_id>=<public key>` entries (the server id is a UUID, the key 43 characters of base64url), or a JSON array `[{"public_key":"<key>","server_id":"<uuid>","label":"text"}]`. **A bare public key is not accepted**: a key must be pinned to the one server it speaks for. The server logs a loud warning (once) naming every entry it ignored, and when the variable yields nothing at all. Merged with the list an admin keeps in the database (`monomem trust attester-add --server-id ...`). A server's own current key is always trusted for its own server id only; an entry naming **this** server's id is a *retired own key* (see `trust rotate`), exactly like `attester-add` with this server's id. Keys on the revocation list (`trust attester-revoke`) are ignored here too. **EXPERIMENTAL.** See [trust.md](./trust.md) |
| `MONOMEM_ATTEST_KEY_FILE` | `<db dir>/.attest-key` | Where the database's Ed25519 signing key lives (created mode `0600` on first signed export or `monomem trust identity`, never exported; tightened back to `0600` at every start; not in `monomem backup` unless `--include-attest-key`). Two databases in one directory share the default file: use one directory per database or set this per database. If the location cannot be created, imports of unsigned files still work |
| `MONOMEM_RUNNER_HEARTBEAT_PRUNE_DAYS` | `30` (`0` = never; empty = `30`) | Housekeeping (server start, the runner's own sweep): delete the heartbeat note of a runner id that has not beaten for this many days (renamed hosts, containers, CI). A live runner re-creates its note on its next beat |
| `MONOMEM_RUNNER_HEARTBEAT_MS` | `180000` | Runner: how often it publishes its heartbeat. Server side: fallback for the runner's beat interval when a heartbeat does not carry one |
| `MONOMEM_RUNNER_NAMESPACE` | `commands` | Runner and signing helper: namespace holding signed command notes (not the command-task namespace) |
| `MONOMEM_RUNNER_RESULTS_NAMESPACE` | `results` | Runner: namespace its results are written to |
| `MONOMEM_RUNNER_POLL_MS` | `30000` | Runner: how often it polls for work |
| `MONOMEM_RUNNER_FRESHNESS_MS` | `300000` | Runner: signed commands older than this are refused |
| `MONOMEM_RUNNER_TIMEOUT_MS` | `120000` | Runner: default time-out for one action |
| `MONOMEM_RUNNER_MAX_REJECTS_PER_POLL` | `200` | Runner: rejected notes handled per poll |
| `MONOMEM_RUNNER_MAX_PER_POLL` | `10` | Runner: actions run per poll |
| `MONOMEM_RUNNER_MAX_PER_WINDOW` | `60` | Runner: actions run per rate window |
| `MONOMEM_RUNNER_WINDOW_MS` | `600000` | Runner: the rate window for `MONOMEM_RUNNER_MAX_PER_WINDOW` |
| `MONOMEM_RUNNER_RETENTION_DAYS` | `30` | Runner: days result notes are kept |
| `MONOMEM_RUNNER_PRUNE_EVERY_MS` | `3600000` | Runner: how often it prunes old results |
| `MONOMEM_RUNNER_ALLOW` | `data/runner-allow.json` | Runner: the allow-list (JSON) of actions it may run; none = nothing runs |
| `MONOMEM_RUNNER_SECRET` | unset | Runner and signing helper: the shared secret that signs and verifies command notes. Required to run or sign anything |
| `MONOMEM_TASK_COMMAND_QUOTA` | `100` | Most queued command tasks per namespace; more are refused |
| `MONOMEM_CHANGE_LOG_PURGE_MS` | `3600000` (min `100`) | How often the server prunes the 90-day change log and stale runner heartbeats. Shortened by tests only |
| `MONOMEM_TARPIT_STEP_MS` | `250` | Authentication failures from one client are delayed by this much more each time ... |
| `MONOMEM_TARPIT_CAP_MS` | `2000` | ... up to this ceiling (brute-force slow-down) |
| `MONOMEM_ENABLE_SIGN_PAGE` | unset (off) | `1` serves the runner signing page (`/sign`, `/signer.js`); otherwise both paths 404 |
| `MONOMEM_CONSUMER` | set by `monomem watch` | Not a setting: `monomem watch` puts the consumer name in the environment of the command it runs |
| `MONOMEM_CHANGE_COUNT` | set by `monomem watch` | Not a setting: the number of changes handed to the command `monomem watch` runs |
| `MONOMEM_ATTEST_MIN_VERSION` | `1` (at most the current version, `2`) | Oldest attestation version an import believes. `2` once every peer exports with 1.4.1 or later (a version-1 attestation signs fewer fields). **EXPERIMENTAL** (see [trust.md](./trust.md)) |
| `MONOMEM_SUPERSEDE_TTL_SECONDS` | `600` | How long the one-time confirmation code from a replace preview stays valid, in seconds (1 to 3600). See [replacing-memories.md](./replacing-memories.md) |
| `MONOMEM_HISTORY_VERSIONS` | `20` | Earlier versions of a note kept per note (0 = keep none, at most 500). The original version is never dropped |
| `MONOMEM_HISTORY_MAX_BYTES` | `2000000` | Most bytes of earlier text kept per note (10,000 to 50,000,000); stops a flood of big edits growing the database |
| `MONOMEM_SKIP_PREMIGRATION_BACKUP` | unset (off) | `1` = upgrade a database to a new schema even when the safety copy (`<db>.pre-vN-backup`) cannot be made. By default the upgrade stops with an error instead (no room on the disk, a failed copy). Take your own `monomem backup` first: there is no way back without a copy. See [upgrading.md](./upgrading.md) |
| `MONOMEM_IMPORT_REQUIRE_ATTESTATION` | unset (off) | `1` = an import (`monomem import --file`, `POST /import`) rejects every note that does not come with an attestation that verifies against a trusted key. Off by default: notes imported without one are accepted and flagged `imported_unverified`. Per import: `--require-attestation`, `?require_attestation=1`. See [trust.md](./trust.md) |
| `MONOMEM_NO_CHMOD` | unset | `1` = never tighten data-dir permissions to 0700/0600 (for deliberately shared dirs) |
| `MONOMEM_TOKEN` | auto-generated → `<data dir>/.token` | Primary bearer token; required to bind a public interface. **It is always an admin token**, so an agent holding it can switch the distrust policy off (`include_distrusted`): give agents a `write` or `read` token from `MONOMEM_TOKENS` and keep the primary one off them (`monomem doctor` warns when distrust rules exist and no other token does) |
| `MONOMEM_TOKENS` | unset | Optional JSON array of extra scoped tokens: `[{"token":"…","scope":"read\|write\|admin","label":"…","namespace":"…","max_sensitivity":"…"}]` (also readable from `<data dir>/tokens.json`). `namespace` optionally pins a token to one namespace — per-token isolation on a shared server, so several agents can share one bridge without seeing each other's notes. See [token-namespaces.md](./token-namespaces.md). `max_sensitivity` (`public`, `internal` or `private`) is a ceiling on which notes the token can see or write, whatever namespace it is in. See [sensitivity-labels.md](./sensitivity-labels.md) |
| `MONOMEM_BIND` | `127.0.0.1` | Interface to bind (`0.0.0.0` inside Docker) |
| `MONOMEM_PORT` | `8790` | HTTP API + dashboard port |
| `MONOMEM_MCP_PORT` | `8791` | MCP-over-HTTP port (for apps that connect over HTTP with a key) |
| `MONOMEM_TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy that sets `x-forwarded-for`. It also lets requests that carry forwarding headers pass the host check without being listed in `MONOMEM_ALLOWED_HOSTS`; leave it unset unless a proxy you control is the only way to reach the port. |
| `MONOMEM_TRUST_PROXY_HOPS` | `1` | With `MONOMEM_TRUST_PROXY=1`, how many trusted proxies sit in front: the rate-limit key is the Nth `x-forwarded-for` entry from the right (the leftmost one if there are fewer). Invalid or below 1 means 1. |
| `MONOMEM_TRUST_CLOUDFLARE` | unset | Set to `1` behind Cloudflare so per-client rate limiting keys on `cf-connecting-ip` |
| `MONOMEM_EMBEDDINGS` | unset (off) | `on` to enable optional semantic search; `auto` = use it when the embedding endpoint answers and stay keyword-only (silently, retrying once a minute) when it does not |
| `MONOMEM_EMBED_URL` | `http://localhost:11434/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `MONOMEM_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `MONOMEM_EMBED_KEY` | unset | Optional bearer token for the embeddings endpoint |
| `MONOMEM_EMBED_TIMEOUT_MS` | `30000` (`5000` with `MONOMEM_EMBEDDINGS=auto`) | Timeout per embedding call; raise if a local model's first (cold) call is slow |
| `MONOMEM_SCAN_CACHE_SECONDS` | `60` | How long the dashboard reuses its quality and health scans (they read every note). `0` = never reuse. |
| `MONOMEM_ALLOWED_HOSTS` | unset | Comma-separated host names this server may be reached under (ports ignored; `*` allows any). Without it, `localhost` and any IP address are accepted and a request under any other name is refused (403) as a guard against DNS rebinding. Forwarding headers (`X-Forwarded-For`, `X-Real-IP`) are not trusted, because a caller can send them itself. **Behind a tunnel or reverse proxy, set this to the public name** (the 403 message tells you the exact value). Set it to turn the check strict: then only `localhost` and the listed names pass. Example for a custom name on your network: `MONOMEM_ALLOWED_HOSTS=mynas.local` |
| `MONOMEM_MAX_CONNECTIONS` | `512` | Most connections each server (API, MCP) holds open at once |
| `MONOMEM_HEADERS_TIMEOUT_MS` | `20000` | How long a client has to send its request headers |
| `MONOMEM_REQUEST_TIMEOUT_MS` | `300000` | How long a client has to send a whole request (a large `/import` over a slow link needs this) |
| `MONOMEM_KEEPALIVE_TIMEOUT_MS` | `5000` | How long an idle connection is kept |
| `MONOMEM_EDGE_SYNC_MAX` | `5000` | A namespace with more live notes than this gets its similarity index built in the background in short slices instead of inside the write that needs it (so the server keeps answering; measured: the build froze it for 2.6 s at 50,000 notes and 41 s at 200,000). Notes written meanwhile are linked when it is ready |
| `MONOMEM_EDGE_AUTO_MAX_NOTES` | `100000` | A namespace bigger than this is not indexed automatically: new notes there get no automatic similarity links until you run `monomem rebuild-edges`. Search, listing and everything else are unaffected |
| `MONOMEM_EDGE_SLICE_MS` | `15` | How long each background index slice may run before handing the server back |
| `MONOMEM_ALLOWED_ORIGINS` | unset | Comma-separated browser Origins allowed to call the API (for a browser on the tunnel domain); loopback is always allowed |
| `MONOMEM_RATE_MAX` | `120` | Max requests per client per window |
| `MONOMEM_RATE_WINDOW_MS` | `10000` | Rate-limit window in milliseconds |
| `MONOMEM_TIMEZONE` | system timezone | IANA timezone for interpreting `when` time phrases in search (e.g. `America/Winnipeg`); invalid names fall back to `UTC` |
| `MONOMEM_AUTO_CONSOLIDATE_INTERVAL` | unset (off) | Background dedup interval: `24h`, `30m`, `90s`, or bare seconds (`3600`). Logs candidates ≥ 0.95; auto-merges only near-identical pairs ≥ 0.99 |
| `MONOMEM_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are flagged stale |
| `MONOMEM_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `MONOMEM_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `MONOMEM_ACCESS_FLUSH_MS` | `5000` | Read counts (`access_count` / `last_accessed`) are buffered in memory and written in one transaction this often (and on shutdown); `0` writes on every read |
| `MONOMEM_EDGE_INDEX_MAX_NOTES` | `50000` | Most notes kept in the in-memory similarity index across namespaces; least-recently-used namespaces are released beyond it (rebuilt on next use) |
| `MONOMEM_EDGE_INDEX_IDLE_MS` | `600000` | A namespace's similarity index is released after this long unused |
| `MONOMEM_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |
| `MONOMEM_ENCRYPT` | unset | `0` = hard-disable at-rest encryption even if a key file exists (used by tests). It never turns encryption **on**: that is decided by the presence of the key file, created by `monomem encrypt enable`. See [encryption-retention.md](./encryption-retention.md) |
| `MONOMEM_KEY_FILE` | `<data dir>/.key` | Path of the 32-byte encryption key file. Keep it with the same care as the database: anyone holding both can read the notes |
| `MONOMEM_SYNC_KEY_FILE` | your at-rest key if you have one, else `<data dir>/.sync-key` | The 32-byte key file `monomem sync --git --encrypt` seals files with (see [file-sync.md](./file-sync.md)). It must be outside the repository (a key inside it is refused); copy it to your other computers yourself |
| `MONOMEM_IMPORT_MAX_BYTES` | `67108864` (64 MB) | Request-body cap for `POST /import` (clamped to 1 MB - 2 GB; it was 256 MB before the lowered default, so raise it if a restore of a very large backup is refused with 413). Other routes keep the 1 MB cap |
| `MONOMEM_URL` | unset | Base URL (e.g. `http://localhost:8790`) used only by the runner signing helper's `--post` mode, together with `MONOMEM_TOKEN`. Not read by the server |
| `MONOMEM_LINT` | `secrets=block,injection=quarantine,entropy=warn,pii=warn,directive=warn` | Write-time memory linter policy: `block`, `quarantine`, `warn`, or per category (`secrets=block,injection=warn,pii=quarantine`). `entropy`, `pii` and `directive` only warn or quarantine. See [memory-linter.md](./memory-linter.md) |
| `MONOMEM_CLIENT` | unset | The app name the local stdio server stamps on its writes: `written_by` becomes `stdio:<name>` instead of `stdio`. `monomem setup` writes it into each app's MCP entry (`claude-code`, `cursor`, `codex`, ...). 1-40 characters `a-z 0-9 . _ -` (lower-cased); an invalid value is ignored with a warning on stderr and writes stay plain `stdio`. It is self-declared by whoever can edit that config file, not authenticated: it tells apps apart, it does not prove which one wrote. Use a scoped token over HTTP for an authenticated writer |
| `MONOMEM_STDIO_ADMIN_TOOLS` | unset | Set to `1` to let the agent on the local stdio connection use the operator-only tools (`memory_quarantine`, `trust_policy`, `memory_history_purge`, `memory_rollback`, `memory_consolidate`, `task_approve`), `include_distrusted`, and `task_put` with `approve: true`. Off by default: stdio runs as admin without a token, so nobody deliberately gave the agent those powers. HTTP tokens are unaffected |
| `MONOMEM_TOOLS` | `core` | Which MCP tools are registered. `core` (the default) is the nine an assistant needs — `state_write`, `state_read`, `state_search`, `state_list`, `state_delete`, `catch_up`, `memory_supersede_preview`, `memory_supersede_confirm`, `memory_supersede_undo`. `all` registers every tool, including the operator ones (history, consolidation, quarantine, trust policy, stats, command tasks, runner status). A comma-separated list adds named tools to the core set. Every registered tool's name and schema is sent to the model on **every turn**, so this is a context cost, not a feature switch |
| `MONOMEM_CAPTURE` | on (once the hooks are installed) | `off` = the capture hooks record nothing (the session-start context still works). Also readable from `<data dir>/capture.json` as `{"capture":"off"}`; the variable wins |
| `MONOMEM_CAPTURE_EXCLUDE` | unset | Comma-separated globs (`*`, `**`) on the working directory; sessions in a matching folder are not recorded (e.g. `**/secret-*,C:/clients/**`) |
| `MONOMEM_CAPTURE_SKIP_TOOLS` | unset | Comma-separated tool names the capture hooks ignore (e.g. `TodoWrite,WebFetch`). Monomem's own `mcp__monomem__*` tools are always skipped |
| `MONOMEM_LOCAL_MCP_SERVERS` | unset | Comma-separated MCP server names (the `<server>` in `mcp__<server>__tool`) that return only local content, such as a code index. Their output does not earn a session summary the "read outside content" stamp ([trust.md](./trust.md#the-outside-content-stamp)). Unset = every MCP server except Monomem counts as outside |
| `MONOMEM_TAINT_WINDOW_HOURS` | `12` | A note written by an agent (not the `monomem` CLI) is marked as from outside content, and stays unconfirmed until confirmed, when a hook-equipped session in the same namespace read outside content within this many hours and has not ended. Only what the hooks can see counts. `0` turns this signal off; the other two (an agent that read unconfirmed memory, a declared write or token) stay |
| `MONOMEM_CAPTURE_RETENTION_DAYS` | `7` | Raw captured events are deleted after this many days (the observations distilled from them are kept like notes) |
| `MONOMEM_DECAY_DAYS` | `30` | Captured observations nobody updated or read for this many days are **archived** (never deleted; `monomem restore <id>` brings one back) by the expiry sweep and at session end. Never decayed: your own notes, decisions, rows tagged `pinned`. `0` = decay off. Preview with `monomem decay --dry-run` |
| `MONOMEM_DECAY_SUMMARY_DAYS` | `180` | The same for session summaries. `0` = summaries never decay |
| `MONOMEM_LLM_URL` | unset (off) | Optional local model for session summaries: base URL of an OpenAI-compatible server (Ollama `http://127.0.0.1:11434`, LM Studio, llama.cpp). One call per session at session-end; on any failure the automatic summary stays. Needs `MONOMEM_LLM_MODEL`. Only loopback hosts are accepted |
| `MONOMEM_LLM_MODEL` | unset | The model name sent to `MONOMEM_LLM_URL` (e.g. `qwen2.5:7b`) |
| `MONOMEM_LLM_TIMEOUT_MS` | `30000` | Upper bound on the one summary call (1000 - 300000) |
| `MONOMEM_LLM_ALLOW_REMOTE` | unset | `1` = allow an `MONOMEM_LLM_URL` that is not this machine. Session text then leaves the PC; leave unset unless you mean it |
| `MONOMEM_RECALL_TOKENS` | `1500` | Token budget (about 4 characters each) of the context the session-start hook injects |
| `MONOMEM_PROFILE_TOKENS` | `300` | Share of that budget (at most half) for the "What I know about this project" block at the top: decisions, conventions (notes tagged `convention`), key files, last session, open-task count, built from stored notes with no model |
| `MONOMEM_RECALL_MAX_SENSITIVITY` | unset | `public`, `internal` or `private`: the session-start hook (and the file-context hook) leave out every note labelled above it. Anything else injects nothing. See [sensitivity-labels.md](./sensitivity-labels.md) |
| `MONOMEM_EXPORT_MAX_SENSITIVITY` | unset | `public`, `internal` or `private`: `monomem export --format md` and `monomem sync` write no note labelled above it into the folder (and prune its earlier files). Anything else stops the export. `--max-sensitivity` on the command overrides it |
| `MONOMEM_DEFAULT_MAX_SENSITIVITY` | unset | `public`, `internal` or `private`: a ceiling for every secondary token that sets no `max_sensitivity`. Anything else stops the server. See [sensitivity-labels.md](./sensitivity-labels.md) |
| `MONOMEM_ALLOW_PRIVATE_REMOTE` | unset | `1` lets notes labelled `private` be sent to the embeddings endpoint (`MONOMEM_EMBED_URL`). Unset, they are not embedded. See [sensitivity-labels.md](./sensitivity-labels.md) |
| `MONOMEM_STDIO_MAX_SENSITIVITY` | unset | `public`, `internal` or `private`: a ceiling for the stdio server (`monomem mcp`). Stdio has no token, so without this it reads every note. Anything else stops it from starting. An app that must be kept away from private notes should use the HTTP server and its own token instead |
| `MONOMEM_PROFILE` | on | `off` = leave the project profile out of the session-start context |
| `MONOMEM_HOOK_URL` | unset | Optional: when the local database cannot be opened, the capture hooks POST the event to `<url>/capture` instead of spooling it (2 s timeout). Needs `MONOMEM_HOOK_TOKEN` |
| `MONOMEM_HOOK_TOKEN` | unset | A write-scope token for `MONOMEM_HOOK_URL` |
| `MONOMEM_SPACES` | unset (feature off) | Optional JSON namespace config: `{"spaces":{"/home/you/work":"work"},"default_namespace":"default","reads_from":{"work":["shared"]}}` (or `<data dir>/spaces.json`; env wins). Enables server-side namespace resolution |
| `MONOMEM_SPACE` | unset | Explicit namespace override: when set, the server uses this namespace directly instead of resolving from the working directory (only meaningful with a spaces config present) |

## Server-side namespace resolution (optional)

By default the `namespace` parameter on MCP tools and the REST API is
model-supplied — convenient, but prompt-injected text in context can steer
it. Namespace resolution closes that vector: the server resolves its
namespace **once at startup** from the process working directory against a
`spaces` map, and that resolution is authoritative for the whole process.

```bash
# Option 1: env var (wins if both are set)
export MONOMEM_SPACES='{"spaces":{"/home/you/work":"work","/home/you/personal":"home"},"default_namespace":"default","reads_from":{"work":["shared"]}}'
# Option 2: ~/.monomem/spaces.json (the data dir) with the same shape
```

How it works:

- **Resolution order:** (1) `MONOMEM_SPACE` if set (explicit operator
  override wins); (2) the longest matching `spaces` path pattern for the
  startup working directory; (3) `default_namespace`.
- **Patterns are directories with prefix semantics:** `"/home/you/work"`
  matches that directory and everything under it — no wildcard needed.
  A trailing `*` (`"/home/you/work/*"`) is accepted as explicit prefix
  syntax and behaves identically.
- **Ambiguity is a hard error:** if two patterns match at equal depth but
  map to different namespaces, the server refuses to start rather than
  silently picking one.
- **Writes always land in the server-resolved namespace.** The
  model-supplied `namespace` is ignored on `state_write` / `POST /notes`,
  and stripped from updates (a note keeps its existing namespace).
- **`namespace` on reads is an untrusted hint:** `state_search`,
  `state_list`, `GET /notes`, `GET /search` only honor it when it names a
  namespace this server may read; otherwise they search/list the readable
  set. `state_read` / `state_delete` (and `GET`/`DELETE /notes/:id`) return
  a uniform "not found" for notes outside it, so denied namespaces are not
  an existence oracle.
- **`reads_from` grants are one-directional:** `{"work": ["shared"]}` lets
  the `work` server read `shared`, not the reverse. Grants never confer
  write access. Grant changes require a **server restart** to take effect --
  the config is read once at startup; there is no reload signal.
- **Fail-open, but loud:** with no config present everything behaves
  exactly as before (model-supplied namespaces keep working). Invalid
  JSON/shape is logged to stderr and disables the feature. `monomem
  doctor` validates that configured space paths exist on disk.

**Old names.** Monomem used to be called claude-bridge. Every `CLAUDE_BRIDGE_<NAME>` variable is read as the matching `MONOMEM_<NAME>` one (for example `CLAUDE_BRIDGE_DB_PATH` as the database path), so an old client configuration keeps its data. When both are set the new name wins. `monomem doctor` says when it mapped an old name, and `monomem setup` rewrites an old claude-bridge entry with the new names.
