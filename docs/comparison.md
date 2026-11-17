# How Monomem compares

Every cell about another product comes from that product's own README, release notes or documentation, **read on
2026-11-16** (claude-mem, agentmemory, ai-memory, Codex and Notion re-read on 2026-11-17). Products change quickly, so check the linked source before you rely on a cell. Where a source says
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

## Memory built into your assistant

| Product | Where the memory lives | Shared with other apps | What its documentation says |
|---|---|---|---|
| **Claude Code auto memory** | Plain files on one computer | Not documented; the files are "not shared across machines" | The first 200 lines or 25 KB of `MEMORY.md` load at the start of a session; it is not loaded into subagents (forks excepted). Asking Claude Code to "remember" something usually goes here, which is why Monomem's setup says "Save to Monomem". `monomem import --claude` can bring these files in. |
| **Cursor** (3.x) | Rules files and `AGENTS.md` | Through the files | Cursor's own Memories feature was removed in 2.1 and is still absent in 3.x. |
| **GitHub Copilot Memory** (GA 2026-10-28) | GitHub's servers; needs a paid Copilot plan | Across GitHub's Copilot apps | Memories expire after 28 days; repository memories can be written only by people with write access; each memory cites code that the agent is asked to re-check. Off by default and opt-in. |
| **OpenAI Codex memories** (0.165.0, 2026-10-27) | One computer | Not documented; "memories stay on one machine" | Its 0.165.0 release note: "Enabled memory v2 by default for fresh profiles and added support for importing external-agent memories into it." |
| **Notion MCP** | Notion's servers, over Notion's hosted MCP | Claude, ChatGPT, Cursor and other MCP apps connected to the workspace | A setup prompt has your agent save preferences, decisions and project details to a private Memories database you can review and edit, and ask before it creates or changes anything. Enterprise admins can approve which apps may connect. Who wrote each memory, and holding writes for review: not documented. |

## Where Monomem is behind

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

## Sources (read 2026-11-16; re-read 2026-11-17 where marked above)

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
