# Claude Code plugin and MCP registry entry

## Install as a Claude Code plugin

```
/plugin marketplace add calasdan-sketch/monomem
/plugin install monomem@monomem
```

The plugin pins the published npm version, so a new feature reaches plugin users only when a release is published to npm; a change that is only in this repo does not. `npm version x.y.z` rewrites the version in `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json` and `server.json` (`scripts/sync-plugin-version.mjs`), so they stay in step.

Nothing is built or installed from the checkout: the plugin only contains config files, and every command it runs is `npx -y monomem@<version> ...`, so Node >= 22.16 and npm access are all it needs. The version is pinned on purpose (a database upgrade is one-way); a test keeps it equal to `package.json`.

What it adds:

- **MCP server** `monomem` (`.mcp.json`): `npx -y monomem@<version> mcp` with `MONOMEM_CLIENT=claude-code`, so writes are stamped `stdio:claude-code`.
- **SessionStart hook** (`hooks/hooks.json`, events `startup|clear|compact`, `timeout` 20 seconds): `npx -y monomem@<version> hook session-start`, which shows recent notes at the start of a session. It reads the session id Claude Code passes in, so receipts (`monomem receipts`) and the meter work; this is the same command `monomem setup --capture` writes for the start hook.
- **Skills**: the root `SKILL.md` and `skills/monomem-mem/SKILL.md`, loaded from the repo, not copied. The second one needs `MONOMEM_TOOLS=all` on the server, which the plugin does not set.

`claude plugin validate` passes on the plugin folder.

**Start-up cost.** Every command goes through `npx`. Measured on one Windows machine: about 5.7 s for the first run when `monomem@<version>` is not in npm's cache, about 2.0 s when it is. The hook has a 20 second timeout, so a cold start is slow but should finish. Your numbers will differ with network and disk.

## How it differs from `npx monomem setup`

- The plugin does not touch `~/.claude.json` or `~/.claude/settings.json`; uninstalling the plugin removes it. `setup` edits those files (with a diff, consent and `--undo`).
- The plugin has no automatic capture hooks. `setup` offers them only with consent (`--capture`); to get them, run `npx monomem setup --capture`.
- The plugin serves Claude Code only; `setup` also wires Cursor, Codex, Gemini and others.
- On native Windows, `setup` writes `cmd /c npx ...`; the plugin's `.mcp.json` is static and uses plain `npx`. If `/mcp` shows it failing there, use `setup`.
- Both share the same database (default `~/.monomem`), so they can be used together, but then Claude Code has two `monomem` MCP servers; pick one.

## MCP registry entry

`server.json` follows the schema at `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (see https://github.com/modelcontextprotocol/registry, docs/reference/server-json). `package.json` carries `"mcpName": "io.github.calasdan-sketch/monomem"`, which the registry checks against the npm package. `server.json` `version` and `packages[0].version` must be bumped with every release (the test fails otherwise).

## What is not done

Nothing is published or submitted. Each of these needs the owner's approval: publishing an npm release containing `mcpName` (the registry reads it from the published package), `mcp-publisher publish` to the registry, and listing the plugin in any marketplace or directory beyond this repo's own `marketplace.json`.

## npm package

The plugin files (`.claude-plugin/`, `.mcp.json`, `hooks/`, `server.json`) are not in the npm package: Claude Code installs the plugin from GitHub, and the registry reads `mcpName` from `package.json`. The `files` list already excludes them.
