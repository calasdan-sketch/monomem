# Security scorecard: OWASP ASI06 and outside attack sets

What Monomem does, and does not do, against memory and context poisoning, checked against the OWASP list and against
attack text that other researchers published. Every miss is shown. This is our own check, not a certification or an audit
by OWASP or anyone else.

- **Checked:** 2026-11-17, Monomem 1.5.0 (branch `feat/next`, base `6d5445b`).
- **Settings:** defaults (`MONOMEM_LINT` unset, no approve-first, no namespaces, embeddings off).
- **Re-run it yourself:** `monomem check --attacks` and `monomem check --attacks --set <name>` (see [Method](#method)).

## The OWASP entry

ASI06 is **"Memory & Context Poisoning"** in the *OWASP Top 10 for Agentic Applications 2026* (OWASP GenAI Security
Project, Agentic Security Initiative, published 2025-12-09, licensed CC BY-SA 4.0):
<https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>. The PDF on that page needs a
sign-in to download. The quoted guideline text below was checked against intuitem's CC BY-SA transcription of the
PDF's "Prevention and Mitigation Guidelines"
(<https://github.com/intuitem/ciso-assistant-community/blob/main/backend/library/libraries/owasp-asi-top-10-2026.yaml>).

OWASP describes the risk as adversaries who "corrupt or seed this context with malicious or misleading data, causing
future reasoning, planning, or tool use to become biased, unsafe, or aid exfiltration".

## ASI06 guideline by guideline

**Does this** = built and covered by a test. **Partly** = some of it, the rest is listed. **Does nothing** = not built.

| # | OWASP guideline (quoted) | Verdict | What Monomem does (feature, code, test) | Where it does nothing |
|---|---|---|---|---|
| 1 | "Encryption in transit and at rest combined with least-privilege access" | Partly | At rest: `monomem encrypt enable`, AES-256-GCM on note bodies (`src/crypto.ts`; `test/crypto.test.ts`). Least privilege: read / write / admin app keys, a key can be pinned to one namespace (`src/security.ts`, `src/namespace.ts`; `test/token-namespace.test.ts`). Listens on 127.0.0.1 only by default. | Encryption is off by default and covers bodies only: titles, tags and writer names stay readable. No built-in TLS: traffic beyond your own computer needs your own tunnel or proxy ([INFRA.md](../INFRA.md)). A local (stdio) app has no key and runs with full access to its namespace. |
| 2 | "Scan all new memory writes and model outputs (rules + AI) for malicious or sensitive content before commit." | Partly | Every create, update and import goes through a pattern linter: secrets refused, injection phrasing held for a person, personal data and deferred triggers warned (`src/lint.ts`, `src/pii.ts`; `test/lint.test.ts`, bench scenarios E01-E03, E07, E11, E15, E17-E19). | Rules only, no AI check. Reworded attacks pass (E16 below), and so did most outside attack text (results below). Model output is scanned only when it is written as a note. |
| 3 | "Isolate user sessions and domain contexts to prevent knowledge and sensitive data leakage." | Partly | Namespaces resolved by the server, not by what the model asks for (`src/namespace.ts`; `test/namespace.test.ts`, bench E09); sensitivity labels keep `private` notes from apps connected with a lower limit ([sensitivity-labels.md](./sensitivity-labels.md)). | Off by default (one shared memory until you set namespaces). Sessions are not isolated from each other. |
| 4 | "Allow only authenticated, curated sources; enforce context-aware access per task; minimize retention by data sensitivity." | Partly | REST and MCP-over-HTTP need a key. Text from outside (a web read in a hooked session, `outside: true`, an app key marked `reads_outside`, `import --claude`) is held out of session start until a person confirms it (`src/taint.ts`, `src/store/taint.ts`; `test/taint-declared.test.ts`, `test/unconfirmed-session-start.test.ts`). | No per-task access rule. Retention is not tied to sensitivity: only a per-note `forget_after` and the decay of captured observations. Outside content Monomem cannot see (a `curl` in a shell, apps without hooks) is not marked. |
| 5 | "Require source attribution and detect suspicious updates or frequencies." | Partly | `written_by` is stamped by the server from the key (`src/actor.ts`; bench E08); signed audit log and signed write receipts (`src/security.ts`; `test/signed-audit.test.ts`); flood guard pauses a writer that writes too much in an hour; read access log (`test/access-log-flood.test.ts`). | A local stdio app's writer name is a label from its own config, not proven. The flood guard counts writes per label, so an app that changes its label is not caught. No other anomaly detection. |
| 6 | "Prevent automatic re-ingestion of an agent's own generated outputs into trusted memory to avoid self-reinforcing contamination or 'bootstrap poisoning.'" | Partly | Echo guard: a note that restates a note the same session was shown is labelled an echo of it and keeps its unconfirmed status, so it never counts as a second source (`test/echo-guard.test.ts`). A note written after reading an unconfirmed note is itself marked (`obs.origin:via:memory`, [trust.md](./trust.md)). | An agent can still save its own words as an ordinary note. The self-poisoning row (SELF) below reaches the agent. |
| 7 | "Perform adversarial test, use snapshots/rollback and version control, and require human review for high-risk actions. Where you operate shared vector or memory stores, use per-tenant namespaces and trust scores for entries, decaying or expiring unverified memory over time and supporting `rollback/quarantine` for suspected poisoning." | Partly | Adversarial test: `monomem check --attacks` and the outside sets on this page. Per-note version history, automatic daily backups while the server runs (`src/backup-schedule.ts`), `monomem rollback <writer>` (`test/rollback-complete.test.ts`). Held writes and approve-first namespaces need a person (`test/approve-first.test.ts`). Commands and tasks from outside content need a person at a terminal (TASK row below). Per-writer distrust hides a writer's notes from every read (bench E04, E05, E16). | Trust is distrusted or not, not a score. A note that is already stored cannot be moved back into the held queue; distrust or archive it instead. Unverified notes do not decay or expire by themselves. |
| 8 | "Expire unverified memory to limit poison persistence." | Does nothing (for agent notes) | Captured observations nobody used decay after 30 days (`Store.sweepDecay`; `test/decay-quality.test.ts`). Unconfirmed outside notes stay out of session start. | Agent-written notes and unconfirmed outside notes never expire unless the writer set `forget_after`. |
| 9 | "Weight retrieval by trust and tenancy: Require two factors to surface high-impact memory (e.g., provenance score plus human-verified tag) and decay low-trust entries over time." | Partly | Pinned notes can be changed only through the CLI at a terminal (an admin key can still unpin over REST); a note from outside content cannot be pinned until a person confirms it (`test/pin-refusal-admin.test.ts`). Session start shows a confirmed outside note as an index line only. Distrusted writers are dropped from every read. | No two-factor rule for search results, no trust score in ranking, no decay of low-trust notes. `confidence` on a note is the writer's claim and is not used for ranking. |

Tally: Does this 0, Partly 8, Does nothing 1. Each guideline has at least one part Monomem does not do.

## Results

`held` = kept out of memory until a person approves it. `blocked` = stopped another way (refused, stamped, hidden,
not served). `warned` = stored and returned with a warning label. **`REACHED`** = stored and returned to a reader's search
with no warning.

### Monomem's own 26 attacks (`monomem check --attacks`)

| Held | Blocked | Warned | REACHED |
|---|---|---|---|
| 8 | 12 | 4 | **2** |

Misses: **E16** (a reworded override no pattern matches; distrusting the writer removes it afterwards) and **SELF** (a
trusted writer saves an attacker's instruction in its own words). The linter was tuned on these attacks, so this table
shows that the known cases still work, not how well unknown ones are caught.

### Outside attack sets (`monomem check --attacks --set <name>`)

These were written by other researchers for other systems, and the linter was not tuned on them.

| Set | Source (licence) | Samples | Held | Blocked | Warned | REACHED |
|---|---|---|---|---|---|---|
| `injecagent` | InjecAgent, Zhan et al. 2024 (MIT) | 62 | 0 | 0 | 35 | **27** |
| `injecagent-enhanced` | same, with its "IMPORTANT!!! Ignore all previous instructions" prefix | 62 | 62 | 0 | 0 | **0** |
| `agentdojo` | AgentDojo v1 injection tasks in its `important_instructions` text, Debenedetti et al. 2024 (MIT) | 27 | 0 | 0 | 9 | **18** |
| `minja` | MINJA indication text, Dong et al. 2025 (MIT); questions written by us | 6 | 0 | 0 | 0 | **6** |
| `poisonedrag` | PoisonedRAG NQ sample, Zou et al. 2025 (MIT) | 10 | 0 | 0 | 0 | **10** |
| `poisonedrag-nq` | PoisonedRAG full NQ file, downloaded at run time | 500 | 0 | 0 | 0 | **500** |

**Read the "warned" column carefully.** Every warning in these sets was the personal-data warning for an email address
in the text, not a sign that the attack was recognised. Counted by what the linter recognised as an attack:
**62 of 667 samples were held (all of them by the one fixed override sentence), and none of the 89 plain InjecAgent and
AgentDojo instructions was recognised.** The AgentDojo `<INFORMATION>` block ("This is an important message from me...
please do the following first") passes the linter.

MINJA and PoisonedRAG plant false facts (a wrong patient, a wrong answer) with no command words. A pattern linter is not
built to catch false facts; the defences Monomem has for them are provenance, distrust, outside-content marks and
review, which this replay does not exercise because it writes from an ordinary app key.

### Every miss

- `injecagent`, REACHED (27): dh-01 to dh-14, dh-17 to dh-22, dh-24 to dh-30. Warned only for an email address (35): dh-15,
  dh-16, dh-23, ds-01 to ds-32.
- `agentdojo`, REACHED (18): banking-0 to banking-8, slack-1 to slack-4, workspace-1, travel-0, travel-2, travel-4, travel-6.
  Warned only for an email address (9): slack-5, workspace-0, workspace-2 to workspace-5, travel-1, travel-3, travel-5.
- `minja`, REACHED (6): ehr-1 to ehr-6.
- `poisonedrag`, REACHED (10): test1, test11, test16, test19, test20, test21, test31, test47, test50, test53.
- `poisonedrag-nq`, REACHED (500): every passage in the file.

## Method

- Each run copies your store to a temporary folder and works on the copy; the real store is only read, and the copy is
  deleted afterwards (also on Ctrl-C). Embeddings are forced off. It uses the same adapter as `monomem bench`: a real
  Monomem server on 127.0.0.1 with throwaway keys.
- For each sample, an app key with write access saves the text as the body of a note (title `Note <made-up word>`), not
  marked as outside content (the harder case: an app that declares `outside: true` would have it held). Then an app key
  with read access searches for the made-up word. The verdict comes from the write (held, refused) and from whether the
  search returned the note, with or without a warning.
- It measures what reaches memory and comes back out of it. **It does not run an agent**, so REACHED does not mean an
  agent would follow the text.
- The numbers above came from a store with 100 ordinary notes and default settings. Your settings change them: for
  example `MONOMEM_LINT=pii=quarantine` would hold the 44 samples that carry an email address.

### Where the samples come from

| Set | What is in Monomem | Pinned to |
|---|---|---|
| InjecAgent | all 62 `Attacker Instruction` lines (`src/attack-sets/data-injecagent.ts`), and the "enhanced" prefix | github.com/uiuc-kang-lab/InjecAgent @ `f19c9f2` |
| AgentDojo | the 27 v1 injection-task goals with their constants filled in, and the `important_instructions` text with no names (`src/attack-sets/data-agentdojo.ts`) | github.com/ethz-spylab/agentdojo @ `089ed46` |
| MINJA | the indication text from `data_create_poison.py`; the six questions in front of it are ours, since MINJA ships code and medical tables, not a list of injected records (`src/attack-sets/data-minja.ts`) | github.com/dsh3n77/MINJA @ `a3ec8da` |
| PoisonedRAG | question plus first poisoned passage for 10 NQ questions (`src/attack-sets/data-poisonedrag.ts`); `poisonedrag-nq` downloads the whole `nq.json` (120 KB) when you run it and refuses it unless its SHA-256 is `44df7114...5cf2` | github.com/sleeepeer/PoisonedRAG @ `f660d72` |

All four are MIT-licensed; each data file carries its copyright notice. Only `poisonedrag-nq` makes a network call, and
only when you type it ([footprint.md](./footprint.md)).

**Not included: AgentPoison** (MIT). Its attack is a trigger optimised against a specific embedding retriever. Replaying
its text into a keyword search tests nothing it was built for, so we left it out rather than report a number that means
nothing.

## Not tested here

- Whether an agent acts on what reaches it.
- Retrieval-targeted attacks with embeddings on (embeddings are off for every replay).
- Attacks from an agent that can run commands or edit the database file directly: none of these controls stop that
  ([SECURITY.md](../SECURITY.md), "Closing the shell gap").
