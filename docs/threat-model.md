# Threat model: what Monomem defends, what it only partly defends, and what it does not

Read this before you read any number on the website. It says what each defence is, where it stops, and which tests back it.

**The short version.** Monomem is a memory that several agents write to and read from. The main risk is a note that is really an
instruction (or a lie) planted by something an agent read, which a later agent then trusts. Monomem lowers that risk with layers. It does
not remove it. Its write-time checker is pattern matching and says so in its own docs ([memory-linter.md](./memory-linter.md)).

## The layers

1. **Write gate (the linter).** Every write is scanned before it is stored. Suspicious notes are held in a review queue, refused, or
   stored with a warning. Best-effort, not a security boundary.
2. **Read-side banner.** Whatever gets through is shown to the agent inside an untrusted-data banner with the writer's name, so a
   reader can tell a note from an instruction.
3. **Provenance.** Every note records who wrote it, stamped by the server for apps with their own key. Notes that came from outside
   content (a web page, a file) are marked, and cannot be promoted to trusted or pinned by a trusted writer saving them again.
4. **Trust controls.** A person can distrust a writer. Notes from a distrusted writer are removed from every answer. A weak writer cannot
   silently overwrite a trusted note.
5. **A person confirms replacements (since 1.8.0).** An agent can preview replacing a note but cannot approve it. See
   [replacing-memories.md](./replacing-memories.md).
6. **Approve-first namespaces.** Optional. Agent writes in a namespace wait for review.

## Surface by surface

`Covered` = tested, and the test passes. `Partly` = some cases are caught and the rest are listed as known gaps. `Not covered` =
Monomem does not try, or cannot.

| Surface | Status | What it does and where it stops | Evidence |
|---|---|---|---|
| Plain "ignore previous instructions" style text, forged system or tool tags | Covered | Held at write. Also in 14+ languages, with look-alike letters, zero-width characters and one level of base64 or hex | bench E01 to E03, `monomem check --attacks` |
| Instructions hidden in Unicode tag characters | Covered | Decoded and held in every field | E19, [hidden-character matrix](./attack-expansion-2026-11-23.md) |
| Other hidden or special characters (zero-width, bidi, filler, combining marks) | Partly | Read as word breaks or decoded before matching; flagged only in the structures listed in the matrix (bit patterns, 3+ variation selectors, 8+ stacked marks). A single hidden character is not flagged by itself. Per field, what is stored, refused or replaced is pinned in a test | `test/hidden-char-matrix.test.ts` (140 cells) |
| Encodings and uncommon channels (ROT13, reversed text, base32, Morse, number codes, string joins) | Partly | 56 of 67 hand-written probes held, 3 blocked, 1 warned, 7 reached. Pig latin, acrostics, NATO spelling, upside-down text are missed | attack-expansion doc |
| Tool-description style text planted in a note (`<IMPORTANT>` blocks, "before using X first call Y") | Partly | 18 of 23 probes held, 3 warned, 2 reached. Tool steering inside a fact value or a source label is missed | attack-expansion doc |
| Steganography in text | Partly | 49 of 52 held or blocked. Sparse zero-width marks and only three variation selectors are missed | attack-expansion doc |
| Multi-session context poisoning | Partly | The weakest class: 10 of 15 single-note probes reached. A claim with no command words (a payment redirect, a false "correction", a dated sleeper rule) looks like an ordinary note. A slow drip of harmless fragments reaches. A trusted writer saving an attacker's text in its own words reaches (known miss SELF), as does a reworded override (E16; removable afterwards by distrusting the writer) | bench F01, F03, F04, E16, SELF |
| Flooding to bury the trusted answer | Partly | Near-duplicate flooding is handled (E14). Eight keyword-stuffed notes from an outside writer can push the trusted answer out of the top five (F02, known gap) | E14, F02 |
| An agent approving its own replacement of a note | Covered (1.8.0) | Refused unless a person confirms. Limit: an agent that can run shell commands as you can run the `monomem` command | E23, F15, F16, F18 |
| Replacement text that is itself an attack | Covered | Checked by the write gate at preview | F13, F14 |
| Cross-tenant reads and writes | Covered | 0 leaks over the probes in the benchmark | bench suite C |
| Secrets written into a note | Covered | Blocked or redacted | E06, E07 |
| Markdown image or link exfiltration | Covered | Held when it carries data in the address | E11 |
| Public chat-model prompt-injection lists (deepset, Gandalf) | Not a fit | Mostly requests to a chat model, not notes for a later reader. 57 of 80 reach | attack-expansion doc |
| Evidence references (`memory_save` `evidence`) | Gap | Secrets are redacted and the text is printed quoted, but it is not injection-scanned | read from the code, not replayed |
| Poisoned tool descriptions on OTHER MCP servers | Not covered | Monomem cannot see another server's tool list. It checks its own tools' descriptions in a test, nothing more. Use a separate scanner | n/a |
| Whether an agent obeys a note that reaches it | Not measured | The tests measure the write gate and what is served, not model behaviour | n/a |
| Steganography in images or files | Not covered | Monomem stores text | n/a |
| A compromised computer, or an agent with a shell running as you | Not covered | That agent is you, as far as the machine is concerned | n/a |

## What "poison-reach 0" means

`monomem bench` reports `poison-reach-count 0`. That means: across the poisoning scenarios the benchmark defends, none reached an agent
as trusted content. Two things limit it. The scenarios were written by the same team that wrote the linter. And since the 2026-11-23
expansion, most of the defended probes were built from attacks that were already held, so a growing zero is not independent evidence. The
real misses are the declared known gaps and the two designed misses (E16 and SELF). The scorecard ([security-scorecard.md](./security-scorecard.md))
lists outside attack sets where many attacks reach the agent; those numbers are published, not hidden.

On the hand-written expansion probes, the plain count is: 157 attacks, 127 held, 4 blocked, 5 warned, **21 reached**. On a benign set of
188 notes the linter wrongly held 7 and warned on 2 (4.8%), mostly notes that quote an attack phrase on purpose. Details:
[attack-expansion-2026-11-23.md](./attack-expansion-2026-11-23.md).

## Retrieval, in one paragraph

Search is keyword (SQLite FTS5) by default. With a local embedding model it can also run semantic or hybrid. Hybrid scales each side's
scores to 0..1 and blends them 50/50. The retrieval results use several values of k, not only 5, and show where semantic is worse than
keyword. See [BENCHMARK.md](./BENCHMARK.md).

## Send an attack

The scenarios are plain JSON in `bench/scenarios/`, and attack sets are small TypeScript data files in `src/attack-sets/`. If you have an
attack that gets through, open an issue with the note text and the field it goes in. It will be added as a scenario, passing or failing,
and published as a known gap if it is a real miss.
