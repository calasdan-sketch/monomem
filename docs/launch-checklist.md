# Launch checklist (internal, not shipped in the npm package)

Written 2026-11-25 for the maintainer. Nothing here has been released, posted, signed up for or submitted. Every step marked **needs your yes** is yours to decide. This file is excluded from the npm package in `package.json` `files`, like `docs/LAUNCH.md`.

## Ready now (done in the repository)

| What | Where | Note |
|---|---|---|
| README first screen: the one pitch, the 60-second demo, one-line install, "What it is NOT" | `README.md` | Says `npx monomem demo --open`, which only works once the release that contains `demo --open` is on npm |
| Dated, sourced comparison with rivals ahead stated first | `docs/comparison.md` | Dated 2026-11-25. Rival cells are "verified" with a link or "not verified". The measured section is labelled as a frozen build before the 2026-11-25 fixes |
| MAMB write-up with its failures and limits | `docs/mamb.md` | States the harness is not public |
| "Lossless" defined as six checks, L1 to L6 | `docs/lossless.md` | The word "lossless" is used only with that definition |
| How to verify a download, SBOM, provenance | `docs/verify.md` | Not code-signed; says so |
| Benchmark run on this tree | `monomem bench` | 171 scenarios: 151 pass, 20 known gaps, 0 fail (run 2026-11-25) |

## Do these before any post (no yes needed, but nothing else works without them)

1. **Run the full test suite alone on a quiet PC** (`npm test`, nothing else running) and write the real totals in the release notes. The audit could not finish a clean run on a loaded machine; do not quote a test count publicly until you have one.
2. **Re-run `monomem bench`, `monomem check --attacks` and `monomem check --crash` on the release build** and compare to the numbers below. If one differs, fix the text, not the number.
3. **Demo GIF re-recorded on 1.8.0 (2026-11-27)** with `npm run demo-gif`; the architecture diagram, PNG and GIF were redrawn the same day (seal and signed ledger added).
4. **Click "Undo what it did" on the `web-clipper` writer in `demo --open` by hand once.** The build agent did not click it through in a browser.
5. **Check the `demo --open` folder is deleted** after Ctrl+C and after closing the terminal on Windows (a hard-closed terminal may leave a `monomem-demo-open-*` folder in `%TEMP%`).
6. **Look at the cold-start lock** (about 4% of instances in MAMB when up to eight processes start at once on an empty folder). A new user with two apps starting at login may meet it. A fix is not in this patch.
7. **Re-read the competitor cells** older than 30 days before the post, and the Vestige and agentmemory numbers in `docs/BENCHMARK.md` (they are the rivals' own claims).

## Needs your yes

| Step | Why it needs you | Order |
|---|---|---|
| Release 1.8.0 (version bump, tag, npm publish, GitHub release with the SBOM and checksums) | Publishes under your name; `package.json` still says 1.7.0 and `docs/lossless.md` already says 1.8.0 | 1 |
| Merge the README to the public repository **with** the release, not before | The README promises `demo --open` | 1 |
| Post on Show HN (draft below) | Posts under your name | 2, after the release has been live and tried from a clean machine |
| Create a neutral GitHub organisation for the benchmark | A sign-up; the benchmark should not carry the Monomem or Calas name | 3 |
| Submit the SignPath Foundation application | Drafted at `docs/internal/signpath-foundation-application-DRAFT.md`, not submitted; its terms are marked unverified and a `.cmd` launcher cannot be signed, so the compiled-launcher work comes first | 3 |
| Comment on ai-memory issue 7254 offering the benchmark adapter | Posts under your name; only after the benchmark is public | 4 |
| Listings (Glama, awesome-mcp-servers, MCP Market) | Sign-ins and pull requests; see `docs/listing-checklist.md` | 2 |
| Tick "Require review from Code Owners" in branch protection | A GitHub setting only the owner can change | 2 |

Do not post before the release is live and a stranger-style first run (download, `monomem setup`, demo) has worked on a machine that is not yours.

## Numbers you may quote (each with where it comes from)

| Number | Source | Re-checked |
|---|---|---|
| 171 scenarios, 151 pass, 20 known gaps, 0 fail; 7 open gap ids | `monomem bench` on this tree | 2026-11-25 |
| 27 known attacks replayed, 2 known misses | `monomem check --attacks`, `test/drill.test.ts` | Not re-run today; confirm |
| Kill test: 48 kills, 119 acknowledged writes, 119 present, integrity ok | `monomem check --crash`, scratch store (build agent's run) | Not re-run today; confirm on release |
| LongMemEval-S retrieval, all 470: right conversation in the top 5 for 97.4%, every right one for 86.0% (keyword) | `docs/BENCHMARK.md`, re-measured 2026-11-23 | **Not re-run today**: the dataset file is not in this checkout. The frozen-build head-to-head got 97.2 and 85.7 without question dates |
| Answer accuracy, 7B local reader, 60 questions: Monomem 53.3%, plain BM25 53.3% (a tie) | `docs/BENCHMARK.md`, accuracy section | Self-run, one seed |
| MAMB: Monomem 132/150, official MCP memory server 45/150 | `docs/mamb.md` | **Do not use in the post** while the harness is private: nobody can rerun it |

Do not write: "number one", "best", "lossless" without the six-check definition, "secure", "unbreakable", "audited", "reviewed", or any claim that a rival lacks a feature (say "not documented").

## Draft: Show HN title (not posted)

> Show HN: Monomem – shared memory for AI agents, with an undo button

(67 characters. Alternative if the length is wanted: `Show HN: Monomem – one local memory for Claude Code, Cursor and Codex, with undo`, 78.)

## Draft: first comment (not posted)

Check every number against the release before posting.

> I run Claude Code and Cursor on the same projects. Each had its own memory, and nothing told me which agent had written a wrong fact. Monomem is a local MCP server with one SQLite file. Every note records which app wrote it, a write that matches a known prompt-injection pattern is held until you approve it, and `monomem rollback --writer <name>` (or one click in the dashboard) undoes what one agent wrote. No cloud, no API keys, no model in the write path.
>
> You can try it without touching your agents: `npx monomem demo --open` starts a throwaway store with a held write and a bad writer you can undo. Closing the terminal deletes it.
>
> What I measured, all on one Windows PC, all run by me: 171 provenance scenarios (stale facts, conflicts, permission isolation, poisoning), 151 pass and 20 are known gaps I list in the repo. `monomem check --crash` kills four writers with kill -9 over 12 rounds, and on my machine every acknowledged write was still there. Keyword search finds a right conversation in the top 5 for 97.4% of LongMemEval-S questions. That is retrieval, not answer accuracy: with a 7B local reader, Monomem tied plain BM25 (53% against 53% on 60 questions), so I have no answer-accuracy win to claim.
>
> Where it is behind: other tools have more stars, hosted options, graph memory and published answer-accuracy numbers, and two of them document signed writer identity. The attack check is pattern matching, so a reworded attack can pass, which is why undo exists. The writer name for local apps comes from a config file and is not proof. The Windows download is not code-signed, Mac and Linux are untested, and nobody outside the project has reviewed the security. The comparison page lists these with sources and dates: `docs/comparison.md`.
>
> I would most like to hear from anyone who runs two or more agents and can tell me where the first five minutes went wrong.

## After the post

- Answer every comment yourself. Do not ask anyone to upvote or comment.
- If someone finds a number that is wrong, fix the page the same day and say so in the thread.
- Next, in order: the public benchmark under a neutral name (with rivals' adapters and Monomem's failures in the table), then `monomem report` attached to the release.
