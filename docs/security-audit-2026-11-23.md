# Monomem security audit, 2026-11-23

Scope: Monomem 1.7.0 plus the hardening branch (`hardening/human-confirm-attacks`, head `dfde37d`), audited in a worktree on branch
`worktree-agent-a08d9c7e04669ba35`. Everything ran on 127.0.0.1 against throwaway data folders (temp `MONOMEM_HOME`, random tokens).
Nothing from the repo or from any note was sent to an outside service. All tool output was treated as untrusted data.
Tools live under `D:\security-lab\` (venvs and local folders; no system-wide installs). Raw outputs: `D:\security-lab\out\`. Scripts:
`D:\security-lab\scripts\`.

## Summary

| Severity | Found | Fixed | Open (proposed or accepted) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 1 | 1 | 0 |
| Low | 2 | 1 | 1 |
| Info | 6 | n/a | 6 |

Nothing in the MCP surface looks like tool poisoning. Every scanner flag on tool descriptions was a false positive (details below). **Scanner caveats:** Snyk agent-scan ran in inspect mode only (it lists the tools and gives no verdict; its verdict mode uploads descriptions to a vendor, so it was not used). mcp-shield reported 7 flags, all judged false positives. Cisco mcp-scanner, Ramparts and mcpscan did not run. The review and the fuzzing were done by AI agents, not by a human penetration tester.
Namespace isolation, scope enforcement, Host and Origin checks held under every probe tried.

## Findings

### F-1 (medium, FIXED `a532c75`): pre-auth slow request bodies could exhaust the connection limit
- Where: `src/api.ts` (`POST /login`), `src/oauth/routes.ts` (register, consent form), `src/http-common.ts` `readBody`.
- Evidence: `D:\security-lab\scripts\login-dos.mjs`. 600 sockets, each sending the start of a `POST /login` body and then nothing.
  The server's `requestTimeout` is 300 s and the body cap was 1 MB, so each socket stayed open. Result before the fix: a valid
  authenticated `GET /notes` failed with "fetch failed" (`MONOMEM_MAX_CONNECTIONS` = 512 was full). After the fix: the same
  script returns 200. The per-IP anonymous rate limit does not help: 100 starts per 12 s stays under it, and behind a tunnel all
  clients share one IP.
- Impact: availability only, needs no key. Loopback-only installs: any local program. Tunnelled installs: anyone who can reach the tunnel.
- Fix: `readPreAuthBody` (4 KB cap, 10 s idle timeout that destroys the socket; `MONOMEM_PREAUTH_BODY_TIMEOUT_MS` overrides) used for
  `/login` and the OAuth pre-auth bodies. `/login` answers 413 over the cap.
- Regression test: `test/audit-2026-11-23-preauth-slow-body.test.ts` (failed before, passes after).

### F-2 (low, FIXED `b9f6349`): a JSON body of `null` gave 500 instead of 400
- Where: every REST route doing `JSON.parse(raw || "{}")` then reading a property (POST/PUT `/notes`, `/notes/:id/confirm`, `/flag`,
  `/relevant`, `/get`, `/rollback/preview`, `/rollback/confirm`: 8 routes failed the test).
- Evidence: `POST /notes` with body `null` -> `500 {"error":"internal error"}` (a TypeError caught by the global handler). No crash,
  no data exposure, but the request class was mishandled and logged as a server error.
- Fix: `parseJsonBody` in `src/api/shared.ts` (empty body and `null` both become `{}`), used at all 20 body-parse sites in `src/api*.ts`.
- Regression test: `test/audit-2026-11-23-null-body.test.ts` (23 routes; 8 failed before, all pass after).

### F-3 (low, OPEN, proposal): `memory_*` tool schemas accept unknown properties and have no `maxLength`
- Evidence: `D:\security-lab\out\poison-check.txt`. All tool `inputSchema`s carry `additionalProperties: {}` (the MCP SDK's JSON-schema
  rendering of the zod objects), and 85 to 98 string parameters (of 31 to 37 tools) declare no `maxLength`. The server does enforce size
  limits (for example "body exceeds 256000 chars", "title exceeds 2000 chars", unknown arguments are reported as ignored), so this is
  a schema honesty gap, not an exploitable hole: a client or scanner reading the schema cannot see the real limits.
- Proposed patch (not applied: it changes the published tool schemas, which would change the tool-list hash that pins rug-pull
  detection, and touches `src/mcp/*` shared by other engineers): add `.max(N)` to the zod strings that already have a server-side limit
  (`LIMITS` in `src/security.ts`) and `.strict()` where the server already rejects unknown keys. Re-pin the tool-list hash in the same change.

### Info (no action needed, recorded so they are not rediscovered)
- I-1: Authenticated slow bodies are allowed up to `requestTimeout` (300 s) because `/import` needs it. Needs a valid token. 100 half-open
  authenticated slow bodies did not affect other clients.
- I-2: Stateless `GET /mcp` (SSE) holds a stream until the client disconnects; needs a valid token, counted against `MONOMEM_MAX_CONNECTIONS`.
- I-3: `//export` (double slash) parses as a URL with host `export` and path `/`, so it serves the public dashboard HTML. No data.
- I-4: Host check allows `*.localhost` and any IP literal by design (a rebinding attacker needs a name; browsers resolve `.localhost` to loopback only).
  Every non-listed name was refused (403) in raw-socket tests, with or without `X-Forwarded-For`.
- I-5: `replace` confirmation is person-only for MCP callers, but a REST caller holding an admin key counts as a person (`isPersonCaller`).
  The code and docs already say so: an agent that holds an admin REST key or a shell can confirm. Not a new finding.
- I-6: The HTTP MCP tool list with `MONOMEM_TOOLS=legacy-1.5,all` has 37 tools versus 31 on stdio: six admin tools
  (`memory_consolidate`, `task_approve`, `memory_quarantine`, `trust_policy`, `memory_history_purge`, `memory_rollback`) are listed only to an
  admin-scope HTTP token. A write-scope token calling `task_approve`, `memory_history_purge` or `trust_policy` was refused.

## Tools run

### 1. MCP scanners
| Tool | Version | Command | Result |
|---|---|---|---|
| snyk-agent-scan (was Invariant `mcp-scan`; PyPI `mcp-scan` 0.4.3 is a redirect to it; Apache-2.0) | 0.7.0 | `snyk-agent-scan.exe inspect --dangerously-run-mcp-servers --no-skills --no-bootstrap --json --print-full-descriptions --storage-file ... scan-config-stdio.json` | Ran in its **inspect** mode only: it starts the server and prints tools, with no verification call. Both configs (default 7 tools and `legacy-1.5,all` 31 tools) enumerated with no errors. **The verification mode (`scan`) was NOT run:** it posts tool descriptions to `https://api.snyk.io/hidden/mcp-scan/analysis-machine` (source: `agent_scan/cli.py`), which is a vendor upload. So no Snyk verdict exists; inspect proves only that the tools enumerate. |
| mcp-shield (MIT) | 1.0.4 | `mcp-shield --path scan-config-stdio.json` (no `--claude-api-key`, so no model call) | 7 flags, all false positives: see below. |
| Own checks `poison-check.mjs` + `dump-tools.mjs` | n/a | `node dump-tools.mjs <repo> stdio\|http <default\|legacy-1.5,all> out.json` then `node poison-check.mjs ...` | stdio and HTTP; default (7 tools), all (31 stdio, 37 HTTP). 0 hidden Unicode characters (zero-width, bidi, tag characters; 0 non-ASCII characters at all), 0 matches for injection/exfiltration phrases, no duplicate tool names, description length max 1101, average 450 characters. Cross-tool references exist only as honest workflow hints (for example `memory_index` -> `memory_get`), which is not shadowing: no tool redefines or overrides another. |
| Rug-pull check | n/a | the two `listTools` calls per session, plus separate sessions | The tool list hash was identical between two calls in one session (all four surfaces) and identical between stdio and HTTP for the default surface (`6c44d7b76635...`). This shows the descriptions do not change between calls or transports in this build; it cannot show they will not change in a later release (compare the hash at upgrade). |
| Cisco `cisco-ai-mcp-scanner` (Apache-2.0; its YARA analyzer is local, its API and LLM analyzers upload) | see "could not run" | | See below. |
| Ramparts, mcpscan | n/a | | Not run: see "could not run". |

mcp-shield false positives (all in descriptions or parameter names, verified against the dumped JSON):
- "Hidden instructions: instead of" on `memory_save`, `memory_flag`, `task_put`, `session_handoff`: the ordinary phrase "(change it instead)"/"instead of overwriting it". Not hidden: it is plain text shown to the model.
- "Potential exfiltration: notes (string)" on `task_put`: a parameter named `notes`.
- "Sensitive file access: token" on `memory_supersede_preview` and `memory_supersede_confirm`: the one-time confirmation `token` parameter, not a credential path.
- "Path traversal attempt: .." on `memory_index`: the literal "(bugfix, feature, decision, ...)" in the description.

### 2. Static analysis: Semgrep 1.177.0
Command: `semgrep --metrics off --timeout 0 --config p/security-audit --config p/typescript --config p/nodejs --config p/javascript --config p/owasp-top-ten --config p/secrets --json <worktree>/src` (271 files). Registry rule packs were downloaded; no results uploaded.
Only 129 of the 728 rules in those packs ran: the others are Pro/login-only rules that Semgrep skipped. A first run with the default timeout gave 20 rule timeouts; the rerun with `--timeout 0` gave 5 partial-parse notices (files Semgrep could only partly parse) and no rule timeouts. "Nothing more found" therefore means: nothing from the 129 community rules, on files that mostly parsed.
All 8 findings are false positives:
| Finding | File:line | Triage |
|---|---|---|
| detect-child-process | `src/api/routes-ui.ts:82` | `spawn(self.command, self.args)` on Monomem's own executable and fixed args, no request data in the command. FP. |
| detect-child-process | `src/hook.ts:43` | detached self-spawn of `monomem hook llm-summary`; the session id goes to stdin as JSON. FP. |
| detect-child-process | `src/sync/device.ts:236` | self-spawn `launch()` + `sync`. FP. |
| detect-child-process | `src/update.ts:417` | runs the downloaded installer/`npm` with fixed argv, operator-initiated. FP (the update path has its own checks). |
| detect-child-process | `src/setup.ts:2286` / `src/everyday-cli.ts:228` (the two runs flagged one each) | `shell:true` with `$EDITOR` plus Monomem's own temp file path. CLI only, the editor value comes from the user's own environment, no remote input. FP (info: standard `git`-style EDITOR behaviour). |
| detect-child-process | `src/bench/competitors/mem0-adapter.ts:57` | bench harness, not shipped logic. FP. |
| gcm-no-tag-length | `src/crypto.ts:221` | the tag length is checked to equal `TAG_BYTES` on the lines before `setAuthTag`. FP. |
| react-insecure-request | `src/embeddings-offer.ts:25` | `http://localhost:11434` Ollama probe; not React; loopback. FP. |

### 3. Dependencies
- `npm audit`: found 0 vulnerabilities. `npm audit --omit=dev`: found 0 vulnerabilities. (npm audit knows published advisories only: it does not catch unreported flaws.)
- `pip-audit` is installed (2.x, also pulled in by the Cisco install); not applicable: the package has no Python.
- Runtime SBOM (`D:\security-lab\out\sbom.txt`, from `package-lock.json` plus installed `package.json`): 2 direct runtime dependencies
  (`@modelcontextprotocol/sdk` 1.32.2 via `^1.32.2`, `zod` ^4.6.7), 94 runtime packages in total, all from the npm registry (0 git or URL sources).
  Licences: MIT 84, ISC 7, BSD-3-Clause 2, BSD-2-Clause 1. No copyleft, none unknown.

### 4. Secret scanning
- gitleaks 8.30.1 (MIT; official Windows release zip, SHA-256 `d29144de...afc4e`): `gitleaks git --redact .` over 704 commits (12.2 MB): 16 hits. All are test fixtures or documentation:
  made-up values in `test/*.test.ts` (for example `DB_PASSWORD=hunter2abc123`, AWS's documented example key `AKIAIOSFODNN7EXAMPLE`, `curl -u admin:pa55word`), the secret-redaction code's own comment/regex examples in `src/redact.ts`, and `curl ... Bearer` examples in `INFRA.md`. I opened the matching lines at the cited commits for the AWS/token/password ones. **No real secret found.** This does not prove no secret ever existed in a different form the rules do not match (for example a short password), only that the 100+ gitleaks rules match nothing real.
- gitleaks `dir` on the unpacked tarball (`npm pack` -> `monomem-1.7.0.tgz`, 475 files, 1.5 MB): 2 hits, the same `INFRA.md` curl example and the `redact.js` regex comment. FPs.
- detect-secrets 1.5.0 (Apache-2.0), `scan --all-files` on the unpacked tarball: 25 flags, all false positives: CHANGELOG/docs prose about `scheme://user:pass@`, bench scenario files that deliberately contain fake secrets (E06, E07, F07), a base64 favicon, a Crockford alphabet constant (`PAIR_ALPHABET`), a SHA-256 pin for a public dataset, and variables named `secret`/`clientKey` in code. No key material.
- Tarball file list (`npm pack --dry-run`): only `dist/`, `bench/`, `docs/`, `skills/`, `package.json`, README/LICENSE-type files. No `.env`, key, token, database or source-map files.

### 5. Manual security review (checklist and categories of `claude-code-security-review`, applied by hand)
Read in full: `src/mcp-http.ts`, `src/http-common.ts`, `src/api.ts`, `src/api/routes-backup.ts`, `src/api/shared.ts` (scope table), the auth, host and origin section of `src/security.ts` (lines 370 to 626), `src/login-code.ts`, `src/config.ts` (token resolution), `src/code-anchor.ts` path checks; skimmed the other route and tool files and every `child_process`, `fetch(` and string-built SQL site. The diff `ecc9416..HEAD -- src` (30 files, +854/-55) was read for the non-bench parts: `supersede.ts` and `tools-supersede.ts` (person-confirm), `attack-sets/index.ts` (download), `http-common.ts`, `oauth/routes.ts`. I did not read all 8,281 lines of `src/api/*.ts`, `src/mcp/*.ts` line by line; routes and tools were probed dynamically instead (section 6).

| Category | Result |
|---|---|
| Auth bypass | Authorization: Bearer key only; no cookie auth. Plain and hashed token entries are both compared as SHA-256 digests with `timingSafeEqual`, and every configured token is checked with no early exit. 401 on missing, wrong, query-string and wrong-scheme tokens (lowercase `bearer` is accepted, which is fine). Nothing found. |
| Scope escalation | `requiredScope` is default-write for POST/PUT, admin for DELETE and listed admin paths; `/ui/*` additionally needs the unpinned main key. A write token got 403 on every admin REST route and on 3 admin MCP tools (section 6). A namespace-pinned admin got 403 on `/tokens`, `/audit`, `/access`, `/ui/*`: it cannot create an unpinned key. Nothing found. |
| IDOR across namespaces | A tenantA note id (2) probed from a tenantB admin key: `GET/PUT/DELETE /notes/2`, `confirm`, `archive`, `history`, `POST /get`, `/search`, `/changes`, `derived_from` all answered 404 or "missing" (same text as a nonexistent id, so no existence oracle); `touched` answered 403 for pinned tokens. MCP: `memory_get`, `state_read`, `state_delete`, `memory_history`, `state_search namespace=tenantA` all answered "no note" or empty. A pinned token that names another namespace in a write is forced into its own. Nothing found. |
| Path traversal (import, export, backup, restore) | REST `/import` and `/export` take JSON, not paths. Backup and restore take paths only from the CLI (local operator input; `restore.ts` resolves and checks `state.db`). File parameters in notes (`files`) reject `..`, control characters, and symlinks leaving the repo (`code-anchor.ts`). Encoded traversal in URLs (`%2e%2e`, `..%2f`, `%5c`, NUL) all 404/403. Nothing found. |
| SSRF | The only fetches to a configurable URL are the operator-set `MONOMEM_EMBED_URL` and LLM endpoint (env, not request data; `redirect: "error"`; `warnIfRemote`), and the attack-set download, which is pinned by URL and SHA-256 with `redirect: "error"`. No request field reaches a URL. Nothing found. |
| Command injection | 19 files use `child_process`. All the ones checked use `execFile`/`spawn` with an argv array and `shell:false`, except the `$EDITOR` call (user's own env). `git` is invoked with `-c core.fsmonitor=false -c core.hooksPath=` so a repo's config cannot run a hook. The runner has an allowlist and refuses shell interpreters. Nothing found. |
| SQL injection | Every `${...}` inside a SQL string was checked: they interpolate fixed table-name constants, `?` placeholder lists, or numeric pragma values. LIKE/`'` payloads in `q`, `namespace` and `tag` returned empty results with no error. Nothing found. |
| Unsafe deserialization / prototype pollution | Only `JSON.parse` of request bodies; `__proto__`/`constructor` keys are refused as unknown fields (400); duplicate keys: last wins, no privilege effect (a `written_by` field is ignored, the server stamps the writer). Nothing found. |
| ReDoS in non-lint code | Search input is capped (4,096 chars / 64 words); a `(a+)+$` style query returned 400 in milliseconds. Request-path regexes in `api/*.ts` are anchored and simple. Lint regexes are another engineer's scope and were not reviewed. Nothing found. |
| Timing leaks | Token compare and login-code compare are constant time. The `/login` code is single-use; a wrong guess no longer burns it (round 3), and wrong guesses are limited to 8 a minute per source. Nothing found. |
| Log injection | A title containing `\r\n{"op":"forged"}` was accepted and stored; the audit log is a hash-chained JSON writer that records metadata, not titles (`security.ts` comment), and `printable()` strips controls for CLI output. I did not parse the audit file for a forged line; the code path stores no note text. Nothing found. |
| Header injection | CRLF in a query namespace is echoed only inside a JSON body (`searchedNamespaces`), never in a header. Nothing found. |
| CORS / DNS rebinding | No CORS headers are ever sent. `OPTIONS` with a foreign Origin: 403. Raw-socket Host tests: `evil.com`, `evil.com:port`, `127.0.0.1.evil.com`, `localhost.evil.com`, with and without `X-Forwarded-For`: 403 on REST and MCP. Origin `127.0.0.1.evil.com`, `null`, other loopback port, https loopback: 403. Only the server's own http loopback port is allowed. Nothing found. |
| CSRF on the dashboard | No cookies are issued; every state-changing call needs `Authorization: Bearer` (and `/ui/*` needs the local-session header), which a cross-site page cannot send without a preflight that the server refuses. The dashboard CSP and `X-Frame-Options: DENY` are set. Nothing found. |
| Unbounded memory/CPU | Body cap 1 MB (413 at 1 MB and 5 MB), import 64 MB admin-only, deep-nesting JSON of 200k arrays and 50k objects answered 400 in milliseconds, tags/derived_from/files caps enforced, header size 431. See F-1 for the one gap. Memory grew from 94 MB to 139 MB over the whole fuzz run (about 1,500 requests, several 1 MB bodies); not a leak by itself, but I ran one pass, not a soak test. |
| Symlink/junction tricks on Windows | Checked by reading `code-anchor.ts` (`realpathSync.native` and containment) and `claude-import.ts` (link leading outside the root is refused). Not dynamically tested with a real junction. |

### 6. Dynamic probing (`D:\security-lab\scripts\fuzz.mjs`, node, no new dependencies)
Target: `dist/src/start.js`, REST and MCP-HTTP on random loopback ports, tokens: admin, read, write, tenantA write pin, tenantB admin pin; `MONOMEM_TOOLS=legacy-1.5,all`. Two full runs (`fuzz1.json`, `fuzz2.json`; first run had a script bug that made the IDOR ids undefined, so only the second counts for IDOR). About 130 requests plus floods. Results:
- Status codes: malformed JSON 400; wrong content type: JSON still parsed (201; harmless: the route needs a key in the Authorization header); invalid UTF-8 bytes and lone surrogates stored with replacement characters (201); NUL in namespace 400; 1 MB+1 and 5 MB 413; path tricks 404/403; `null` body 500 (fixed, see F-2).
- Concurrency: 300 concurrent writes with one token: 70 accepted, 230 429 (the per-token limit 120 per 10 s), 468 ms, no error, no crash. 400 bad-token requests: 16 401 and 384 429; a valid read token answered 200 immediately afterwards (the tarpit is per client key, not global).
- Slow clients: header drip closed after 26 s (20 s `headersTimeout`); authenticated slow body stayed open (I-1); 100 half-open authenticated slow bodies did not affect other clients; 200 pre-auth slow `/login` bodies stayed open before the fix (F-1; 600 locked out a valid client, proven).
- MCP-HTTP: no token 401; foreign Origin 403; malformed JSON 400; 2 MB 413; 100,000-deep array: JSON-RPC parse error; batch of 5,000 refused ("Batch must not exceed"); read token calling `state_write`: tool error; write token calling the three admin tools: tool error; unknown and traversal-style tool name: error; wrong argument types: validation error; `DELETE /mcp` empty 200.
- Server state at the end: alive (`/health` 200), no exit, no crash, no hang. `request error: aborted` lines appear in stderr for every client that hangs up mid-body (noise, not a fault).
- Not done: a long soak for memory growth; fuzzing every one of the 37 tools' argument shapes (only the ones named above); HTTPS or tunnel configurations; a Windows junction test.

## Could not run, and why
- Snyk Agent Scan `scan` (the verification mode): needs an upload of tool descriptions to Snyk's API (and a Snyk token). Not run on purpose.
- Cisco AI Defense `mcp-scanner`: see the install note below. Its API and LLM analyzers send tool text to a vendor or a model API and were never to be used; only its local YARA analyzer was in scope.
- Ramparts (Rust, built from source with cargo) and `mcpscan`: skipped. Cargo is not installed here (installing a Rust toolchain on C: was out of scope for a no-admin, D:-only setup), and I could not verify that `mcpscan` is a maintained, licensed, fully local tool. They remain open items.
- `p/secrets` ran (it was available from the registry). Semgrep Pro rules (599 of 728) need a login and were skipped.
- `pip-audit`: nothing to audit; no Python dependencies.
- OpenSSF Scorecard, CodeQL: not run (not requested; CodeQL needs a database build and a GitHub download).

## Commits (branch `worktree-agent-a08d9c7e04669ba35`)
- `b9f6349` fix: a JSON body of null answers 400, not 500 (audit 2026-11-23)
- `a532c75` fix: pre-auth request bodies (login, oauth) get a 4KB cap and a 10s idle timeout
- `6dfd766` docs: document MONOMEM_PREAUTH_BODY_TIMEOUT_MS (the configuration-table test in `test/trust-142.test.ts` requires every `MONOMEM_*` variable to be listed)

## Test counts
Before (`hardening/human-confirm-attacks` at `dfde37d`): 4,280 tests, 4,269 pass, 0 fail, 11 skipped.
After the two fixes, first run: 4,306 tests, 4,294 pass, 1 fail (the configuration-table check, fixed by `6dfd766`), 11 skipped.
After all commits (final full run): 4,306 tests, 4,295 pass, 0 fail, 11 skipped (26 new tests: 23 null-body, 3 pre-auth). One intermediate run failed the vocabulary check on wording in this very report; the wording was changed and the full suite re-run clean.

Cisco `mcp-scanner` install note: `pip install cisco-ai-mcp-scanner` into `D:\security-lab\venv-cisco` pulled in a very large dependency set (litellm, huggingface-hub, tokenizers, tree-sitter grammars) and had not finished when the audit ended, so it was not run. Its local YARA analyzer is the only part that would have been in scope. Treat it as not run.
