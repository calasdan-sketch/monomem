# Switching to Monomem from claude-mem, mem0, basic-memory, Codex, Notion or the official MCP memory server

`monomem import --from <tool>` copies another memory tool's notes into Monomem. It works the same way as
`import --claude`:

- Every imported note is **held**: it is marked as from outside, kept out of session start, and listed in `monomem review`
  until a person confirms it (`monomem confirm <id>`). Another app's memory is text any program on this computer could
  have written, so it is not trusted on arrival.

- It runs only on this computer and sends nothing anywhere. It **reads** the other tool's data and never changes or deletes it.
- Start with `--dry-run`. It shows what would be imported and writes nothing. It does not even create the Monomem data folder.
- Anything that looks like a password or token is skipped. It is counted, but it is never shown or stored.
- Every note goes through the memory linter. Text that reads like an instruction to an AI is held in `monomem review held` for you to approve or reject.
- Each note keeps the other tool's id in its `source` field (`import:claude-mem:obs:42`, `import:mem0:<id>`,
  `import:basic-memory:<permalink>`, `import:mcp-memory:entity:<name>`). If you run the import again, it adds only what is new.
- Notes are written by `import:<tool>` and tagged `imported:<tool>`. `--namespace ns` puts them in a namespace of your choice.

```sh
monomem import --from claude-mem --dry-run
monomem import --from claude-mem            # asks before writing; --yes skips the question. Without a terminal (a script, a pipe, an agent's shell tool) it refuses to write unless you add --yes
```

Get everything across first and check it. Remove the old tool only after that.

Notes that `import --claude` brings in from CLAUDE.md files and Claude Code's auto-memory (tagged `claude-md` or
`claude-auto-memory`) are left out of Claude Code's own session-start notes, because Claude Code already reads those files;
search and your other apps still see them.

The dashboard's Welcome screen does the same: under **Bring in memories** it lists what it found on this computer
(Claude Code's own memory, claude-mem, basic-memory, the MCP memory server, Codex memories) and asks before each one.
A Notion export or a mem0 file needs a path, so those two are done from the terminal.

## Claude Code's own memory (`import --claude`)

Claude Code keeps its own memory in CLAUDE.md files and in auto memory (`~/.claude/projects/<project>/memory/*.md`). Your
other apps never see it. `monomem import --claude` copies it in:

```sh
monomem import --claude --dry-run     # what it would bring in
monomem import --claude               # asks first; --yes skips the question
monomem import --claude --update      # also refresh notes whose file text changed
monomem import --claude --no-project  # leave out the CLAUDE.md files of the current folder
```

- Notes are held until you confirm them (see above).
- Monomem remembers what it imported (`claude-import-state.json` in the data folder). Running it again reads only the files
  whose text changed. A changed section is listed as "changed since"; `--update` refreshes it in place, held again.
- When a file Claude Code had is gone (removed or renamed), the next run says so and lists the notes Monomem still keeps
  from it. Nothing in Monomem is deleted because a file went away.
- `monomem check` shows one line: when you last imported, how many files changed since, and how many imported notes are
  still held.
- `monomem setup` offers the import when it finds these files (it asks; it never imports without a yes).
- **Keep it in step (optional, off by default).** While Monomem's server runs, it can look every 10 minutes for files
  Claude Code changed and bring them in, held the same way. Turn it on in the dashboard's Settings ("Bring in Claude Code's
  memory as it changes"), or set `MONOMEM_CLAUDE_REFRESH=on` (which wins over the switch). It never runs from a hook and
  never when the server is not running.

What it cannot do, from Claude Code's own documentation (https://code.claude.com/docs/en/memory): auto memory is kept
per machine, so only this computer's files are read; Claude Code itself loads only the first 200 lines (25 KB) of
MEMORY.md at session start, and Monomem does not change that; and auto memory is not written from subagents, so there is
nothing of theirs to bring in.

## From Codex

Codex CLI and the ChatGPT desktop app keep local memories (off by default in Codex; switch them on there first) under
`$CODEX_HOME` (default `~/.codex`) in `memories/` and `memories_v2/`, as documented at
https://learn.chatgpt.com/docs/customization/memories.

```sh
monomem import --from codex --dry-run
monomem import --from codex --path /other/codex-home
```

- Only `MEMORY.md` (the consolidated handbook) and `memory_summary.md` are read, cut into one note per level 1 or 2
  heading. `raw_memories.md`, `rollout_summaries/` and `skills/` are Codex's working material and are left out.
- The same section in `memories/` and `memories_v2/` becomes one note.
- A section whose text changed in Codex comes in as a new note on the next run; the older one stays until you archive it.

## From a Notion export

In Notion: Settings, Export all workspace content (or a page's ... menu, Export), format **Markdown & CSV**.

```sh
monomem import --from notion --path ~/Downloads/Export-1234.zip --dry-run
monomem import --from notion --path ~/Downloads/Export-1234          # or the unzipped folder
```

- One page = one note. Notion's 32-character id is dropped from the title, and the folder of parent pages is shown as the
  group. Database tables (`.csv`) are not read; their rows are exported as pages too.
- The zip is read in memory, never unpacked to disk. A zip inside it (Notion splits large exports into parts) is opened
  too. ZIP64 archives (over 4 GB) are not read: unzip them and point `--path` at the folder. Pages over 1 MiB are skipped
  and counted.
- A page edited in Notion and exported again comes in as a new note; the older one stays until you archive it.

## From claude-mem

**What is read.** claude-mem keeps its data in a SQLite database: `~/.claude-mem/claude-mem.db`, or
`$CLAUDE_MEM_DATA_DIR/claude-mem.db` when that variable is set. If you moved the data folder in `~/.claude-mem/settings.json`,
pass `--path <folder>/claude-mem.db`. Monomem opens the file read only, so it is safe to run while claude-mem's worker is
still running.

| claude-mem | Monomem |
|---|---|
| `observations` row | a row of kind `observation`; `obs_type` is its type (bugfix, feature, decision, discovery, change, ...) |
| `title`, `subtitle`, `narrative`, `text`, `facts` | title and body |
| `files_read`, `files_modified` | linked files (shown in file context and the Sessions tab) |
| `concepts` | `obs.concept:` tags |
| `session_summaries` row | a row of kind `summary` (request, investigated, learned, completed, next steps, notes) |
| `project` | `project:<name>` tag |
| `created_at_epoch` | the original creation date |
| `memory_session_id` | session `claude-mem:<id>` |

A model wrote claude-mem's observations and summaries. Monomem does not have a separate "written by a model" label yet. Use
the `imported:claude-mem` tag and the writer `import:claude-mem` to tell these rows apart from your own notes. Raw
`user_prompts` are not imported. They are your own typed prompts, not memories.

**Export first (optional).** The database file is the export. To keep a copy, stop the worker first (step 1 below). Then copy
`claude-mem.db` somewhere safe.

**Uninstall claude-mem cleanly.** Monomem does not delete claude-mem's files for you. Do these steps yourself, in this order:

1. **Stop the worker and remove the plugin.** Run `npx claude-mem uninstall`. It stops the worker service on its port, removes
   the plugin and its marketplace and cache folders, and takes its entries out of `~/.claude/settings.json`. You can also remove
   it with `/plugin uninstall claude-mem` in Claude Code. Afterwards, check that no claude-mem worker process (it runs on Bun) is
   still running.
2. **Check `~/.claude/settings.json`.** Make sure `enabledPlugins` has no `claude-mem@thedotmack` entry. The claude-mem installer
   also sets `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` to `"1"`, which turns off Claude Code's own auto memory. The uninstaller removes
   it. If it is still there and you did not set it yourself, remove it.
3. **Remove the context blocks it wrote into CLAUDE.md files.** claude-mem puts its context between `<claude-mem-context>` and
   `</claude-mem-context>` in CLAUDE.md files, and in rules files for other editors such as `.cursor/rules`, `.windsurf` and
   `.agent/rules/claude-mem-context.md`. Search your projects for `claude-mem-context` and delete each block, from the opening
   tag to the closing tag. Leave the rest of the file as it is.
4. **Remove its data when you are sure.** The uninstaller keeps `~/.claude-mem`. That folder holds `claude-mem.db`, the
   Chroma vector data in `~/.claude-mem/chroma`, `settings.json` and its logs. If you use claude-mem's cloud sync or the
   Docker/Postgres runtime, follow its own teardown steps for those as well. Delete `~/.claude-mem` only after you have
   checked the import.
5. **Set up Monomem's automatic memory** (`monomem setup`), so new sessions are captured again.

## From mem0

mem0 has no file of its own, so first export your memories as JSON. With the Python client this is
`json.dump(m.get_all(user_id="you"), open("mem0.json", "w"))`. The mem0 platform also offers a memory export. The importer
accepts a plain list of memories, or `{ "results": [...] }` / `{ "memories": [...] }`.

```sh
monomem import --from mem0 --path mem0.json --namespace personal --dry-run
```

Each memory becomes one note. Its `memory` (or `text`) is the body, `created_at` is kept, `metadata.categories` (or
`categories`) become `category:` tags, and the user or agent id becomes a `mem0-user:` tag. Then remove mem0 from your code or
MCP configuration. Stop and delete its vector store (Qdrant, Chroma, ...) the way you set it up.

## From basic-memory

basic-memory's notes are Markdown files, in `~/basic-memory` by default. Point `--path` at another project folder if yours is
somewhere else.

```sh
monomem import --from basic-memory --path ~/basic-memory --dry-run
```

Each `.md` file becomes one note. The note gets the front matter `title` (or the first heading, or the file name), its `tags` (`[a, b]`, `a, b` or a
YAML list), and its `type` as a `bm-type:` tag. The `created` date is kept, or the file date is used. The permalink (or the file path) is the stable id.
The Observations and Relations sections stay in the body as they are written, so `[[links]]` are kept as text. Folders
starting with `.` and symbolic links are skipped.

To remove basic-memory, take its MCP server out of your client's configuration (for example `claude mcp remove basic-memory`)
and uninstall it (`uv tool uninstall basic-memory`). Your Markdown files are yours to keep. basic-memory's index lives in
`~/.basic-memory` and can be deleted.

## From the official MCP memory server

The official memory server (`@modelcontextprotocol/server-memory`) keeps a knowledge graph in one `memory.jsonl` file. Unless
`MEMORY_FILE_PATH` is set, that file sits **inside the npx download cache**, next to the server's code, where it is easy to lose:
cleaning or refreshing the npx cache deletes it (the server writes `memory.jsonl` next to its own code, in `dist/`). So the import looks in the npx folder of npm's cache for you: `npm_config_cache` if set, else `%LOCALAPPDATA%\npm-cache` on Windows or `~/.npm` on macOS and Linux. A global or local install keeps the file next to that install instead, so name it with `--path`.

```sh
monomem import --from mcp-memory --dry-run                          # uses MEMORY_FILE_PATH, or finds the file in the npx cache
monomem import --from mcp-memory --path ~/memory.jsonl --dry-run    # or name the file
```

If it finds more than one file (several cached server versions), it lists them and asks you to pick one with `--path`. Run the
dry run first: it is also a quick way to check whether your graph is still there. The dry run lists the first 10 entities (name and first observation), how many relation lines it read and how many unreadable lines it dropped, and which notes the memory linter would probably hold (for example an observation that says "Ignore previous instructions").

Each entity becomes one note: the entity name is the title, its observations are a list in the body, and its relations are listed
underneath ("owns Deploy pipeline", "Dana owns (this)"). Its `entityType` becomes an `entity-type:` tag. The graph is written by
AI agents through MCP tools, so the notes also carry the model-written label. Damaged lines in the file are skipped. The entity
name is the stable id, so running the import again adds only new entities; observations added later to an entity that was
already imported are not merged in.

To remove the old server, take it out of your client's MCP configuration (for example `claude mcp remove memory`). Keep the
`memory.jsonl` file until you have checked the imported notes.

## Your past Claude Code conversations

Claude Code keeps every conversation as a file under `~/.claude/projects/<project>/<session>.jsonl` (or under
`CLAUDE_CONFIG_DIR` when that is set). This import makes them searchable:

```sh
monomem import --from claude-code-chats --dry-run            # what it would bring in, per project
monomem import --from claude-code-chats                      # import (asks first; --yes to skip the question)
monomem import --from claude-code-chats --path <folder>      # another projects folder
```

- **What is kept:** what you typed and Claude's written replies. Tool calls, tool output, Claude's thinking, subagent turns,
  slash commands and `<system-reminder>` blocks are left out. A reply Claude wrote in several pieces becomes one note.
- **One note per message, with the message it replied to.** The question and its answer usually sit in two different
  messages ("which port does staging use?" ... "9443"), so each note also carries the first 400 characters of the message
  before it (left out when that message holds a secret or a linter hit). A search for the question's words then finds the answer. On the LoCoMo-10 benchmark by turn this raised
  recall@5 on the validation half (not used for tuning) from 58.8 % to 64.6 % ([BENCHMARK.md](./BENCHMARK.md#retrieval-longmemeval-s-and-locomo));
  the benchmark builds its notes with the same code as this import.
- **Where it goes:** the `chats` namespace (`--namespace` to change it). Every note is tagged `imported:claude-code-chats` and
  `chat.session:<id>`, and Claude's messages also carry the model-written label. Chat notes are **never shown at session
  start** or in the "new notes" line, however your namespaces are set up: they are for search (`monomem search`,
  `memory_search`), not for every session's opening context.
- **Same rules as the other imports:** read only, nothing leaves your computer, a message that looks like a secret is
  skipped (not stored, not shown), the memory linter may hold a message that reads like an instruction to an AI for your
  review, and running it again adds only new messages. The secret check reads each message as written: a secret the chat
  already split over lines (for example `password:` with the value on the next line, or a token wrapped in two) is not
  recognised, so that message is stored. Import only chats you would be happy to keep in Monomem.
- **With encryption on:** like captured notes, every chat note gets the fixed title `Chat message (sealed)`; its real title
  (speaker and first line) becomes the first line of the sealed body. Note titles stay plaintext on disk (SECURITY.md), so
  no message text is left in them. Search still finds the words in memory (the in-memory body index).
- **Size:** a busy machine can have tens of thousands of messages. Run `--dry-run` first to see the count. Session files
  over 256 MB are skipped.
