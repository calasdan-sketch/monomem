# How Monomem compares

**Dated 2026-11-25.** This page compares Monomem with thirteen other memory tools, and says where they are ahead first.

How to read it:

- **Verified** means we read the claim on the product's own page (README, release notes, pricing page, GitHub API) and the cell links to it. Stars, releases and pricing were read on 2026-11-24. Downloads are the last 30 days to 2026-11-23. The older detail tables further down were read on 2026-11-16 and 2026-11-17.
- **Not verified** means we did not confirm it from a primary page. It does not mean the product lacks the feature.
- **Not documented** means we read the page and it says nothing on the topic. That is not proof of absence either.
- Products change quickly. Check the linked source before you rely on a cell.
- Numbers about other products are theirs, from their own pages, and we did not re-run them unless a row says **measured here**.

Monomem is not affiliated with, endorsed by or sponsored by any product named on this page; the names are trademarks of their owners.

## Where Monomem is behind (stated first)

### Adoption

Monomem has 12 GitHub stars and about 4,966 npm downloads in 30 days (the author's own count, 2026-11-24). Nobody outside the project has reviewed its security.

| Product | GitHub stars (2026-11-24) | Downloads, last 30 days | Source |
|---|---|---|---|
| claude-mem | 119.6k | npm 396k | [repo](https://github.com/thedotmack/claude-mem), [npm](https://www.npmjs.com/package/claude-mem) |
| mem0 | 69.4k | npm 1.04M, PyPI 2.4M | [repo](https://github.com/mem0ai/mem0), [npm](https://www.npmjs.com/package/mem0ai) |
| Hindsight | 63.2k | npm client 268k | [repo](https://github.com/vectorize-io/hindsight) |
| Official MCP memory server | 92.2k (whole `servers` repo) | npm 1.33M (inflated by default templates, our inference) | [repo](https://github.com/modelcontextprotocol/servers) |
| cognee | 33.6k | PyPI 183k | [repo](https://github.com/topoteretes/cognee) |
| supermemory | 31.7k | npm 867k | [repo](https://github.com/supermemoryai/supermemory) |
| agentmemory | 30.6k | npm 97k | [repo](https://github.com/rohitg00/agentmemory) |
| Zep / Graphiti | Graphiti 33.1k, Zep 5.0k | not verified | [Graphiti](https://github.com/getzep/graphiti), [Zep](https://github.com/getzep/zep) |
| Letta | letta 25.5k, letta-code 3.9k | not verified | [letta](https://github.com/letta-ai/letta), [letta-code](https://github.com/letta-ai/letta-code) |
| Engram | 8.3k | not verified | [repo](https://github.com/Gentleman-Programming/engram) |
| basic-memory | 4.7k | PyPI 58.8k | [repo](https://github.com/basicmachines-co/basic-memory) |
| Vestige | 664 | not verified | [repo](https://github.com/samvallad33/vestige) |
| ai-memory | 58 | not verified | [repo](https://github.com/alphaonedev/ai-memory-mcp) |
| **Monomem** | 12 | npm about 4,966 | [repo](https://github.com/calasdan-sketch/monomem) |

### Hosted option, cloud sync, graph, published answer accuracy

| Product | Hosted option or cloud sync | Graph or entity memory | Published answer accuracy (their own, self-reported) |
|---|---|---|---|
| mem0 | Hosted platform with a free tier ([pricing](https://mem0.ai/pricing)) | not verified | LoCoMo 92.5 and LongMemEval 94.4 on the managed platform, with "proprietary optimizations not available in the open-source" version ([README](https://github.com/mem0ai/mem0)) |
| Zep / Graphiti | Hosted Zep, SOC 2 Type II and HIPAA badges on its pricing page ([pricing](https://www.getzep.com/pricing)) | Temporal knowledge graph ([Graphiti README](https://github.com/getzep/graphiti)) | not verified |
| Letta | Letta cloud ([pricing](https://www.letta.com/pricing)) | not verified | none headline ([letta-code](https://github.com/letta-ai/letta-code)) |
| supermemory | Hosted accounts ([pricing](https://supermemory.ai/pricing)) | not verified | Claims first place on LongMemEval, LoCoMo and ConvoMem ([README](https://github.com/supermemoryai/supermemory)); we did not re-run it |
| cognee | A cloud exists, price not verified ([README](https://github.com/topoteretes/cognee)) | Graph built by an LLM ([README](https://github.com/topoteretes/cognee)) | A BEAM evaluation report in its repo ([README](https://github.com/topoteretes/cognee)) |
| basic-memory | Cloud, $15 a month with a 7-day trial ([README](https://github.com/basicmachines-co/basic-memory)) | not verified | none headline ([README](https://github.com/basicmachines-co/basic-memory)) |
| Official MCP memory server | not verified | A knowledge graph of entities and relations ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) | none ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) |
| agentmemory | not verified | not verified | Retrieval only: LongMemEval-S with keyless BM25, 96.2 any-relevant and 84.7 all-required ([README](https://github.com/rohitg00/agentmemory)) |
| Hindsight | Hindsight Cloud, usage-based ([README](https://github.com/vectorize-io/hindsight)) | not verified | Claims state of the art on LongMemEval, reproduced by a university lab and a newspaper per its README ([README](https://github.com/vectorize-io/hindsight)); we did not check that |
| ai-memory | not verified | not verified | none headline ([README](https://github.com/alphaonedev/ai-memory-mcp)) |
| Vestige | not verified | not verified | Retrieval only: 97.45 and 86.60 on LongMemEval-S, its own claim ([benchmarks](https://github.com/samvallad33/vestige)) |
| claude-mem | not verified | not verified | none headline ([README](https://github.com/thedotmack/claude-mem)) |
| Engram | not verified | not verified | none headline ([README](https://github.com/Gentleman-Programming/engram)) |
| **Monomem** | None. Local file sync through git or files ([file-sync.md](./file-sync.md)); no hosted service | None, by design | **Not comparable.** Retrieval is published ([BENCHMARK.md](./BENCHMARK.md)). Answer accuracy with a 7B local reader tied plain BM25 (see below); no GPT-class reader was run |

### Signed identity and signed downloads

- ai-memory signs agent ids with Ed25519 ([README](https://github.com/alphaonedev/ai-memory-mcp)). Vestige keeps a hash-chained, signed append-only log ([README](https://github.com/samvallad33/vestige)). Monomem's writer name for local apps comes from a config file, so it tells apps apart but is not proof.
- ai-memory, Vestige and Engram ship one compiled program ([Engram](https://github.com/Gentleman-Programming/engram)). Whether their binaries are code-signed: not verified by us. Monomem's own download is **not** code-signed; what it does offer is in [verify.md](./verify.md).

### Install, apps and hosted chat apps

- **Install.** Engram, Vestige and ai-memory ship one compiled program. Monomem's download is a folder that runs Node's official
  program (Task Manager shows "Node.js JavaScript Runtime"), and it is not code-signed yet: see
  [INSTALL.md](../INSTALL.md#download-no-nodejs-needed).
- **How many apps setup connects.** `monomem setup` connects seventeen apps ([apps.md](./apps.md)). Engram documents fourteen.
  claude-mem's README says it works with 15 agents (Claude Code, Codex, Cursor, OpenCode "and 11 more"), and names 5 that
  can only search memory (Copilot CLI, Goose, Roo Code, Warp, Zed). agentmemory's README table names 26 agents and says it
  works with any agent that speaks MCP or HTTP.
- **Hosted chat apps.** claude.ai, ChatGPT and the Claude phone app can connect over OAuth, but in Monomem
  it is off by default and a preview (one internal security review, no outside review), and you need your own HTTPS address that
  reaches your computer, such as a Tailscale Funnel or Cloudflare Tunnel ([oauth.md](./oauth.md)). Hosted tools such as
  Notion need no tunnel.


## Where Monomem leads

Each row names its evidence and what it does not show.

| Area | Monomem | Evidence and limit |
|---|---|---|
| Per-writer provenance in search results | Every note records its writer; for apps with their own key the server stamps it and a client cannot set it | **Measured here** (poisoning probe below): Monomem stamped a writer on its results and labelled it. The six others did not (mem0 and mcp-memory-service echoed an id only because the caller passed it). ai-memory and Vestige document signed writer identity, which we did not probe |
| Held writes | Writes that match a known attack pattern are held until a person approves; other agents cannot see them | Measured in the same probe: an overt injected instruction was held. A plain false claim was not held. ai-memory documents a pending queue ([README](https://github.com/alphaonedev/ai-memory-mcp)) |
| Rollback by writer | `monomem rollback --writer <name>` undoes what one agent wrote | No rival README we read documents it (see matrix), which is "not documented", not proof of absence. Tested in this repository; not tested by anyone else |
| Undo | Replace and archive can be undone; 20 earlier versions per note by default | Rivals with git or append-only history also keep history ([Letta](https://github.com/letta-ai/letta-code), [Vestige](https://github.com/samvallad33/vestige)) |
| Local only, no LLM in the write path | One local file; no model is called when a note is saved | mem0 and Graphiti document LLM extraction on write ([mem0](https://github.com/mem0ai/mem0), [Graphiti](https://github.com/getzep/graphiti)). basic-memory, ai-memory, Vestige and the official server document none ([basic-memory](https://github.com/basicmachines-co/basic-memory)), so this is not unique |
| Crash and concurrency | Under a kill -9 test and a 10-process write test, no acknowledged write was lost | **Measured here** (below and in [mamb.md](./mamb.md)). The official MCP memory server also lost none, so this is a tie, not a lead. The lossless checks are in [lossless.md](./lossless.md) |
| Scope matrix | A restricted app (namespace, sensitivity ceiling, distrusted writers, archived or held notes) gets the same answers as if the hidden notes did not exist | A test in this repository (`test/scope-matrix.test.ts`) compares two stores byte for byte across REST, MCP and export. Self-written; not reviewed by anyone else. Zep and cognee document access control of their own ([cognee](https://github.com/topoteretes/cognee)); we did not compare |

## Measured here (frozen build, before the 2026-11-25 fixes)

These numbers come from a head-to-head run on **one shared Windows PC** on 2026-11-24 and 2026-11-25. The Monomem build tested is a frozen snapshot **before the 2026-11-25 fixes**; do not read these numbers as what the current tree scores. Competitors were installed from their package registries or release pages and run as a normal user, with no accounts and no cloud keys. The machine and its local model server were shared with other test jobs, so latencies are about twice as slow as on a quiet machine: trust the order, not the digits. The harness and raw files are internal and not published; sample sizes and confidence intervals are in the internal report. Treat this as a self-run result, not an audit.

### LongMemEval-S, all 470 questions (retrieval: is a right conversation in the top 5)

| Contender | R@1 | R@5, any right one | R@5, every right one |
|---|---|---|---|
| Monomem hybrid (needs a local embedding model) | 92.1 | 98.7 | 89.6 |
| Monomem keyword (default) | 87.4 | 97.2 | 85.7 |
| Plain BM25 (our 30-line baseline) | 86.6 | 97.0 | 83.0 |
| Official MCP memory server | 0.2 | 0.2 | 0.0 |

Monomem keyword against plain BM25 at R@5 "any" is a tie (6 against 5 questions, p = 1.0). It is ahead on "every right one" (+2.7 points, p = 0.024). The weakest slice is single-session preference questions: R@5 83 against 87 for plain BM25 (30 questions). Other tools were run on a seeded 100-question subset only; in that subset agentmemory (BM25) scored 97.0 at R@5 and 95.0 on "every right one" at R@10, against Monomem keyword at 100.0 and 93.0, which is within noise. These are retrieval numbers, not answer accuracy.

### LoCoMo, all 1,982 questions (retrieval)

| Contender | R@5, any right one |
|---|---|
| Monomem hybrid | 92.1 |
| Monomem keyword | 91.0 |
| basic-memory, hybrid | 88.9 |
| Plain BM25 | 88.4 |
| agentmemory (BM25) | 87.6 |
| basic-memory, text | 75.7 |
| mem0 library, LLM extraction off, local embeddings | 71.4 |

Monomem keyword against basic-memory hybrid and agentmemory is significant (p = 0.002 and below). Monomem hybrid against Monomem keyword is not (p = 0.053). mem0 was run with its LLM extraction switched off, so this is not how mem0 is normally used.

### Answer accuracy (7B local reader), 60 LongMemEval-S questions

Monomem keyword top 5: 53.3% (95% interval 40.9 to 65.4). Plain BM25 top 5: 53.3%. Every difference between Monomem and BM25 is within two questions (p from 0.75 to 1.0). **There is no win to claim.** The 7B reader is the limit: even when the right conversation was in the context, accuracy was only 52 to 59%. These are not comparable to rivals' numbers, which use larger readers. One seed, one reader, one judge. Details: [BENCHMARK.md](./BENCHMARK.md).

### Where the frozen build lost

- Keyword mode is blind to meaning: synonyms 2 of 5 found, against 5 of 5 for every dense tool and for Monomem hybrid.
- Twenty keyword-stuffed decoys that copy a note's title pushed the real note to rank 21, in keyword and hybrid. agentmemory and the official server kept it at rank 2 and 1.
- A newer note worded differently, or negated, did not rank first in keyword mode.
- At 1,000 notes the official server was level on search latency (4.4 against 4.5 ms at the median) and write latency was the same order. Monomem keyword was fastest on search at 10,000 notes (6.1 ms median); Mem0's library write was faster at 10,000 notes (18.4 against 21.6 ms).
- Hybrid mode's cold start was 4.4 s and its 95th-percentile write was 705 ms while the shared model server was busy.

### Lost-write test (10 processes, 50 notes each, distinct bodies)

| Contender | Acknowledged | Missing afterwards |
|---|---|---|
| Monomem (10 MCP stdio processes, one file) | 500 | 0 |
| Official MCP memory server | 500 | 0 |
| mcp-memory-service | 500 | 0 |
| agentmemory | 500 | 0 |
| basic-memory | 494 of 500 (6 refused with a visible "database is locked" error) | 0 |
| Engram | 80 of 80 (8 each) | 0 |
| mem0 (local Qdrant) | 0 of 500: a second process was refused | 0 |

So Monomem ties the official server here, and we could not show a concurrency edge. Two tools lose writes in a quieter way: mcp-memory-service ships with a similarity filter on, and it refused 79 of 4,778 LongMemEval sessions as duplicates. agentmemory merges near-identical notes into versions.

### Poisoning probe

A second writer saves an overt injected instruction (P1) and a plain false claim with no command words (P2); the first writer then searches.

| Contender | P1 reaches the reader | P2 reaches the reader | Writer shown on the result |
|---|---|---|---|
| **Monomem** | **No: held** | Yes, labelled | Yes, stamped by the server |
| Official MCP memory server | Yes | Yes | None |
| agentmemory | Yes | Yes | None |
| basic-memory | Yes | Yes | None |
| Engram | Yes | Yes | None |
| mem0 | Yes | Yes | Only because the caller passed it |
| mcp-memory-service | Yes | No (refused as a duplicate, not as a security check) | Only because the caller passed it |

Monomem does **not** stop a plain false claim; it labels it and lets you undo the writer.

## Feature matrix, thirteen products

Every cell links to a source or says "not verified". "Not documented" means the linked page says nothing on the topic.

| Product | Writer recorded per note | Held-for-review writes | Rollback by writer | LLM used when a note is saved | Local, no account |
|---|---|---|---|---|---|
| mem0 | not verified | not documented ([README](https://github.com/mem0ai/mem0)) | not documented ([README](https://github.com/mem0ai/mem0)) | Yes, an LLM extracts what is kept ([README](https://github.com/mem0ai/mem0)) | Open source library and a hosted platform ([pricing](https://mem0.ai/pricing)) |
| Zep / Graphiti | Raw source episodes are kept ([README](https://github.com/getzep/graphiti)); writer not verified | not documented ([README](https://github.com/getzep/graphiti)); its reference servers state no authentication or injection protection | not documented ([README](https://github.com/getzep/graphiti)) | Yes, an LLM key is needed ([README](https://github.com/getzep/graphiti)) | Graphiti is open source; Zep is hosted ([pricing](https://www.getzep.com/pricing)) |
| Letta | Git commit history ([letta-code](https://github.com/letta-ai/letta-code)) | not documented ([letta-code](https://github.com/letta-ai/letta-code)) | Git history, not by writer ([letta-code](https://github.com/letta-ai/letta-code)) | not verified | Free tier on a hosted plan ([pricing](https://www.letta.com/pricing)) |
| supermemory | not verified | not verified | not verified | not verified | Hosted ([pricing](https://supermemory.ai/pricing)) |
| cognee | not verified | not documented ([README](https://github.com/topoteretes/cognee)) | not verified | Yes, the graph is built by an LLM ([README](https://github.com/topoteretes/cognee)) | Open source plus a cloud ([README](https://github.com/topoteretes/cognee)) |
| basic-memory | not documented ([README](https://github.com/basicmachines-co/basic-memory)) | not documented ([README](https://github.com/basicmachines-co/basic-memory)) | not documented; undo through git is an open request ([releases](https://github.com/basicmachines-co/basic-memory/releases)) | none documented ([README](https://github.com/basicmachines-co/basic-memory)) | Local markdown files ([README](https://github.com/basicmachines-co/basic-memory)) |
| Official MCP memory server | None documented per observation ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) | not documented ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) | not documented; no version history ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) | none documented ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) | Local file ([README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) |
| agentmemory | not verified | not verified | not verified | not verified | A local server ([README](https://github.com/rohitg00/agentmemory)) |
| Hindsight | not verified | not verified | not verified | Yes, retain, recall and reflect use an LLM ([README](https://github.com/vectorize-io/hindsight)) | Open source plus a cloud ([README](https://github.com/vectorize-io/hindsight)) |
| ai-memory | Ed25519-signed agent id, or marked `claimed` ([README](https://github.com/alphaonedev/ai-memory-mcp)) | A pending queue a person approves ([README](https://github.com/alphaonedev/ai-memory-mcp)) | Archive and restore; by writer not documented ([README](https://github.com/alphaonedev/ai-memory-mcp)) | none documented ([README](https://github.com/alphaonedev/ai-memory-mcp)) | Local program ([README](https://github.com/alphaonedev/ai-memory-mcp)) |
| Vestige | Signed, hash-chained log ([README](https://github.com/samvallad33/vestige)) | not documented ([README](https://github.com/samvallad33/vestige)) | Append-only; by writer not documented ([README](https://github.com/samvallad33/vestige)) | none documented ([README](https://github.com/samvallad33/vestige)) | Local program ([README](https://github.com/samvallad33/vestige)) |
| claude-mem | Names the originating agent in server search from 15.19 ([releases](https://github.com/thedotmack/claude-mem/releases)) | not documented ([README](https://github.com/thedotmack/claude-mem)) | not verified | not verified | Local, needs Node and Bun ([README](https://github.com/thedotmack/claude-mem)) |
| Engram | not documented ([README](https://github.com/Gentleman-Programming/engram)) | not documented; surfaces conflicts for a person to judge ([README](https://github.com/Gentleman-Programming/engram)) | not verified | not verified | One Go program, one SQLite file ([README](https://github.com/Gentleman-Programming/engram)) |
| **Monomem** | Yes; stamped by the server for apps with a key, a config name for local apps ([provenance.md](./provenance.md)) | Yes, for writes that match known attack patterns ([README](https://github.com/calasdan-sketch/monomem#readme)) | Yes ([tools.md](./tools.md)) | None | Yes ([footprint.md](./footprint.md)) |

## Detail: what each tool documents (read 2026-11-16 and 2026-11-17)

These tables are older than the sections above. Re-read anything you rely on.

### Memory tools you install

| Product (latest release seen) | What you install | Who wrote each note | Writes held for review | History and undo | Encryption at rest |
|---|---|---|---|---|---|
| **Monomem** (this repository) | A download per computer (Node's official signed runtime plus Monomem's code in one folder, nothing else to install), or npm with Node 22.16 or newer | Every note records its writer: stamped by the server for apps with their own key; for local apps, a name from the app's config file (tells apps apart, not proof) | Writes that match known attack patterns are held; secrets are refused; `approve-first` can hold every agent write | 20 earlier versions per note by default; replace and archive can be undone; rollback of one writer's changes | Optional, for note bodies (AES-256-GCM); titles and tags stay readable |
| **Vestige** v6.2.2 (2026-11-12) | `npx @vestige/init` puts a Rust program in place (Node only for the installer), or cargo | An append-only, hash-chained, signed log with write receipts | Not documented | Later claims replace earlier ones and old facts stay on the log; rollback by writer not documented | Not documented |
| **claude-mem** v15.19.0 (2026-11-16) | `npx claude-mem install`; needs Node and Bun, plus a worker and Chroma | Its 15.19 release notes: search on the server runtime names the agent a memory came from (`[via cursor]`); the local worker does not show it yet. Imports keep their source record | Not documented | Not documented | Not documented (the data folder is owner-only) |
| **mem0 / OpenMemory** OSS v2.2.1 (2026-09-25) | Python or TypeScript SDK plus a vector store; OpenMemory runs in Docker; the Platform is a hosted account | Not documented | Not documented | A history table | On the hosted Platform side |
| **agentmemory** v0.9.33 (2026-11-09) | npm; installs its own engine on first start; Docker images; WSL2 advised on Windows | Not documented | Not documented | A replace-import checks before it deletes | Not documented |
| **basic-memory** v1.0.0 (2026-10-29) | Python 3.12 or newer, through uv | Not documented | Not documented | Undo through git is an open request | Not documented |
| **MemPalace** v3.12.0 (2026-11-12) | Python 3.10 or newer (pip) | Not documented | Not documented | Earlier versions of an entry are saved before an update; repairs are a dry run until `--yes` | Not documented |
| **ai-memory** (alphaonedev) v0.9.0 (2026-07-08) | One Rust program (prebuilt, or cargo), with SQLite or PostgreSQL | Each memory has an agent id, signed with Ed25519 or marked `claimed`; unsigned HTTP writes are refused by default, MCP and CLI writes are accepted unsigned | A pending queue a person approves or rejects; a Claude Code `PreToolUse` hook that can block a tool | Archive and restore; rollback by writer not documented | Not documented |
| **Engram** v3.7.2 (2026-11-14) | One Go program and one SQLite file ("No Node.js, Python, Docker required"); brew or release archives with checksums | Not documented | Not documented; it surfaces conflicts for a person to judge | Updates by topic key; merging has a preview | Not documented |
| **Letta Code** v0.34.63 (2026-11-15) | A Node command line plus a Letta server or Letta's cloud | Git-backed memory whose commit messages must name their sources | Not documented | Git history | On the cloud side |
| **Zep / Graphiti** v0.31.2 (2026-10-20) | Python plus a graph database plus an LLM key; Zep is a hosted service | Not documented | Not documented | Episodes can be removed | On the cloud side |
| **Supermemory** (no tagged release; commits to 2026-11-16) | A hosted account | Not documented | Not documented | Not documented | On the hosted side |
| **Official MCP memory server** (`@modelcontextprotocol/server-memory`, README read 2026-11-15) | npm | Its README documents no author on a stored observation | Not documented | Its README documents delete tools and no version history | Not documented |

### Memory built into your assistant

| Product | Where the memory lives | Shared with other apps | What its documentation says |
|---|---|---|---|
| **Claude Code auto memory** | Plain files on one computer | Not documented; the files are "not shared across machines" | The first 200 lines or 25 KB of `MEMORY.md` load at the start of a session; it is not loaded into subagents (forks excepted). Asking Claude Code to "remember" something usually goes here, which is why Monomem's setup says "Save to Monomem". `monomem import --claude` can bring these files in. |
| **Cursor** (3.x) | Rules files and `AGENTS.md` | Through the files | Cursor's own Memories feature was removed in 2.1 and is still absent in 3.x. |
| **GitHub Copilot Memory** (GA 2026-10-28) | GitHub's servers; needs a paid Copilot plan | Across GitHub's Copilot apps | Memories expire after 28 days; repository memories can be written only by people with write access; each memory cites code that the agent is asked to re-check. Off by default and opt-in. |
| **OpenAI Codex memories** (0.165.0, 2026-10-27) | One computer | Not documented; "memories stay on one machine" | Its 0.165.0 release note: "Enabled memory v2 by default for fresh profiles and added support for importing external-agent memories into it." |
| **Notion MCP** | Notion's servers, over Notion's hosted MCP | Claude, ChatGPT, Cursor and other MCP apps connected to the workspace | A setup prompt has your agent save preferences, decisions and project details to a private Memories database you can review and edit, and ask before it creates or changes anything. Enterprise admins can approve which apps may connect. Who wrote each memory, and holding writes for review: not documented. |

## Sources

The detail tables above were read on 2026-11-16, and on 2026-11-17 where marked. Stars, releases, pricing and the matrix on 2026-11-24. Links to each product are in the tables.

- Vestige: https://github.com/samvallad33/vestige and its releases
- claude-mem: https://github.com/thedotmack/claude-mem/releases (v15.19.0) and its README
- mem0: https://github.com/mem0ai/mem0/releases
- agentmemory: https://github.com/rohitg00/agentmemory/releases and its README (agent table)
- ai-memory: https://github.com/alphaonedev/ai-memory-mcp (README, v0.9.0 notes)
- basic-memory: https://github.com/basicmachines-co/basic-memory/releases
- MemPalace: https://github.com/MemPalace/mempalace/releases
- Engram: https://github.com/Gentleman-Programming/engram
- Letta Code: https://github.com/letta-ai/letta-code/releases
- Graphiti: https://github.com/getzep/graphiti/releases
- Supermemory: https://github.com/supermemoryai/supermemory
- Official MCP memory server: https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md
- Claude Code: https://code.claude.com/docs/en/memory
- Cursor: https://cursor.com/docs/release-notes
- GitHub Copilot Memory: https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/
- OpenAI Codex: https://github.com/openai/codex/releases (rust-v0.165.0)
- Notion: https://www.notion.com/help/notion-mcp


A count from our own provenance benchmark against another product (for example mem0) counts features that product does not claim to have. It is a feature-provenance count, not a retrieval comparison, and must not be quoted as one.
