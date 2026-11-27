# blame and ask

Two read-only commands built from what Monomem already keeps. No model, nothing new is recorded. Both search by keyword (the same search every read uses), so a note that shares none of your words is not found.

## monomem blame "<claim or topic>" [--limit N] [--json]

For each matching note, one line: who wrote it first and last, when, from which source and session, how many versions (and how many are kept), whether a person confirmed this version, whether an edit is held, whether it was replaced, whether it conflicts with another matched note or is backed by independent writers, and what changed it last. A match is a candidate, not proof. The command changes nothing; to undo a writer use `monomem rollback --writer <label>`.

## monomem ask "<question>" [--since 7d|<date>] [--writer <label>] [--limit N] [--json]

A retrieval timeline: the matching notes grouped by topic (a replaced note and its replacement, or two notes linked as conflicting, share a topic), newest first, one line each as `date | writer | title | state | id`. The output says it is a retrieval timeline and not a generated answer; the JSON carries `"generated": false`. Read a note with `monomem show <id>`; its story is `monomem why <id>`.

## Who sees what

The shell commands are the owner's view: replaced notes, a distrusted writer's notes and the held-edit count are shown. Only titles are printed, never note text, and never the text of a held edit. Another note's id appears (for a replacement or a conflict) only when that note is itself in the answer.

REST: `GET /blame?q=` and `GET /ask?q=` (also `since`, `writer`, `limit`, `namespace`) use the same read policy as `GET /search`: the key's namespaces and sensitivity limit, the distrust list, no archived notes. `include_superseded=1` (replaced notes) and the held-edit count need an admin key. The query is not echoed back. Both routes are in the scope matrix test (test/scope-matrix.test.ts).
