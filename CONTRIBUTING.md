# Contributing to Monomem

Thanks for your interest — small, focused contributions are very welcome.

## Ground rules

- **Keep it minimal.** This project deliberately has two runtime dependencies
  (`@modelcontextprotocol/sdk`, `zod`) and no native modules. A PR that adds a
  dependency needs a strong reason; one that adds a native module almost
  certainly won't be merged.
- **Tests pass.** `npm test` must be green (it builds, then runs the suite).
  New behaviour needs a test; bug fixes should come with a regression test.
- **Big files are known.** `src/store.ts`, `src/cli.ts` and `src/mcp-server-core.ts` are large. Splitting them is
  deliberately deferred: 1.5.0 wanted no behaviour change from a move. Please do not send a split as part of another change.
- **No secrets, ever.** Don't commit tokens, `.env` files, or anything under
  `data/`.

## Getting set up

Requires Node.js **>= 22.16.0**. Two things are needed and they landed at
different times: `node:sqlite` was unflagged in 22.13.0, and SQLite was built
with FTS5 (which every search uses) from 22.16.0. The whole Node 23 line lacks
FTS5 and is refused. CI runs the suite on Node 22.16.0, 22 and 24, so the
supported floor is actually executed.

```bash
npm install
npm run build
npm test
node dist/src/cli.js doctor   # sanity-check Node/DB/token
```

## Before you open a PR

1. `npm test` is green locally.
2. `npm audit` shows no new high/critical issues.
3. Your change keeps the public HTTP/MCP surface backwards-compatible, or the
   PR explains why a break is necessary.
4. If it touches security (auth, tokens, scopes, the request path), say so in
   the PR description so it gets a closer look.

## Reporting bugs / ideas

Open an issue using the templates. For anything security-sensitive, **don't**
open a public issue — see [SECURITY.md](./SECURITY.md).
