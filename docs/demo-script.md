# Demo script (about 90 seconds)

Run `monomem demo --slow --out receipt.html` and read along. It works in a temporary folder that is deleted at the end, needs no
network, and leaves nothing in `~/.monomem`. Run it as many times as you like: it does the same thing each time. Without `--slow`
it finishes in a few seconds.

1. **Two apps, one memory (0:00).** "Claude Code saves a note. Cursor reads it. Look at the writer: the server recorded who wrote
   it. The app could not choose that."
2. **A limit hides a private note (0:20).** "This note is private. An app with no limit sees three notes. An app limited to
   internal sees two. The private note is not found, not searched and not counted."
3. **A poisoned note is held (0:40).** "A web clipper tried to save text that tells an AI to ignore its instructions. It was held
   for review, not stored. Nothing reaches search or recall until a person approves it."
4. **Replace and undo (0:55).** "A wrong note is replaced in two steps: preview, then confirm. The old note is kept. And it can be
   undone."
5. **The receipt (1:15).** "The benchmark runs offline on a throwaway store. The receipt shows the versions, the date and, at the
   bottom, what it does not measure."

Close with: "Everything stays in one file on your computer. `npx monomem setup` connects your apps."
