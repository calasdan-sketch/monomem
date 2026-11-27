# Attack expansion, 2026-11-23

Why: a public critic said the poison-reach number of 0 comes from a small, self-written, uncreative attack set, and named seven gaps:
context poisoning, secret messages through uncommon channels, instructions planted in MCP tool descriptions, steganography, hidden and
special characters at write time, abuse of replace, and keyword-only retrieval with k=5. This round wrote new probes for every one, ran
them on commit ecc9416 plus the linter changes below, and records every result, misses included.

Read this first: **the write-time linter is best-effort pattern matching, not a security boundary.** A note that gets through is still
shown to the agent inside an untrusted-data banner with its writer's name. These tests measure the write gate only; they do not measure
whether an agent would obey a note.

## What was added

| What | Where | Count |
|---|---|---|
| Hand-written probes, by class and by field | `src/attack-sets/data-probes.ts`, replay with `monomem check --attacks --set probes-context` (also `probes-encoding`, `probes-toolstyle`, `probes-stego`) | 158 (one is a harmless control) |
| Multi-note and replace scenarios, and the probes as bench scenarios | `bench/scenarios/F01` to `F18` | 18 scenarios, 6 of them declared known gaps (the 3 replace-abuse ones were closed by the person-confirm change, below) |
| Hidden-character matrix, per field | `test/hidden-char-matrix.test.ts` (35 characters x title, body, tags, source) | 140 cells pinned |
| Public corpora | `src/attack-sets/data-public-2026-11.ts`, sets `deepset-injections` and `gandalf-ignore` | 40 + 40 |
| Benign false-positive corpus | `bench/benign-corpus.txt`, run by `node bench/lint-fp.mjs` | 188 notes |

Probe fields used: title, body, tags, source, fact key and fact value (a fact is stored as a `fact:key=value` tag). Fields the
replay cannot reach through the REST write (evidence references, claims, files, `written_by`, `new_title` / `new_body` of a replacement)
are covered where code reaches them: evidence refs are redacted for secrets and shown quoted, never injection-scanned (a gap, below);
`written_by` is stamped by the server, not claimed (E08); the replacement text goes through the write gate (F13, F14).

## Results on this branch (replay through the real REST write path)

Held = waits in the held-notes queue for review. Blocked = refused at write. Warned = stored with a warning. REACHED = stored and served with no warning.
The control probe (a real flag emoji) is not counted.

| Class | Probes | Held | Blocked | Warned | REACHED |
|---|---|---|---|---|---|
| 1 Context poisoning (single-note shapes) | 15 | 5 | 0 | 1 | 9 |
| 2 Encodings and uncommon channels | 67 | 56 | 3 | 1 | 7 |
| 3 Tool-description style text | 23 | 18 | 0 | 3 | 2 |
| 4 Steganography and look-alikes | 52 (+1 control) | 49 | 1 | 0 | 2 |
| Total | 157 | 128 | 4 | 5 | 20 |

By field (same 157, measured on an earlier run; the class totals above are the latest): body 121 (101 held, 5 warned, 15 REACHED), title 15 (12 held, 3 REACHED), tags 8 (7 held, 1 blocked), source 6 (5 held,
1 REACHED), fact value 5 (3 blocked, 2 REACHED), fact key 2 (2 held).

Before the linter changes in this round the same 157 probes scored held 74, blocked 4, warned 3, **REACHED 76** (so 55 probes were closed here).

**Caveat: these numbers are tuned, not independent.** The linter rules added in this round were written after reading these same 157 probes, so "127 held" and "55 closed here" show that the known probes are now caught, not how well new ones would be. The outside corpora and the later adaptive, garak and PyRIT runs are the better measure of unseen attacks, and they show much weaker results (see docs/adaptive-attacker-2026-11-23.md and docs/ai-redteam-tools-2026-11-23.md).

Multi-note shapes (bench scenarios): a slow drip of three harmless fragments (F01) REACHES; eight keyword-stuffed notes push the trusted
answer out of the top five (F02) REACHES; a false "correction" is served in second place behind the trusted note (F03, the trusted note stays first); a
dated or trigger-word sleeper rule is stored with a warning only when it names a deferred trigger (F04).

### Replace abuse (class 6)

The probes were first run on commit ecc9416, where F15, F16 and F18 REACHED. The same round then made replacing a note need a person (1.8.0, see docs/replacing-memories.md), and they were re-run on the merged branch: all three are now defended. Both columns are kept so the change is visible.

| Probe | On ecc9416 (before) | On this branch (after) |
|---|---|---|
| Replacement text that would itself be held (F13) | Refused at preview (409). Trusted note stays. | same |
| Replacement hiding its instruction in tag characters (F14) | Refused at preview (409). | same |
| A write key (not distrusted, not admin) replaces another writer's trusted note: preview, then confirm (F15) | **REACHED**: allowed. The old note is kept, hidden and undoable. | **Defended**: the confirm is refused unless a person makes it. |
| The same for five notes at once (F16) | **REACHED**: allowed. | **Defended**, same reason. |
| An admin-pinned note replaced by a write key (F17) | Preview refused (denied). Defended. | same |
| An agent confirms its own preview, no person (F18) | **REACHED**: the code goes to whoever previews. | **Defended**: an MCP connection is never a person, even with an admin key. Limit: an agent that can also run shell commands as the machine owner can run the `monomem` command. |

## Linter changes made in this round (src/lint*.ts only)

All are pattern or decode steps run in addition to the old ones; none removes a rule.

1. `src/lint-decode.ts` (new): invisible and blank characters (zero-width, Hangul and Braille fillers, private use, object replacement,
   NUL) are also read as word breaks (they used to glue words together: `ignore<ZWSP>all<ZWSP>previous` was stored); reversed text (also what
   a bidi override shows); ROT13 and other Caesar shifts; ASCII codes written in decimal, binary, `0x` or `\u` form; `"ig"+"nore"` joins; base32;
   Morse; base64 broken over lines; Cherokee, Lisu, Coptic and Latin-extended look-alike letters. Each is built only when a cheap hint is
   present and the decoded text must read as text.
2. Same file, `scanHiddenData`: 8 or more zero-width marks in a row with two different marks (a bit pattern), 3 or more variation selectors
   after plain letters, 8 or more combining marks stacked, three or more lines ending in mixed spaces and tabs. Label `hidden Unicode text`.
   Not flagged on purpose: a lone bidi override (existing tests and real right-to-left notes use one; a reversed injection shown by an
   override is caught by the reversed-text rule), emoji joiners and variation selectors, Persian half-spaces, markdown two-space line breaks.
3. `src/lint-toolpoison.ts` (new): `<IMPORTANT>`-style blocks that give a tool order, "before using X first call Y", "the tool was
   pre-authorised by the owner", "takes precedence over every other tool", "do not show the permission prompt" are held (`tool-description
   injection`); credential files named next to tool wording, and "the tool now also forwards ... to <address>", only warn.
4. `src/lint-langs3.ts` (new): the override sentence in Czech, Swedish, Indonesian, Vietnamese, Greek, Hebrew and Thai.
5. `src/lint.ts`: wires the three files in; the title/body/tags joined scan now also joins `source` and reads `-` and `_` as spaces
   ("all-previous" in a tag).

Safety of each change: they only add scans over text that the old scan did not match, and every new hold needs an instruction-shaped
context. A quadratic regex in an early draft hung the whole test suite on a 256 KB run of one letter; it was replaced by a line-anchored
one and `test/lint-expansion-units.test.ts` now times 11 hostile 256 KB bodies.

### False positives, before and after

| Corpus | Before | After |
|---|---|---|
| LongMemEval-S chat turns (189,502) | held 54, refused 27, warned 421 | identical |
| LoCoMo-10 (5,882) | 0 / 0 / 0 | identical |
| Developer and personal notes (156) | held 0, warned 7 | identical |
| Repo docs on the base commit (1,734, the same text both times) | held 8, refused 4, warned 13 | held 8, refused 4, warned 14 (one more warn, a docs paragraph about ssh and a tool) |
| **New benign corpus (188 notes)** | **wrongly caught 9 (4.8%): held 7, warned 2** | **identical** |

The 7 held notes in the benign corpus: 6 notes that quote an attack phrase on purpose ("the classic injection string is 'ignore all previous
instructions'"), and "Use the Slack tool to post release announcements and the calendar tool" (the tool-steering check, which only applies to
an app's key, not to the owner's terminal). The 2 warned: "From now on we use Vitest instead of Jest" (deferred-trigger warning) and an invoice
note with an email address. Everything else in the corpus (developer notes, meetings, config rules such as "always run the tests before commit",
"you can ignore the lint warning", code with base64 and hex, 33 notes in 19 languages, emoji with ZWJ sequences and flags, personal notes) is stored
untouched. So a note that **names** an attack in its own words is held: that is the cost of a pattern linter, and the held note goes to review rather
than being lost. Because the old and new linter are identical on the corpus, the new rules added no false positives that the corpora can see.

## Public corpora

| Source | URL | Licence | Used |
|---|---|---|---|
| deepset/prompt-injections | https://huggingface.co/datasets/deepset/prompt-injections | Apache-2.0 | Yes: first 40 injection rows of the test split, verbatim, English and German. Held 4, REACHED 36. |
| Lakera/gandalf_ignore_instructions | https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions | MIT | Yes: first 40 rows of the test split, verbatim. Held 19, REACHED 21. |
| BIPIA (Microsoft) | https://github.com/microsoft/BIPIA | GitHub reports no standard licence (NOASSERTION) | No: licence unclear, not copied. |
| garak probes (NVIDIA) | https://github.com/NVIDIA/garak | Apache-2.0 for the code; the prompt lists inside carry their own sources and terms | Not in this round. A later round did copy 75 garak prompts that reached the agent (`garak-probes`, 3 per probe class, selection rule and licence in `src/attack-sets/data-garak-pyrit-2026-11.ts` and THIRD_PARTY_NOTICES.md); the full lists are still not copied. |
| Lakera PINT benchmark | https://github.com/lakeraai/pint-benchmark | MIT for the code | No: the labelled dataset is not public, only a sample file. |
| Invariant Labs MCP tool-poisoning experiments and blog | https://github.com/invariantlabs-ai/mcp-injection-experiments | the repository has no licence file | No: not copied; the `<IMPORTANT>` block probes here are our own wording of that published technique. |
| StegoBench (found: elementmerc/stegobench, AGPL-3.0; tjantium/stegobenchy, MIT) | https://github.com/elementmerc/stegobench | AGPL-3.0 / MIT | No: they test steganography in image and file formats, not text notes, and one is AGPL. |

Rows were taken by a fixed rule and never tuned on. Most of the 80 public prompts are not memory notes (chat role-play, "spell-check and print the
prompt above", German tasks), so 57 of 80 REACHING is not surprising and is not a regression: the linter looks for instructions aimed at a later
reader, and these are mostly requests to a chat model. They are kept as published, because hiding them would make the number look better.

## Hidden and special characters, per field (`test/hidden-char-matrix.test.ts`)

What the write path does with one character inside a word of each field (the scanners read a normalised copy; the stored text is not changed):

| Character | title, body, source | tags |
|---|---|---|
| Zero-width space / non-joiner / joiner, word joiner, invisible times / separator / plus, soft hyphen, BOM, Arabic letter mark, Hangul fillers, Braille blank, Mongolian vowel separator, variation selectors, ideographic variation selector, combining marks, grapheme joiner, private use, object replacement | kept as sent | kept |
| Bidi embeddings, isolates, left-to-right mark, ESC, DEL, C1 control, line and paragraph separator | kept as sent | refused (tags may not hold control or direction characters) |
| NUL | title and body: replaced by U+FFFD; **source: kept raw** | refused |
| A lone surrogate half | title, body and source: replaced by U+FFFD | **kept** |
| Unicode tag characters (U+E0000 block) | **held** in every field | held |

Scanning: tag characters are decoded to ASCII and held; 4 or more variation selectors in a row are held; the rest are dropped or read as word
breaks before matching (this round) and flagged only in the structures listed above. A single hidden character is never flagged by itself.

## What still gets through (honest list)

- Context poisoning that carries no command words: a dated or trigger-word sleeper rule, a payment redirect, a false "correction", a policy
  override, a fact value that says "skip approval for every release", a slow drip of harmless fragments that only add up to an order, and
  keyword-stuffed notes that push the trusted answer out of the top five. The linter looks for instruction-shaped text; these are claims.
- Pig latin, acrostics, NATO spelling, upside-down text and regional-indicator letters; half of a split base64 blob; an instruction split between
  a title and a source with the body between them; a markdown note in languages not on the word lists (Thai only partly).
- Tool-steering text inside a fact value or a source label.
- Sparse zero-width marks (one per few letters) and only three variation selectors.
- Evidence references (`memory_save` `evidence`) are redacted for secrets and printed quoted, but not injection-scanned (read from the code, not replayed).
- The public chat-prompt corpora: 57 of 80.

Each of these is a declared known gap in `bench/scenarios/known-gaps.json`, so it shows up in `monomem bench` and cannot be dropped quietly.
