# Launch checklist

Nothing here has been published. Every step that posts, submits or signs in under your name is marked **needs Dan**. Files that
can be prepared in the repository are marked **done** (they exist and are checked by the tests).

## Files in the repository

| What | Status |
|---|---|
| `server.json` for the official MCP Registry | done (not yet validated against the registry: run `mcp-publisher validate`, needs Dan) |
| `mcpName` in `package.json` | done. The registry's quickstart says an npm package must carry `mcpName` equal to the server name, and that GitHub sign-in needs it to start with `io.github.<your GitHub name>/` (source: the registry's own docs, `docs/modelcontextprotocol-io/quickstart.mdx` in github.com/modelcontextprotocol/registry, read when this was prepared) |
| Social-preview picture | done: `docs/brand/social-preview.svg` (1280 x 640). GitHub wants a PNG or JPG for the repository setting: export it first (any browser can save it as an image) |
| README badges | done: CI, npm version, license and Node badges are already at the top of the README |

## Repository settings (needs Dan)

- Description: `One memory, shared by all your AI apps. Self-hosted, one SQLite file, every note says who wrote it.`
- Topics to add: `mcp`, `model-context-protocol`, `memory`, `ai-agents`, `claude`, `cursor`, `sqlite`, `self-hosted`, `llm`, `local-first`
- Upload the social-preview image: Settings, General, Social preview. **needs Dan**

## Listings

| Step | Status | Notes |
|---|---|---|
| Official MCP Registry | needs Dan | Publish to npm first (the registry only stores a pointer; the package must exist). Then install `mcp-publisher`, `mcp-publisher login github`, `mcp-publisher publish`. The `version` in `server.json` must match the npm version you publish |
| Glama | needs Dan | Claim the server on glama.ai (sign-in) once the repository is public and has a license. Check their current instructions before submitting |
| PulseMCP | needs Dan | Their site lists servers from the official registry; submit through their form if it does not appear. Check their current instructions |
| mcp.so | needs Dan | Submit through their site (sign-in). Check their current instructions |
| awesome-mcp-servers | needs Dan | Open a pull request adding one line to the list; read that repository's CONTRIBUTING file first for the exact format and category |
| Show HN | needs Dan | Read the Show HN rules first (news.ycombinator.com/showhn.html): it has to be something people can try, no sign-up wall, and you answer questions yourself. Do not ask friends to upvote |
| Reddit | needs Dan | Each subreddit has its own self-promotion rule (often a limit such as one self-promo post per ten others, or a weekly thread). Read the rules of the exact subreddit before posting and disclose that you built it |

None of the "check their current instructions" rows were fetched or verified when this was written; rules on those sites change.

## Before any post

1. `npm publish` is a separate decision (needs Dan). The version in the README, `server.json` and npm must agree.
2. Run `monomem demo --out receipt.html` and keep the receipt: it shows what the tool does without claiming more than it measures.
3. Say plainly what it is not (README, "What Monomem is not").
