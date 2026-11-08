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
| Show HN | needs Dan | Read the Show HN rules first (news.ycombinator.com/showhn.html): it has to be something people can try, no sign-up wall, and you answer questions yourself. Do not ask friends to upvote or comment |
| r/opensource | needs Dan, likely blocked | Reported by the Round 4 launch review (Nov 2026): the subreddit bans AI-built projects since Oct 2026 and wants projects at least a year old. Monomem is AI-assisted and months old, so assume a post is removed. Re-read the sidebar before deciding |
| r/ClaudeAI | needs Dan | Reported by the same review: showcases go in the "Built with Claude" megathread, and a normal feed post needs 50+ karma. Use the megathread |
| r/selfhosted | needs Dan | Reported by the same review: projects under 3 months old go in the New Project Megathread, not as a post of their own |
| r/mcp, r/cursor, r/LocalLLaMA, r/OpenSourceAI | UNVERIFIED | Nobody has read these rules. Read each sidebar first; do not post on a guess |

The Reddit rows come from a review, not from reading each sidebar today: rules change, so open the sidebar and the rules page of the exact
subreddit before you post. The other rows ("check their current instructions") were not fetched or verified when this was written.

### What gets a post removed, in general

Posting the same link in several communities in a row, hiding that you built it, a brand-new account with no history, asking for votes,
a post that is mostly a link with no explanation of what it does or does not do, and claims you cannot back up. Disclose that you built it,
and that parts were written with an AI assistant.

### Safe wording for the download

Say what a person does and what it needs, not what it guarantees. For example: "Free, MIT licence, runs on your own computer. Needs Node
22.16 or newer, or Docker. Install: `npx monomem setup` (it shows every change and asks first)". Link the repository and the npm page.
Do not offer a download from anywhere else.

### DO NOT CLAIM

- "Secure", "safe", "protects against prompt injection" or "stops poisoning". It holds writes that match known patterns; a reworded
  attack can pass (README, Known limits).
- "Private" without the rest of the sentence: limited apps cannot see a `private` note; apps with no limit still can.
- "Works with every AI app" or any named app you have not tried yourself.
- "Understands meaning" or any search-quality number as a promise. The honest numbers are in the README and come from a QA pass.
- "Your data never leaves your machine" while embeddings point at a remote URL, or if a tunnel or sync folder is in use.
- "Audited", "certified", "compliant", "enterprise-ready", "production-ready".
- Download counts, stars or users you have not just looked up.
- That the tests prove it secure: they prove the checks it has behave as written.

## Before any post

1. `npm publish` is a separate decision (needs Dan). The version in the README, `server.json` and npm must agree.
2. Run `monomem demo --out receipt.html` and keep the receipt: it shows what the tool does without claiming more than it measures.
3. Say plainly what it is not (README, "What Monomem is not").
