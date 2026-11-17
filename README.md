<!-- Image URLs are absolute on purpose: GitHub resolves relative paths, npm does not. -->
![Monomem: Shared memory for AI agents that holds writes that match known attack patterns.](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/brand/monomem-banner.png)

**Shared memory for your AI coding agents. It records which app wrote each note and holds suspicious writes until you look at them.**

Tell Claude Code something once, and Cursor, Codex, Gemini CLI and your other assistants can find it too. Everything stays in one file on your own computer: no cloud account, no API keys, no hidden model calls.

## Get it

[![Download for Windows](https://img.shields.io/badge/Download-Windows-0B2E45?style=for-the-badge)](https://github.com/calasdan-sketch/monomem/releases/latest)
[![Download for Mac](https://img.shields.io/badge/Download-Mac-0B2E45?style=for-the-badge)](https://github.com/calasdan-sketch/monomem/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Download-Linux-0B2E45?style=for-the-badge)](https://github.com/calasdan-sketch/monomem/releases/latest)

One download, nothing else to install (no Node needed). Unpack it, then run setup from the folder you unpacked into (`.\Monomem\monomem.cmd setup` on Windows):

```bash
./Monomem/monomem setup
```

Setup finds your apps (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Zed and ten more), shows what it will change, keeps a backup of every file, and asks before it writes. `monomem setup --undo` takes it all back. Already have Node 22.16 or newer? `npx monomem setup` does the same. The download is not code-signed yet; what Windows or macOS may ask, and how to check the file first: [INSTALL.md](./INSTALL.md#download-no-nodejs-needed).

**What it costs your assistant.** The seven tools shown by default add 6,160 characters of tool descriptions, about 1,540 tokens. A session start adds up to about 1,500 tokens of your notes (you can change that limit).

**What it does not do.** Please read this before you rely on it:

- The write check is pattern matching. A reworded attack it does not know can get through; `monomem check --attacks` replays the 26 it knows (2 are known misses).
- It only guards what goes through Monomem. An app that can run shell commands (Claude Code included) or open the database file can read or change your notes directly.
- For apps connected on your computer, the writer name comes from that app's config file. It tells your apps apart; it is not proof.
- Keyword search finds words, not meaning, unless you run a local embedding model (Ollama).
- The download has not been tested with Windows Smart App Control switched on or on a Mac.
- claude.ai and ChatGPT can connect only through OAuth, which is off by default and a preview: [docs/oauth.md](./docs/oauth.md).

Every limit we know of: [docs/known-limits.md](./docs/known-limits.md).

## Try it

After setup, restart your apps. In one of them, say **"Save to Monomem: my staging server is on port 8443"**. In a different app, ask "What port is my staging server on?". Say "Save to Monomem" rather than just "remember", because some assistants keep a memory of their own that your other apps cannot see. Step by step: [docs/live-claude-code.md](./docs/live-claude-code.md).

`monomem open` shows your notes in the browser. `monomem check` gives one grade with the reason. `monomem review` lists anything that waits for you. `monomem demo` runs a short tour on a throwaway store and never touches your notes.

![A write that matches a known attack pattern is held, a second agent's search never sees it, and the dashboard rejects it](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/monomem-demo.gif)

*An older recording (2026-11-05, on 1.5.0, before the dashboard redesign) of a real run against a throwaway store: a write with an injected instruction is held, never reaches the other agent's search, and is rejected from the dashboard. [Transcript](https://github.com/calasdan-sketch/monomem/blob/main/docs/brand/demo-transcript.txt).*

## Why not just CLAUDE.md?

`CLAUDE.md` and `AGENTS.md` are good for rules you write yourself, and Monomem leaves them alone. Monomem is for what your agents learn while they work: every note says who wrote it, keeps its earlier versions, and a write that looks like a planted instruction waits for you. Coming from Claude Code's own memory, claude-mem, mem0 or basic-memory: [docs/switching.md](./docs/switching.md). How it compares: [docs/comparison.md](./docs/comparison.md).

![How Monomem works: your agents save through MCP or REST; a write check refuses secrets and holds writes that match known attacks until you approve them; one SQLite file keeps each note's writer, history and privacy label; reads hide private notes from limited apps and leave out distrusted writers.](https://raw.githubusercontent.com/calasdan-sketch/monomem/main/docs/monomem-architecture.png)

## Benchmark

`monomem bench` checks what a shared agent memory needs: that one agent cannot silently turn a weak guess into shared truth. It is deterministic, offline, uses no model, and exits 1 on any failure, so it can gate CI.

| Suite | Scenarios | What it checks | Headline number |
|---|---|---|---|
| A  Stale memory | 38 | a fact updated, replaced, deleted or aged: is the current value first and the old one never shown (or flagged)? | `stale-hit-rate@1/@5`, `current-recall@1` |
| B  Contradiction recovery | 31 | writer A against writer B, then a trusted correction; distrusting the bad writer; a weak overwrite of a trusted note | resolved to the correction, loser stays visible, overwrite protected |
| C  Permission isolation | 27 | one tenant cannot read, write, search, export or undo another's notes; key scopes; signed imports | `leakage-count` (must be 0), `unexpected-denials` |
| D  Provenance retention | 19 | source, writer, creator, timestamps and confidence survive export, import, merge and update | `fields-lost` |
| E  Memory poisoning | 22 | injected or malicious memories never reach an agent as trusted content (held, refused, stored with a warning, or left out once the writer is distrusted) | `poison-reach-count` (must be 0) |

**What it does not measure.** It is not a retrieval-quality or semantic-search benchmark, and it does not measure speed, scale or concurrency. "0 leaks" means none of *these* probes leaked: it is a regression gate, not an audit. Known gaps in the benchmark: none open; the history is in [docs/BENCHMARK.md](./docs/BENCHMARK.md#known-gaps-history).

**Retrieval.** On LongMemEval-S (470 questions) keyword search finds a right conversation in the top 5 for 97.2 % of questions (one Windows PC, measured 2026-11-15 on 1.5.0; search ranking is unchanged since). That is a retrieval number, not answer accuracy, and it is not the highest published. Every number, and where Monomem is worse: [docs/BENCHMARK.md](./docs/BENCHMARK.md#retrieval-longmemeval-s-and-locomo).

## Documentation

| | |
|---|---|
| [INSTALL.md](./INSTALL.md) | the download, npm, and every MCP client by hand |
| [docs/features.md](./docs/features.md) | what it does, in detail, and the security model |
| [docs/tools.md](./docs/tools.md) | every MCP tool and its token cost, every command |
| [docs/backups.md](./docs/backups.md) | where your data lives, daily backups, restore |
| [docs/upgrading.md](./docs/upgrading.md) | what changes per release, and how to go back |
| [docs/sensitivity-labels.md](./docs/sensitivity-labels.md) · [limited access](./docs/give-an-app-limited-access.md) | private notes, and giving one app its own key and a limit |
| [docs/README.md](./docs/README.md) | every other guide, by what you want to do |
| [SECURITY.md](./SECURITY.md) · [CHANGELOG.md](./CHANGELOG.md) | what it protects against and what it does not; release notes |

[![CI](https://github.com/calasdan-sketch/monomem/actions/workflows/ci.yml/badge.svg)](https://github.com/calasdan-sketch/monomem/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/monomem)](https://www.npmjs.com/package/monomem)
![License](https://img.shields.io/badge/license-MIT-blue)
[![Monomem MCP server](https://mcprush.com/badge/monomem-mcp/card.svg)](https://mcprush.com/to/monomem-mcp?ref=badge)

*The mcprush card is an independent scan's grade: it reads the published package, not our claims.*

## Credits and license

Ideas adapted, with thanks, from [llmem](https://github.com/netrixone/llmem), lontar (rymanalu) and [lossless-memory](https://github.com/aru-labs/lossless-memory); what came from each is in [docs/features.md](./docs/features.md#credits).

MIT, see [LICENSE](./LICENSE). Built by Calas Automations Inc.
