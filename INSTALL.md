# Install Monomem in your agent

Monomem speaks the standard **MCP** protocol, so it drops into any
MCP-capable agent. They all launch it the same way — a local command over
"stdio" — they just keep their config in different places. Pick yours below.

## The easy way: `monomem setup`

```bash
npx monomem setup --dry-run     # shows exactly what it would change; writes nothing
npx monomem setup               # does it, after you type y; backs up every file; --undo reverses it
```

It finds Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, Muse, VS Code, Zed, Windsurf, Devin, Kiro, Cline CLI, GitHub Copilot CLI, Antigravity, Qwen Code, OpenCode and Kilo Code ([where each keeps its settings](./docs/apps.md)), adds only the Monomem entry, and can move an old `claude-bridge` entry across keeping your data.
Details and troubleshooting: [docs/live-claude-code.md](./docs/live-claude-code.md). The manual steps for each app follow.

To give one app its own key and a limit on what it can see, use `monomem connect <app> --max internal` instead; see
[Give an app limited access](./docs/give-an-app-limited-access.md). Apps wired by hand below (the usual `monomem mcp` way)
run on your computer with no limit, so use `connect` for any app that should not see `private` notes.

## Upgrading

1. Global install: `npm i -g monomem@latest`. (With `npx`, the next `npx monomem@latest ...` fetches it.)
2. Then everyone: **`monomem setup` again.** If setup ran through `npx`, your apps' entries and hooks name the exact version
   they were set up with (`monomem@1.5.0`); they keep launching that old copy after the upgrade, and once the newer one has
   upgraded the database the old hook returns nothing at session start, without an error. Running setup again points them at
   the new version (it shows the change and asks first).
3. `monomem check --setup` (formerly `monomem doctor`): it warns `... launches monomem X, this is Y` (and says to run `monomem setup`) while an app entry or hook still
   names the old version.

What changes per release, and how to go back: [docs/upgrading.md](./docs/upgrading.md).

---

## Download (no Node.js needed)

Each [GitHub release](https://github.com/calasdan-sketch/monomem/releases) carries one archive per computer:

| Computer | File |
|---|---|
| Windows (64-bit Intel/AMD) | `monomem-<version>-win-x64.zip` |
| Mac with Apple silicon (M1 or newer) | `monomem-<version>-darwin-arm64.tar.gz` |
| Mac with an Intel chip | `monomem-<version>-darwin-x64.tar.gz` |
| Linux (64-bit Intel/AMD, glibc 2.28 or newer) | `monomem-<version>-linux-x64.tar.gz` |

Not listed: Windows on ARM, Linux on ARM and Alpine (musl). Use npm or Docker there.

It is a normal archive (about 40 MB; about 105 MB once unpacked), not a single program file. Inside is one `Monomem`
folder: Node.js's own official program, so you do not need to install Node (`runtime/monomem-node.exe` on Windows,
`runtime/node` on Mac and Linux: about 96 MB of the folder, copied from nodejs.org after its checksum was checked, its bytes
unchanged; on Windows only its file name is changed, which keeps Node's signature valid; `runtime/SOURCE.txt` says which
build), Monomem's code (`dist/`, with the Monomem icon), these docs and a small launcher (`monomem.cmd` on Windows,
`monomem` on Mac and Linux). Monomem itself is not code-signed (signing costs money we have not spent yet). The only
program in the folder is Node's, which is signed by its makers.

**Install**

What you will see on Windows, step by step:

1. Check the download first (see **Check the download** below), then right-click the zip, choose **Properties**, tick
   **Unblock** at the bottom, click **OK**. (Windows marks files from the internet. Unblocking the zip before you unpack
   it means none of the unpacked files carry that mark, so Windows normally does not stop to ask about `monomem.cmd`.)
2. Right-click the zip again, choose **Extract All**, then **Extract**. Do not run anything from inside the zip.
3. Open the `Monomem` folder and double-click `monomem` (the file `monomem.cmd`, shown as "Windows Command Script").
   It opens your notes in the browser. To connect your apps, run setup in a terminal (PowerShell or Command Prompt)
   from the folder that holds `Monomem`: `.\Monomem\monomem.cmd setup`. If you skipped step 1, Windows may first show "Open File - Security Warning"
   or "Windows protected your PC" for `monomem.cmd`: check that it is the file you unpacked, then click **Run** (or
   **More info**, then **Run anyway**).

On a Mac or Linux, unpack the archive and run `./Monomem/monomem setup` in a terminal.

Setup (Windows, Mac and Linux):

1. Setup shows its plan and asks before it changes anything. Its first two steps:
   - It copies the folder to its home, so app settings never point into your Downloads folder. No admin rights are needed.
     Windows: `%LOCALAPPDATA%\Programs\Monomem`. Mac: `~/Applications/Monomem`. Linux: `~/.local/share/monomem`.
     On Windows the copy does not keep the download mark, as an installer's files do not, so the Start menu entry opens
     without a warning. The unpacked folder in Downloads keeps its mark.
   - It adds a **Monomem** entry, with the Monomem icon, that opens your notes in the browser: in the Windows Start menu,
     in `~/Applications` on a Mac, and in the Linux applications menu. `monomem setup --undo` and `monomem uninstall`
     remove it.
2. Then it connects your apps as usual. You can delete the downloaded archive and folder afterwards.

Had the npm version? Setup lists moving your apps and hooks from it to this download as a step you say yes to (same data
folder, and `monomem setup --undo` puts them back). After that, `npm rm -g monomem` is safe; until then
`monomem check` warns that an app still runs the npm copy.

To type `monomem` in any terminal, setup offers to add the home folder to your PATH, as one more step in the list you say
yes to: on Windows your per-user PATH (the `Path` value under `HKCU\Environment`, appended, nothing else changed; open a new
terminal afterwards), on Mac/Linux one line marked `# added by monomem setup` in your shell's startup file (`~/.zshrc`,
`~/.bashrc`, `~/.bash_profile` on a Mac, fish's `config.fish`, else `~/.profile`). `monomem setup --undo` and
`monomem uninstall` take out exactly that entry. `--yes` alone leaves PATH alone (add `--path`); `--no-path` skips it. Running `monomem` with no command
shows the help; double-clicking `monomem.cmd` or using the Monomem entry opens your notes (it starts Monomem in
the background, with no window: `monomem stop` ends it).

**Update.** `monomem update` downloads the newest release for your computer, checks its SHA-256 against the release's
`SHA256SUMS`, swaps it into the same folder (apps that are open keep working), upgrades your database and restarts the
background service if you set one up. It only ever runs when you type it; nothing updates in the background, and
`monomem update --check` only asks. Restart your apps afterwards. Offline, it says it could not reach github.com and
changes nothing.

**What your computer may say (no code signing yet)**

- **Windows.** The zip comes from the internet, so Windows marks it, and **Extract All** passes the mark to every
  unpacked file. `monomem.cmd` is a type of file Windows asks about when it carries the mark; Unblock the zip first (step 1
  above) and it does not. The program that runs is Node's (`runtime\monomem-node.exe`), signed by the OpenJS Foundation:
  Microsoft's documentation says Smart App Control lets signed programs run, and it does not check `.cmd` files
  themselves, only the programs they start. If Windows still blocks `monomem.cmd`, Unblock the zip and extract again. Do
  not turn Smart App Control off. In Task Manager, the Details tab shows `monomem-node.exe`, but the Processes tab still
  shows "Node.js JavaScript Runtime" (that name is inside Node's signed file, which we do not change). We have not yet
  tested this on a computer with Smart App Control switched on.
- **Mac.** A browser download gets a download mark (`com.apple.quarantine`), and macOS Gatekeeper checks marked programs. Node's `runtime/node`
  is signed by its makers; the `monomem` launcher is a plain text script and is not signed. If you see "cannot be opened
  because Apple cannot check it for malicious software" (or "from an unidentified developer"):
  1. Open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to the Monomem message.
  2. Or, in Terminal, remove the mark from the unpacked folder once: `xattr -dr com.apple.quarantine ~/Downloads/Monomem`
  An archive fetched with `curl` gets no such mark at all. We have not yet tested these steps on a Mac.
- **Linux.** No warning. `chmod +x Monomem/monomem` if your unpacker dropped the executable bit.

**Check the download (recommended)**

1. Download `SHA256SUMS` from the same release, into the same folder as the archive.
2. Compare:
   - Windows (PowerShell): `Get-FileHash .\monomem-<version>-win-x64.zip -Algorithm SHA256`, then find that value in `SHA256SUMS`.
   - Mac: `shasum -a 256 monomem-<version>-darwin-arm64.tar.gz` (or `-darwin-x64`), then find that value in `SHA256SUMS`.
   - Linux: `sha256sum -c SHA256SUMS --ignore-missing`
3. The checksum only proves the file matches the release. To check that this project's GitHub build made it, use the
   GitHub CLI: `gh attestation verify monomem-<version>-<target>.zip --repo calasdan-sketch/monomem` (or the `.tar.gz`).

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
> **Seven tools are shown by default** (`memory_save`, `memory_search`,
> `memory_read`, `memory_list`, `memory_archive`, `memory_replace`,
> `memory_catch_up`) — enough to save, find, read, archive and safely replace a
> memory and catch up at session start. A client that loads every tool's schema
> up front pays for it on each request, so the operator tools (review, task board, trust, held writes,
> tidy, history, usage, sessions) are opt-in. To switch
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
> `"MONOMEM_TOOLS": "memory_sessions,memory_held"`. A 1.5 name in the list
> (such as `memory_index`) turns on the 1.6 tool that answers for it, and
> `"MONOMEM_TOOLS": "legacy-1.5"` shows the 1.5 tool list instead.
> The default seven are always kept, so a typo cannot leave you unable to read
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
the address (`https://<your host>/mcp`) and your own app key (shown once by `monomem keys add`, formerly `monomem token add`). Every
client sends the key as `Authorization: Bearer <token>`. Keep the key out of files you commit.

**Claude Code**

```bash
claude mcp add --transport http monomem https://<your host>/mcp --header "Authorization: Bearer <token>"
```

Then type `/mcp` in Claude Code: `monomem` should show as connected. A red mark with 401 means the app key is wrong.

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
