# OWASP ASI06 coverage map (Monomem)

> **Internal. Not for publication until the owner approves.**

> Superseded on 2026-11-17 by the public [docs/security-scorecard.md](../security-scorecard.md) (re-checked against 1.5.0). Kept for history.

Checked 2026-11-04 against `main` (3732209). Verdicts are strict. "Covered" means we read the code and a test or bench scenario exercises it. A claim found only in docs is marked Partial.

## Sources

- **[ASI]** OWASP Top 10 for Agentic Applications 2026, **ASI06: Memory & Context Poisoning**, "Prevention and Mitigation Guidelines", PDF pp. 24-26. <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>
- **[CS]** OWASP AI Agent Security Cheat Sheet, "Memory & Context Security". <https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html>
- **[AMG]** OWASP Agent Memory Guard, which calls itself the ASI06 reference implementation. <https://github.com/OWASP/www-project-agent-memory-guard>. Its status is labelled two ways: the owasp.org page says "Lab", the README says "Incubator".

## ASI06 guidelines [ASI]

| # | OWASP (quoted) | Verdict | Evidence |
|---|---|---|---|
| 1 | "Encryption in transit and at rest combined with least-privilege access" | Partial | At rest: opt-in AES-256-GCM, bodies only. Titles and tags stay plaintext (`src/crypto.ts:1-20,71-85`). In transit: binds `127.0.0.1` by default (`src/config.ts:486`) and has no built-in TLS (README:75 says to put your own proxy in front). Least privilege: read/write/admin scopes (`src/security.ts:445-449`). `OPERATOR_ONLY_TOOLS` are not registered on stdio (`src/mcp-server-core.ts:225-231,309-318`). |
| 2 | "Scan all new memory writes and model outputs (rules + AI)" | Partial | A rules-only regex linter (`src/lint.ts:96-185`) runs on create, update and import (`src/store.ts:2462,3095,4599`). By default secrets are blocked and injection is quarantined (`src/lint.ts:54`). There is no AI classifier. Model output is scanned only on the capture path (`src/redact.ts`, `src/extract.ts:1-16`). Bench: E01-E03, E07, E11, E15. E16 shows the miss. |
| 3 | "Isolate user sessions and domain contexts" | Partial | Server-side namespaces, where the model's hint is untrusted (`src/namespace.ts:1-35`, `src/mcp-server-core.ts:357`). Per-token namespace pin (`src/config.ts:320-332`). Bench E09. The feature is opt-in and fails open (`src/namespace.ts:11-13`), so a default install is one shared space. Sessions are not isolated from each other. |
| 4 | "Allow only authenticated, curated sources; enforce context-aware access per task" | Partial | HTTP needs a token. Stdio has no token and runs as admin (`src/mcp-server-core.ts:213-218`). There is no per-task access control. Retention is a per-note TTL `forget_after` (`src/store.ts:317-321`, sweep at 3338), not based on data sensitivity. |
| 5a | "Require source attribution" | Covered | `written_by` is stamped by the server from the connection and cannot be set by a client (`src/security.ts:24-27`, `src/actor.ts:31-44`, `src/mcp-server-core.ts:344`). Bench E08. |
| 5b | "detect suspicious updates or frequencies" | Gap | We found no write-rate, burst or anomaly detection in `src/`. |
| 6 | "Prevent automatic re-ingestion of an agent's own generated outputs into trusted memory" | Partial | Capture events live in a separate capture DB. Distilled observations get reserved tags and go through lint (`src/extract.ts:12-16`). Bench E12. An agent can still `state_write` its own output, and that note ranks like any other: there is no taint or echo marker. |
| 7a | "Perform adversarial test" | Covered | Poison suite `bench/scenarios/E01`-`E16`, plus red-team tests in `test/`. |
| 7b | "use snapshots/rollback and version control" | Partial | Per-note version history (`note_history`, `src/store.ts:2214`). `restoreVersion` (3649), archive/restore (3887/3905), supersede undo (3815). Full-file backups (`src/backup.ts`). There is no point-in-time snapshot of the whole store and no rollback by writer. |
| 7c | "require human review for high-risk actions" | Partial | Quarantined writes need an admin to approve them (`src/store.ts:6731`; the tool is operator-only). Replace is a two-step preview/confirm with a single-use code (`src/supersede.ts:146,262`; bench A22-A24). The agent itself can perform the confirm, and writes that pass lint get no review at all. |
| 7d | "per-tenant namespaces and trust scores ... rollback/quarantine for suspected poisoning" | Partial | Namespaces: see row 3. Trust is a binary per-namespace distrust list, not a score (`src/store.ts:2170`, `distrustAdd` 6111). Distrust hides a writer's notes from every read (bench E04, E16). Quarantine works only at write time: a note already stored cannot be quarantined. |
| 8 | "Expire unverified memory to limit poison persistence." | Partial | Captured observations decay after 30 days by default (`src/store.ts:1148-1157`, `sweepDecay` 3430). Agent-written notes never expire unless the writer sets `forget_after`. Imported notes are flagged `imported_unverified` (`src/store.ts:739`) but are not expired. |
| 9 | "Require two factors to surface high-impact memory ... decay low-trust entries" | Partial | Reads drop distrusted writers (`src/store.ts:1114-1123`). `confidence` is an advisory claim and is never used for ranking (`src/store.ts:322-324`). There is no two-factor gate and no trust decay. |

## Cheat sheet [CS]

| OWASP (quoted) | Verdict | Evidence |
|---|---|---|
| "Validate and sanitize data before storing in agent memory." | Partial | Same as ASI row 2: regex only. Notes are linted, not sanitized. Only capture redacts. |
| "Implement memory isolation between users/sessions." | Partial | Same as ASI row 3: opt-in. |
| "Set memory expiration and size limits." | Partial | Size limits always apply (`src/store.ts:257`). Expiration is opt-in per note. |
| "Audit memory contents for sensitive data before persistence." | Partial | Secrets are blocked by default. There is no PII detection. |
| "Use cryptographic integrity checks for long-term memory." | Partial | Ed25519 attestations on export and import only (`src/attest.ts:1-20`; bench E10). The live database has no row MAC or hash chain. |

## Agent Memory Guard features [AMG]

| AMG feature | Verdict | Evidence |
|---|---|---|
| "SHA-256 baselines flag out-of-band tampering" | Gap | Live rows have no integrity baseline. |
| "detectors for prompt injection, secret/PII leakage" | Partial | Injection and secrets: yes. PII: no. |
| "YAML-defined rules map findings to actions" | Covered | `MONOMEM_LINT` block/quarantine/warn per category (`src/lint.ts:14-90`). It is an env setting, not YAML. |
| "Point-in-time snapshots enable rollback" | Partial | Per-note history and backups only. |
| "Every write carries an explicit source_class" | Covered | `written_by` plus markers `stdio`/`cli`/`server`/`runner`/`capture` (`src/actor.ts:38`). |
| `SelfReinforcementDetector` | Gap | There is no echo or self-reinforcement guard. |

**Tally (24 rows): Covered 4, Partial 17, Gap 3, Not applicable 0.**

## Built, unreleased (branch release/next)

Built and tested on `release/next`, not yet in a published release. Do not claim them publicly until a release ships them; the verdict rows above still describe `main` (1.1.1).

| Item | Addresses |
|---|---|
| Approve-first namespaces | ASI 7c (human review), ASI 2 (writes held before they become memory) |
| Read access log | ASI 5b (anomalies), forensics for 7d |
| Flood auto-pause of a token | ASI 5b ("suspicious ... frequencies"), bench E14 |
| Per-app identity by default | ASI 5a and 4 (stdio writes stop collapsing to `stdio`) |
| PII and sleeper-trigger lint warnings | ASI 2, CS "sensitive data", ASI common example 5 (trigger backdoors) |
| Human-only pinned notes | ASI 9 (human-verified tag), 7c |
| Rollback-by-writer | ASI 7b and 7d (rollback for suspected poisoning) |

## Later

| Item | Addresses |
|---|---|
| Taint flag after untrusted reads | ASI 6 (re-ingestion), ASI 9 (trust weighting) |
| Echo-loop guard | ASI 6, AMG `SelfReinforcementDetector`, ASI common example 4 (drift) |
| Code-drift staleness | ASI 8 (expire unverified), ASI common example 4 |
| Tamper evidence (keyed row MAC + hash-chained audit) | CS "cryptographic integrity", AMG integrity baselines, ASI 1 |

## Known gaps and limits

- **The linter is pattern matching.** A reworded attack is stored (bench E16 asserts this on purpose). Distrust is the fallback, and only after a human notices the problem.
- **Stdio writes are all stamped `stdio` today.** Two agents on the same machine cannot be told apart, so distrust cannot single one out.
- **Stdio runs as admin with no token.** Operator tools are hidden from it, but it can still read and write every namespace it resolves to.
- **Anything with file access can edit the SQLite file directly.** That bypasses lint, `written_by` and history, and leaves no trace.
- **Encryption at rest is opt-in and covers bodies only.** Titles and tags stay readable.
- **Namespaces are opt-in.** A default install is one shared memory.
- **There is no frequency or anomaly detection.** A flood is slowed only by ranking (E14), not stopped.
- **Unverified notes never expire unless a TTL is set.**
- **An agent can save its own output as a normal note**, and nothing marks it as self-generated.
