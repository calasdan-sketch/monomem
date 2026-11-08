# Install Monomem in your agent

Monomem speaks the standard **MCP** protocol, so it drops into any
MCP-capable agent. They all launch it the same way — a local command over
"stdio" — they just keep their config in different places. Pick yours below.

## The easy way: `monomem setup`

```bash
npx monomem setup --dry-run     # shows exactly what it would change; writes nothing
npx monomem setup               # does it, after you type y; backs up every file; --undo reverses it
```

It finds Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, Muse, VS Code and Zed, adds only the Monomem entry, and can move an old `claude-bridge` entry across keeping your data.
Details and troubleshooting: [docs/live-claude-code.md](./docs/live-claude-code.md). The manual steps for each app follow.

To give one app its own key and a limit on what it can see, use `monomem connect <app> --max internal` instead; see
[Give an app limited access](./docs/give-an-app-limited-access.md). Apps wired by hand below (the usual `monomem mcp` way)
run on your computer with no limit, so use `connect` for any app that should not see `private` notes.

---

## Doing it by hand

> **Before the by-hand steps** (Node.js 22.16+ or 24 LTS):
> ```bash
> npm install -g monomem
> ```
> That puts the `monomem` command on your PATH; every client below runs
> `monomem mcp`. Your memory lives in `~/.monomem` (override with
> `MONOMEM_HOME`), so it survives upgrades.
>
> **Nine tools are registered by default** — enough to write, find, read,
> forget and safely replace a memory. Every tool's schema is sent to the model
> on every turn, so the operator tools (change feed, task board, trust,
> quarantine, consolidation, history, session index) are opt-in. To switch
> them on, add an `env` block to the client config you are about to edit:
>
> ```json
> {
>   "command": "monomem",
>   "args": ["mcp"],
>   "env": { "MONOMEM_TOOLS": "all" }
> }
> ```
>
> You can name individual tools instead of `all`:
> `"MONOMEM_TOOLS": "memory_index,memory_timeline,memory_get,session_list"`.
> The default ten are always kept, so a typo cannot leave you unable to read
> or write. See [docs/configuration.md](./docs/configuration.md).
>
> Working from a git clone instead? `npm install && npm run build && npm link`
> gives you the same `monomem` command.

---

## Claude Code

```bash
claude mcp add monomem -- monomem mcp
```

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "monomem": {
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

## Cursor

Create `.cursor/mcp.json` in your project (or the global one in `~/.cursor/`):

```json
{
  "mcpServers": {
    "monomem": {
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

## GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in your project, or use the user one (`MCP: Open User Configuration`; `setup` writes
`%APPDATA%\Code\User\mcp.json` on Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS,
`~/.config/Code/User/mcp.json` on Linux):

```json
{
  "servers": {
    "monomem": {
      "type": "stdio",
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

## Codex CLI

`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). `setup` adds only this table and leaves the rest of the file as it is:

```toml
[mcp_servers.monomem]
command = "monomem"
args = ["mcp"]
```

With `--capture`, `setup` also writes `~/.codex/hooks.json` (SessionStart, UserPromptSubmit, PostToolUse, Stop). Codex
runs a new hook only after you trust it: type `/hooks` in Codex and approve the Monomem ones.

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "monomem": {
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

With `--capture`, `setup` adds hooks under `"hooks"` in the same file (SessionStart, BeforeAgent, AfterTool, AfterAgent, SessionEnd).

## Muse (Meta Muse Code)

`~/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`). Muse will not start without
`"schema_version": 1`; `setup` adds it when it is missing. If the file already uses `"mcpServers"`, `setup` keeps that
spelling; otherwise it uses `"mcp_servers"` (Meta's documented key):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "monomem": {
      "transport": "stdio",
      "command": "monomem",
      "args": ["mcp"],
      "mode": "optional"
    }
  }
}
```

With `--capture`, `setup` adds hooks under `"hooks"` in the same file. Each Monomem hook group holds only its command
(Muse skips a group that has a key it does not know). Muse has not published its hook input fields, so recording there
is best effort.

## Zed

`settings.json` (`%APPDATA%\Zed\settings.json` on Windows, `~/.config/zed/settings.json` elsewhere; `zed: open settings file`):

```json
{
  "context_servers": {
    "monomem": {
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

## Windsurf / Cline / Continue / other MCP agents

They all accept the same stdio launch. Find the client's MCP config and add
a server whose command is `monomem` and whose argument is `mcp`. Example (Windsurf `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "monomem": {
      "command": "monomem",
      "args": ["mcp"]
    }
  }
}
```

---

## Connect to a shared server (a teammate's setup)

If your team runs one Monomem server (see [docs/team.md](./docs/team.md)), you do not install anything. Your admin gives you
the address (`https://<your host>/mcp`) and your own token (shown once by `monomem token add`). Every client sends the token as
`Authorization: Bearer <token>`. Keep the token out of files you commit.

**Claude Code**

```bash
claude mcp add --transport http monomem https://<your host>/mcp --header "Authorization: Bearer <token>"
```

Then type `/mcp` in Claude Code: `monomem` should show as connected. A red mark with 401 means the token is wrong.

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "monomem": {
      "url": "https://<your host>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`). Codex supports remote HTTP MCP servers. It reads the token from an environment
variable rather than the file, so set `MONOMEM_TOKEN` in the shell that starts Codex:

```toml
[mcp_servers.monomem]
url = "https://<your host>/mcp"
bearer_token_env_var = "MONOMEM_TOKEN"
```

Other apps that accept a remote MCP URL plus custom headers take the same two values. An app that only accepts a URL and
no headers cannot connect to a token-protected server.

How these were checked: the Authorization header form is tested against Monomem's own `/mcp` endpoint (a client with the header connects
and lists tools; one without it gets 401). The Claude Code command is from its MCP docs, and the Codex keys (`url`,
`bearer_token_env_var`) are from the Codex source. The Cursor file shape was not run here.

## Also reach Claude web & mobile (optional)

Everything above is local. To let Claude on the web or your phone read/write
the **same** store, run the HTTP server and expose it over an HTTPS tunnel —
see [INFRA.md](./INFRA.md) for the Cloudflare Tunnel + token walkthrough.

## Any other app or language

There's also a plain HTTP JSON API (`POST /notes`, `GET /search`, etc.), so
any script or model that can make a web request can use the same store — no
MCP required. See [docs/architecture.md](./docs/architecture.md) for the routes.
