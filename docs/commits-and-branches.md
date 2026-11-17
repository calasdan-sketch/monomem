# Which commits used a note, and notes that stay on their branch

Two features for people who run coding agents in git repositories. Both work on this computer only and never use the
network.

## Branch-scoped memory

When a local agent app (one that runs Monomem as its own MCP server) saves a note inside a git repository, Monomem also
records the repository and the branch it was on. It reads them from the `.git` files and does not start git for each
write.

At session start the notes are ranked in this order:

1. Notes of this repository written on the branch you have checked out.
2. Other notes of this repository, including notes from its other worktrees.
3. Notes with no recorded folder (REST, app keys, the command line).
4. Notes from other projects, and notes written on another branch of this repository that is still open. These are
   shown only when they match your branch name, changed files or recent work. A note from another branch carries a
   label such as `(branch feature-x)`, so the agent can tell it came from unfinished work.

When that branch is merged into the branch you have checked out, or is deleted, its notes count as ordinary notes of the
repository again. They are not labelled. To find this, Monomem makes one local `git for-each-ref --no-merged=HEAD` call
at session start. It makes the call only when the repository has notes from another branch.

Limits:
- Only notes saved by a local agent server have a recorded branch. Notes saved through REST, an app key or the
  command line stay neutral.
- "Merged" means merged into the branch you have checked out now, not into the repository's default branch.
- The branch is recorded on this computer only and is not copied by device sync.
- Search (`memory_search`) is not scoped by branch. Only session start is.

## The commit trail

`monomem why <id> --commits` lists the git commits made during sessions that used the note. A session used the note if
it was shown the note (at session start or by the prompt step, from its receipt) or wrote the note.

```
monomem why 42 --commits
#42 "Staging runs on port 8443": 1 commit made in sessions that used it
  3f9c2a1b0e  2026-11-16 14:03:00 -06:00  fix: point the deploy script at 8443  (session 1a2b...: shown)
```

`monomem activity --commits` (also `monomem commit-trail`) lists recent sessions, the number of notes each was shown and
wrote, and the commits made while each session ran. Add `--json` to get the same data as JSON.

How a commit is linked:
- Monomem runs `git log` in the session's folder for the time between the session's start and end. It looks at local
  branches only and leaves out merge commits.
- It counts only commits whose committer email matches this repository's `git config user.email`. A commit you pulled
  from someone else is not counted.
- If a commit has a `Monomem-Notes:` line, that line decides. A commit whose line does not name the note is left out.
- Two sessions open in the same folder at the same time cannot be told apart without the commit line. Each of them
  counts the other's commits.
- Receipts are kept for `MONOMEM_ACCESS_LOG_DAYS` (default 30). After that, a session no longer shows which notes it was
  shown.

## The commit line (opt-in, per repository)

```
monomem commit-trail on       # asks first; adds a prepare-commit-msg hook to THIS repository only
monomem commit-trail status
monomem commit-trail off      # removes the hook
```

When a commit is made in the repository while an agent session is working there, the hook adds a line to the commit
message:

```
Monomem-Notes: #12 #40
```

The line names the notes the session wrote and was shown, at most 12 of them, plus `+N` for the rest. It contains note
numbers only, never titles or text. It still goes into the repository's history, so anyone who can read the repository
can see which note numbers were used. That is why the hook is off until you turn it on.

- `monomem setup`, run at a terminal inside a git repository, asks whether to turn the hook on. The default answer is
  no. `monomem setup --undo` removes a hook that setup added.
- The hook never blocks a commit. If Monomem is missing or fails, the commit goes through without the line.
- Merge, squash and amend messages are left alone. A message that already has the line is not changed again.
- If the repository sets `core.hooksPath` (Husky or another hook manager), Monomem does not change it. It tells you
  to add the line to that hook manager yourself.
- If a `prepare-commit-msg` hook that Monomem did not write already exists, Monomem does not replace it or remove it.

The commit line, like the rest of the trail, is not a signature. It records what Monomem knew when the commit was
made. Each write receipt is signed separately; check one with `monomem verify-receipt`
([provenance.md](./provenance.md)).
