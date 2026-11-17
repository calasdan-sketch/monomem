# What a note touched, and rolling back by note

A wrong or planted note does not stay in one place. Apps read it, then write new notes and claim tasks based on it.
These two commands show how far it reached, and undo it together with what was built on it.

```
monomem why 42 --touched          # who read note 42, and what was written after
monomem rollback --note 42        # undo it and the notes built on it (shows the plan first, then asks)
```

Both are administrator tools. In the dashboard, a note's "..." menu has **What did this touch?**, which shows the same
list and offers **Undo it and what was built on it**. Agents with an admin key can use `memory_usage` (action `why`) with `touched: true`
and `memory_rollback` with `note`. Neither tool is in the default tool set.

## Proven and likely

Monomem keeps the two kinds of answer apart.

**Proven** means Monomem recorded it:

- a read: an app was handed the note (search, read, list, catch-up, a hook). The access log records which note ids each
  read handed out, who read them and when.
- a session start that showed it (the session-start receipt).
- a note or task saved with `derived_from` naming this note, or naming a note that was itself built on it (up to 5 steps).
- a note this note replaced, if it is still replaced.

**Likely** is a guess, so check these items yourself:

- a note created or changed by an app that had read this note, after the read and within the time window
  (`MONOMEM_TAINT_WINDOW_HOURS`, default 12 hours);
- a note written in a session whose start showed this note;
- a task claimed by an app that had read this note, after the read.

Nothing says that app used this note. It may have written something unrelated.

## Rolling back by note

`monomem rollback --note <id>` uses the same steps as `monomem rollback --writer`. First it shows the plan and changes
nothing. Then you confirm once, and the whole plan is applied in one transaction: all of it or none of it. If anything
changed after the preview, nothing is changed and you are asked to preview again.

The plan:

| What | Done |
|---|---|
| the note itself | archived (not deleted) |
| notes it replaced | brought back |
| open flags on it | cleared (the rollback settles them) |
| notes built on it (proven) | archived if they were created that way; if a note was changed that way, its earlier text is put back |
| likely notes and claimed tasks | only with `--include-likely`: archived or put back the same way; a claimed task's claim is released |

The same rules apply as for the writer rollback:

- A restored text keeps its original author.
- If another writer changed a note later, it is skipped unless you add `--include-conflicts`.
- Pinned notes and notes in approve-first projects can only be rolled back from the `monomem` command on this computer.
- A flag raised on this computer (by you, or by a local app) is never cleared by an app key.
- A note that was replaced is skipped. Undo that replacement first.

**Undo the rollback:** `monomem restore <id>` brings back an archived note. `monomem history restore <id> <version>`
undoes a restored text. The message at the end lists both.

## Limits

- Reads are kept as long as the access log (`MONOMEM_ACCESS_LOG_DAYS`, default 30). Monomem records no reads when the
  access log is off (`0`).
- Monomem only sees reads through its own tools and hooks. It cannot see what an app did with a note somewhere else,
  for example a file it edited or a message it sent.
- An app that wrote a note based on this one without passing `derived_from` shows up as "likely" at best.
- Only reads by apps are recorded: app keys and local apps (`stdio:<app>`). Your own reads are not: the dashboard (it uses
  your main key) and the `monomem` command at the terminal. Opening your own dashboard never counts as an app reading a note.
- One read records at most 200 note ids. Reads of held writes record nothing, because those ids are not note ids.
- Each recorded id takes about 144 bytes. Heavy use measured about 43 MB over 30 days; rows older than the access log
  period are removed.
- The read rows hold note ids, reader names, tool names and times. They never hold note text or titles. They are stored in
  a separate table (`note_reads`) in the same database, which Monomem creates the first time it needs it. The schema
  version does not change, so 1.5.0 still opens the database.
