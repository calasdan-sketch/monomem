# Claim checks and line citations

A note can carry checks that say what must stay true in the code. Monomem re-checks them against the files when the note is
read. When one stops holding, the note gets a label. This is a narrower signal than [code anchors](./trust.md) (`files`):
an anchor says "this file changed", a claim says "this fact no longer holds".

## Adding claims

Pass `claims` to `memory_save` when creating a note (at most 20). Each entry is one of:

| Entry | Holds when |
|---|---|
| `{ "file": "src/config.ts", "contains": "port = 8443" }` | the file holds this exact text (case-sensitive, 1-200 characters, no regular expressions) |
| `{ "file": "package.json", "dependency": "zod" }` | the JSON file lists the name in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` |
| `{ "file": "scripts/deploy.sh", "exists": true }` | the file is there |
| `"src/auth.ts:10-24"` or `{ "file": "src/auth.ts", "lines": "10-24" }` | a line citation (at most 200 lines): Monomem stores a SHA-256 hash of those lines and later compares it |

Every claim must hold when the note is written. A claim that is false now, or cites lines past the end of the file, is
refused and nothing is written. Claims can only be added when a note is created: to change them, replace the note.

## What you see

- All claims hold: no label. `monomem review code` counts these notes: "N notes' claims and cited code still match the files".
- A `contains`, `dependency` or `exists` check fails: reads carry `claims_failed` and the label
  `[no longer true in code: claim 1 on src/config.ts]`.
- Cited lines changed or are gone: the label is `[cited code changed: src/auth.ts:10-24]`.

The labels show in search results, `memory_get`, and at session start. The note is not hidden, changed or deleted for it.
A label names the file and line numbers only, never the claim's text.

- `monomem review code` lists the notes with a failing claim and what failed; `monomem review` lists them too. `--json`
  adds `claims_failed` and `claims_holding`.
- `monomem review keep <id>`: a person says the note is still right. A changed citation is re-hashed to the lines as they
  are now. A failing check, or a citation whose lines are gone, is dropped (the person judged the note, not the check).
- `monomem replace --old <id> ...` replaces an out-of-date note.

## Limits and safety

- Files are only read. Nothing is ever run: no commands, no scripts, no regular expressions.
- Claims need a git repository with a commit: the folder a local MCP server was started in, otherwise the folder the Monomem
  process runs in. Outside one, `claims` is refused (unlike `files`, which is then ignored).
- Paths stay inside the repository root. Refused: `..`, an absolute path outside it, a folder, a path through a symlink
  that leads out. A file that later becomes a link out of the root is not read; its claim fails with "path leads outside the
  repository".
- A file over 1 MB is not read; its claim fails with "file over 1 MB, not read".
- Checks compare the files on disk now, including uncommitted edits (code anchors compare committed code).
- Line endings do not count: a file switched from CRLF to LF still matches.
- Files are cached by size and modification time. On a file system with a coarse clock (FAT, old HFS+), a same-size
  rewrite within one clock tick shows as unchanged until the next write.
- Not covered yet: claims on a write held for approval are dropped; claims are not exported or synced (a backup copy of
  the database keeps them); the dashboard review page does not list them yet (`monomem review` does).
- Storage: the `code_claims` table holds the repository folder, file paths, the check text and the line hashes, plain
  (never encrypted), like code anchors. Leave claims out of a note whose subject must stay private.
