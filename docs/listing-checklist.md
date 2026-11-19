# Listing checklist

Files are ready; nothing has been published. The owner does each sign-in step. The name everywhere is
`io.github.calasdan-sketch/monomem` and the version must equal `package.json` (the test `round3-commands` checks both).

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Needs: `mcpName` in package.json (set), `server.json` (set: name, description under 100 characters, version, npm package, stdio), and the
npm package published with that `mcpName` first.

1. `npm publish` the version in package.json (registry checks the npm package carries `mcpName`).
2. Install the publisher: `brew install mcp-publisher` or download it from the modelcontextprotocol/registry releases.
3. `mcp-publisher login github` (owner signs in with the calasdan-sketch GitHub account; this proves the `io.github.calasdan-sketch/` namespace).
4. From the repo root: `mcp-publisher publish`.
5. Check: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.calasdan-sketch/monomem"`.

## 2. mcp.so

Needs: repository URL, name, one-line description. Sign in with GitHub, choose Submit, paste the repository URL. No file needed.

## 3. awesome-mcp-servers (punkpeye/awesome-mcp-servers)

Needs: a pull request adding one line in the right category (Memory/Knowledge): `- [calasdan-sketch/monomem](https://github.com/calasdan-sketch/monomem) 📇 🏠 - Local shared memory for AI agents, with writer provenance and undo.` Follow the file's alphabetical order and legend; the PR title is the server name.

## 4. Glama (glama.ai/mcp/servers)

Needs: a public GitHub repository with a LICENSE and README. Sign in with GitHub, Add Server, paste the repository URL. Glama builds and scans it; a `glama.json` with `maintainers` in the repo root claims ownership.

## 5. cursor.directory

Needs: a sign-in with GitHub, then Submit under MCP servers: name, description, repository URL, and the install config (command `npx`, args `-y monomem mcp`). A one-click Cursor install link can be generated from that config.

## 6. Claude plugin directory

Needs: the plugin folder in this repository (`.claude-plugin/plugin.json` and its hooks/skills, version in sync via `npm run version`), then the submission form linked from Anthropic's plugin directory page. The owner signs in with the Claude account and submits the repository URL.

## 7. Cursor marketplace

Needs: the same plugin manifest, a README, a LICENSE and a public repository; submit through the Cursor marketplace publisher page with the owner's Cursor account.

## Before any of them

- `npm test` green, `monomem doctor` clean, version bumped and CHANGELOG dated.
- No secrets in the repository (`monomem audit-memory .`).
