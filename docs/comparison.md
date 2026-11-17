# How Monomem compares

Every cell about another product comes from that product's own README, release notes or documentation, **read on
2026-11-16**. Products change quickly, so check the linked source before you rely on a cell. Where a source says
nothing about a topic, the cell says **not documented**. That does not mean the product lacks it; it means we could
not find it written down.

There are no search-quality or benchmark rows on purpose. Each project measures retrieval in its own way, on its own
question sets, and nobody here re-ran anyone else's numbers. Monomem's own retrieval numbers, and the projects that
report higher ones, are in [BENCHMARK.md](./BENCHMARK.md).

## Memory tools you install

| Product (latest release seen) | What you install | Who wrote each note | Writes held for review | History and undo | Encryption at rest |
|---|---|---|---|---|---|
| **Monomem** (this repository) | A download per computer (Node's official signed runtime plus Monomem's code in one folder, nothing else to install), or npm with Node 22.16 or newer | Every note records its writer: stamped by the server for apps with their own key; for local apps, a name from the app's config file (tells apps apart, not proof) | Writes that match known attack patterns are held; secrets are refused; `approve-first` can hold every agent write | 20 earlier versions per note by default; replace and archive can be undone; rollback of one writer's changes | Optional, for note bodies (AES-256-GCM); titles and tags stay readable |
| **Vestige** v6.2.2 (2026-11-12) | `npx @vestige/init` puts a Rust program in place (Node only for the installer), or cargo | An append-only, hash-chained, signed log with write receipts | Not documented | Later claims replace earlier ones and old facts stay on the log; rollback by writer not documented | Not documented |
| **claude-mem** v15.19.0 (2026-11-16) | `npx claude-mem install`; needs Node and Bun, plus a worker and Chroma | Not documented | Not documented | Not documented | Not documented (the data folder is owner-only) |
| **mem0 / OpenMemory** OSS v2.2.1 (2026-09-25) | Python or TypeScript SDK plus a vector store; OpenMemory runs in Docker; the Platform is a hosted account | Not documented | Not documented | A history table | On the hosted Platform side |
| **agentmemory** v0.9.33 (2026-11-09) | npm; installs its own engine on first start; Docker images; WSL2 advised on Windows | Not documented | Not documented | A replace-import checks before it deletes | Not documented |
| **basic-memory** v1.0.0 (2026-10-29) | Python 3.12 or newer, through uv | Not documented | Not documented | Undo through git is an open request | Not documented |
| **MemPalace** v3.12.0 (2026-11-12) | Python 3.10 or newer (pip) | Not documented | Not documented | Earlier versions of an entry are saved before an update; repairs are a dry run until `--yes` | Not documented |
| **Engram** v3.7.2 (2026-11-14) | One Go program and one SQLite file ("No Node.js, Python, Docker required"); brew or release archives with checksums | Not documented | Not documented; it surfaces conflicts for a person to judge | Updates by topic key; merging has a preview | Not documented |
| **Letta Code** v0.34.63 (2026-11-15) | A Node command line plus a Letta server or Letta's cloud | Git-backed memory whose commit messages must name their sources | Not documented | Git history | On the cloud side |
| **Zep / Graphiti** v0.31.2 (2026-10-20) | Python plus a graph database plus an LLM key; Zep is a hosted service | Not documented | Not documented | Episodes can be removed | On the cloud side |
| **Supermemory** (no tagged release; commits to 2026-11-16) | A hosted account | Not documented | Not documented | Not documented | On the hosted side |
| **Official MCP memory server** (`@modelcontextprotocol/server-memory`, README read 2026-11-15) | npm | Its README documents no author on a stored observation | Not documented | Its README documents delete tools and no version history | Not documented |

## Memory built into your assistant

| Product | Where the memory lives | Shared with other apps | What its documentation says |
|---|---|---|---|
| **Claude Code auto memory** | Plain files on one computer | Not documented; the files are "not shared across machines" | The first 200 lines or 25 KB of `MEMORY.md` load at the start of a session; it is not loaded into subagents (forks excepted). Asking Claude Code to "remember" something usually goes here, which is why Monomem's setup says "Save to Monomem". `monomem import --claude` can bring these files in. |
| **Cursor** (3.x) | Rules files and `AGENTS.md` | Through the files | Cursor's own Memories feature was removed in 2.1 and is still absent in 3.x. |
| **GitHub Copilot Memory** (GA 2026-10-28) | GitHub's servers; needs a paid Copilot plan | Across GitHub's Copilot apps | Memories expire after 28 days; repository memories can be written only by people with write access; each memory cites code that the agent is asked to re-check. Off by default and opt-in. |
| **OpenAI Codex memories** (0.165.0, 2026-10-27) | One computer | Not documented; "memories stay on one machine" | On by default for new profiles; can import other agents' memories. |
| **Notion shared memory** (launched 2026-11-04) | Notion's servers, over Notion's hosted MCP with OAuth | ChatGPT, Claude and other MCP apps that sign in to Notion | Memories are kept per person; write-ups of the launch say each memory shows which agent wrote it, as the app declares; Notion pages have edit history. Nothing is documented about holding writes for review. |

## Where Monomem is behind

- **Install.** Engram and Vestige ship one compiled program. Monomem's download is a folder that runs Node's official
  program (Task Manager shows "Node.js JavaScript Runtime"), and it is not code-signed yet: see
  [INSTALL.md](../INSTALL.md#download-no-nodejs-needed).
- **How many apps setup connects.** `monomem setup` connects eight apps. Engram documents fourteen, and agentmemory
  about thirty.
- **Hosted chat apps.** claude.ai and the Claude and ChatGPT phone apps need OAuth sign-in, which Monomem does not have
  yet. Notion covers them today.

## Sources (read 2026-11-16)

- Vestige: https://github.com/samvallad33/vestige and its releases
- claude-mem: https://github.com/thedotmack/claude-mem/releases
- mem0: https://github.com/mem0ai/mem0/releases
- agentmemory: https://github.com/rohitg00/agentmemory/releases
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
