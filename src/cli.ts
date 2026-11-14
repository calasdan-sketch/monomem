#!/usr/bin/env node
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { gatePinned, gateOutside, requireOperator } from "./operator-gate.js";
import { actorStore, setProcessWriter } from "./actor.js";
import { type Sensitivity, mayEmbed, DEFAULT_SENSITIVITY, SENSITIVITY_HELP, SENSITIVITY_LEVELS, parseSensitivity } from "./sensitivity.js";
// monomem CLI: one command to run, check, or wire up the bridge.
//   monomem [start]   start the API + dashboard AND MCP-over-HTTP (default)
//   monomem mcp       start the MCP server over stdio (for Claude Code/Cursor/...)
//   monomem doctor    check Node, database, and token
//   monomem init      print the config snippet to wire it into your agent
//   monomem help      show help

/** Every command main() accepts, for the unknown-command check and the "did you mean" hint. */
const COMMANDS = [
  "start", "serve", "mcp", "mcp:stdio", "doctor", "init", "setup", "uninstall", "sync", "reindex", "recall", "hook",
  "consolidate", "rebuild-edges", "relevant", "search", "token", "changes", "backup", "runner-status", "watch", "export", "import", "trust",
  "quarantine", "approve-first", "access", "flood", "resume", "decay", "archive", "restore", "delete", "quality", "conflicts", "facts", "fact",
  "encrypt", "meter", "receipts", "why", "never-show", "supersede", "history", "pin", "unpin", "rollback", "bench", "drill", "health", "audit",
  "add", "show", "ls", "forget", "edit", "connect", "open", "label", "scrub", "purge-deleted", "pii", "digest", "safety-report", "demo", "snippet", "confirm", "review", "config",
  "help", "--help", "-h", "--version", "-v", "version",
];

/** Plain edit distance; the command list is tiny, so the simple version is fine. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The closest known command, or undefined when nothing is plausibly what the person meant. */
function suggestCommand(cmd: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // 1 or 2 edits; farther is a guess, not a hint
  for (const c of COMMANDS.filter((x) => !x.startsWith("-"))) {
    const d = editDistance(cmd.toLowerCase(), c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function shortUsage(): void {
  console.log(
    [
      "monomem <command>      (the most-used commands; 'monomem help --all' lists every one)",
      "",
      "Get started",
      "  demo                    A short tour on a throwaway store (never touches your notes)",
      "  setup [--dry-run]       Connect Monomem to the AI apps on this computer (shows the changes, asks first)",
      "  connect <app> [--restricted]   Connect one app (add --restricted to keep it away from private notes)",
      "  open                    Open my notes in the browser (starts Monomem if needed)",
      "  doctor                  Check Node, the database, the token and the setup",
      "  import --claude         Bring in what Claude Code already remembers (add --dry-run to look first)",
      "  start                   Run the dashboard, REST API and MCP-over-HTTP (the default)",
      "  mcp                     Run the MCP server over stdio (what your apps launch)",
      "",
      "Daily",
      "  relevant \"message\"      Show the notes that relate to a sentence (search \"words\" does the same)",
      "  search|relevant \"message\" --as-of 7d [--json]   The same, as memory stood then (ISO time or 7d/2h; no message lists notes)",
      "  changes                 What changed while you were away",
      "  history <id>            A note's earlier versions (history restore <id> <version> puts one back)",
      "  add \"text\" [--title T] [--ns work] [--tag a,b] [--private]   Save a note (\"-\" reads the text from a pipe)",
      "  show <id> | ls [--ns x] [--limit 20] [--archived] | edit <id> [-] | forget <id>   Look at, list, change or archive notes (forget can be undone with restore; ls --archived lists them)",
      "  pin <id> | unpin <id>   Pin a note so agents can read it but not change it",
      "",
      "Trust",
      "  quarantine              Review writes that were held (by the linter or an approve-first namespace)",
      "  confirm <id> [--source \"what you checked\"]   Confirm a note from outside content after checking it (asks you to type yes)",
      "  review                  List notes waiting for a person: unconfirmed outside content and notes past re-confirmation",
      "  config                  Show or change settings kept in the store (re-confirmation expiry)",
      "  approve-first           Hold every agent write to a namespace until you approve it",
      "  trust                   Distrust a writer; decide which other servers' exports to believe",
      "  token                   Make, list or remove access tokens for your apps (add needs a terminal)",
      "  rollback --writer w --since 2h   Undo what one writer did (shows a plan first)",
      "  why <id> [--json]       The story of one note: who wrote it, versions, replacements, holds, sessions shown it",
      "  receipts [session] [--json]   Which notes a session start showed, and why (ids and tags, never note text)",
      "  conflicts               Notes from different writers that disagree (flag only)",
      "  facts [--check]         The decisions agents recorded; --check exits 1 if writers disagree (for CI)",
      "  access                  Who read memory, and when",
      "  drill [--json]          Replay known memory-poisoning attacks on a copy of your store and your settings",
      "  health [--json] [--card [file.svg]]   One grade A-F with the reason: setup, settings, drill, audit chain, held writes (rule: health --help)",
      "",
      "Maintenance",
      "  backup [--out <dir>]    Copy the database safely, even while the server runs",
      "  export | import         Move notes in and out (JSON or Markdown)",
      "  quality                 Duplicates, stale notes and flagged notes worth a look",
      "  delete <id>             Delete a note permanently, with its earlier versions",
      "  uninstall               Take Monomem out of every app setup connected",
      "",
      "Per-command options: 'monomem help --all'. Docs: https://github.com/calasdan-sketch/monomem",
      "",
    ].join("\n")
  );
}

function usage(all = false): void {
  if (!all) return shortUsage();
  console.log(
    [
      "monomem <command>",
      "",
      "  start     Start the API + dashboard AND MCP-over-HTTP (default).",
      "            When: always-on. Local by default (127.0.0.1); to reach it from a phone or claude.ai,",
      "            put your own authenticated tunnel in front of it (see INFRA.md).",
      "  mcp       Start the MCP server over stdio.",
      "            When: wiring a local agent (Claude Code / Cursor / Copilot). See: monomem init",
      "  --version, -v   Print the installed version.",
      "  doctor    Check Node, database, token, namespace config, and the recall hook.",
      "            When: something isn't working, or after changing config.",
      "  init      Print the config snippet to wire monomem into your agent.",
      "            When: you want to see the config before using it, or to copy it by hand.",
      "  connect <app> [--restricted] [--max public|internal|private] [--name label] [--print] [--dry-run] [--yes]",
      "            Connect one app (claude-code, cursor, codex ...). --restricted (or --max) gives it its own key and a limit, so",
      "            it cannot see private notes; --name sets that key's label; --print only prints the settings to paste in.",
      "  open [--print]",
      "            Open my notes in the browser with a one-time sign-in code (starts Monomem if needed).",
      "  uninstall [--dry-run] [--yes] [--purge] [--no-backup]",
      "            Take Monomem out of every app setup connected (same as setup --undo, for every setup run).",
      "            --purge also deletes the data folder, after a final backup it names (unless --no-backup).",
      "  setup [--dry-run] [--yes] [--only claude-code,claude-desktop,cursor,codex,gemini,muse,vscode,zed] [--project] [--hook|--no-hook] [--capture|--no-capture] [--db <file>] [--undo]",
      "            Connect monomem to Claude Code / Claude Desktop / Cursor for you. Shows the plan and the exact lines it will",
      "            change, saves a backup of each file first, writes only after you type y. An old \"claude-bridge\" entry is offered",
      "            for migration with your data kept. --dry-run only shows; --undo puts back what it changed.",
      "            When: first install (npx monomem setup), or moving from claude-bridge.",
      "  reindex   Backfill semantic embeddings for notes missing them.",
      "            When: after enabling embeddings, or after changing the embedding model.",
      "  recall [--limit 10] [--written-by w] [--not-written-by w] [--include-distrusted]",
      "            SessionStart hook: print recent memory as hook JSON (fail-silent).",
      "            Notes from writers on the distrust list are left out unless --include-distrusted.",
      "            When: wired into Claude Code settings.json. See:",
      "            https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md",
      "  hook <session-start|user-prompt|post-tool|post-tool-failure|stop|subagent-stop|session-end|file-context> [--db <file>]",
      "            Automatic memory: the agent's lifecycle hooks (hook JSON on stdin). Records what the agent does, redacted,",
      "            on this machine only, and distills it into observations and a session summary. Always exits 0.",
      "            Off switch: MONOMEM_CAPTURE=off. When: installed by `monomem setup --capture`.",
      "            file-context (PreToolUse on Read) lists what memory knows about the file, once per session; it never",
      "            blocks or changes the Read.",
      "  why <note-id> [--json] [--body]",
      "            The story of one note in time order: who wrote it, versions, replacements, holds, pin, sessions shown it, status.",
      "  receipts [session-id] [--json]",
      "            List recent sessions, or show which memories one session start showed and why (ids and tags are stored, never note text).",
      "  meter [--json] [--card [file.svg]]",
      "            What Monomem costs, as numbers. --card writes a shareable SVG savings card (default monomem-card.svg).",
      "  label <id> [public|internal|private]",
      "            Show or set one note's sensitivity label. A token with a ceiling (max_sensitivity in tokens.json) can never read",
      "            a note above it; a note it cannot read looks exactly like a note that does not exist. Notes start as internal.",
      "  never-show <id> [--undo]",
      "            Keep one note out of the session-start context for good (tags it never-show; it stays searchable).",
      "            When: a memory keeps being shown that does not help. The dashboard has the same button.",
      "  consolidate [--dry-run] [--yes] [--threshold 0.95] [--namespace ns]",
      "            Find near-duplicate notes and merge them. Without --yes",
      "            (or with --dry-run) this only reports — nothing is merged.",
      "            When: periodic cleanup of duplicated agent notes.",
      "  rebuild-edges [--threshold 0.25] [--yes] [--force]",
      "            Recalculate the note similarity graph from scratch: every",
      "            note is re-scored against same-namespace notes and pairs",
      "            at/above the threshold get bidirectional edges. Prints the",
      "            pair count first and asks for confirmation on large",
      "            rebuilds (--yes skips); refuses while another process",
      "            holds the write lock (--force overrides); streams",
      "            progress to stderr. Reports {created, removed} edge",
      "            counts. O(n^2) — maintenance, not interactive.",
      "            When: after a bulk import, or after changing the threshold.",
      "  relevant|search \"some natural language message\" [--limit 5] [--namespace ns] [--written-by w] [--not-written-by w] [--include-distrusted] [--as-of <ISO|7d|2h>] [--mode keyword|semantic|hybrid] [--json]",
      "            Extract keywords from a message and show the relevant notes.",
      "            --as-of (same for search and relevant): memory as it stood then, rebuilt from note history. Shows a snippet,",
      "            an [edited since] marker and the writer then (\"not recorded\" when history lacks it). Times are local with the UTC",
      "            offset. --json prints it as JSON. No message = list the notes.",
      "            Prints the keywords used alongside the results and a short snippet of each note.",
      "            --mode (search only): semantic and hybrid need an embedding service (docs/search.md); without one you get keyword results and a line saying so.",
      "            A search longer than 4096 characters or 64 words is refused.",
      "            When: you have a vague message and want the memory it touches.",
      "  changes [--since 24h|ISO|last] [--consumer name] [--namespace ns] [--source s] [--limit 100]",
      "          [--written-by w] [--not-written-by w] [--note-written-by w] [--not-note-written-by w] [--include-distrusted]",
      "  changes --purge             delete the whole change log (titles of past changes) and all markers",
      "            Prints at most --limit entries (default 100, max 500) and how many more there are; --json pages through and prints them all.",
      "            What changed while you were away: created/updated/deleted notes",
      "            grouped by source. --since last uses (and advances) a per-consumer marker.",
      "  backup [--out <dir>] [--include-approval-key] [--include-attest-key] | backup --prune-premigration",
      "            Consistent hot copy of the database (works while the server runs)",
      "            into <dir>/state.db, plus a copy of the encryption key (.key) if",
      "            at-rest encryption is on. Default dir: ~/monomem-backup-<time>",
      "            (with MONOMEM_HOME set: monomem-backup-<time> in the folder that holds it).",
      "            WARNING: store the key SEPARATELY from the backup; a backup without",
      "            its key is unreadable, and one stored with it is not encrypted.",
      "            --include-attest-key also copies the signing key (.attest-key) so a restore keeps",
      "            this server's signing identity. --prune-premigration deletes EVERY copy an",
      "            upgrade left next to the database: <db>.pre-v*-backup and the dated copies",
      "            (<db>.pre-v*-backup-YYYYMMDD-HHMMSS) kept from earlier upgrades.",
      "            When: before upgrades, and on a schedule.",
      "  runner-status [--namespace ns] [--json]",
      "            Is the PC's command runner listening, and how many approved commands are",
      "            waiting for it (and how many approvals expire soon or already did)?",
      "            Reads the local store; never prints command text.",
      "            When: an approved phone command has not run yet.",
      "  watch [--consumer name] [--wait 25] [--namespace ns] [--written-by w] [--not-written-by w] [--include-distrusted] [--exec <program> [args...]]",
      "            Long-poll loop on this store: prints each new change as it happens.",
      "            With --exec, runs <program> (no shell) per batch with the changes as",
      "            JSON on stdin and MONOMEM_CHANGE_COUNT in the environment.",
      "            When: you want a script or notifier to react to a phone/other-session write.",
      "  export --format md --dir <path> [--namespace ns] [--no-prune] [--force] [--include-distrusted]",
      "            Write one Markdown file per note (YAML front-matter) into",
      "            namespace folders. Deterministic and git-friendly; prunes",
      "            files of deleted notes it wrote earlier (--no-prune keeps them).",
      "  export --format json [--out file] [--attest]",
      "            Full JSON backup (same shape as GET /export) to stdout or a file: {\"notes\": [...]},",
      "            the plain {\"notes\": [...]} shape older importers read. --attest adds an `export` header (this server and",
      "            its public key) and a signed attestation per note, for another server to verify.",
      "  import --file backup.json [--no-dedupe] [--json] [--require-attestation]",
      "            Restore a JSON backup (streamed, so big files are fine). Notes whose attestation verifies against a",
      "            trusted key keep their original writer; everything else is stamped as imported by 'cli' and flagged",
      "            imported_unverified. --require-attestation (or MONOMEM_IMPORT_REQUIRE_ATTESTATION=1) rejects those instead.",
      "  trust [list | identity | distrust <writer> [--namespace ns|*] | undistrust <writer> [--namespace ns|*]",
      "         | attester-add <public-key> --server-id id [--label text] [--not-after time] [--any-server]",
      "         | attester-remove <key-id> | attester-revoke <key-id> | attester-unrevoke <key-id>",
      "         | export-key --out file | rotate] [--json]   (monomem trust --help)",
      "            The trust policy: writers whose notes are left out of every read (and never run),",
      "            and the other servers whose signed exports an import will believe. See docs/trust.md.",
      "  token add --label <name> --scope read|write|admin [--namespace ns] [--max public|internal|private] [--no-limit] | token list | token remove <label>",
      "            Make a random access token for an app and save it in tokens.json (shown once; restart a running server after).",
      "            list shows labels and scopes only. Commands that lower protection (token add, trust undistrust/attester-add/",
      "            attester-unrevoke, quarantine approve/keep-history, unpin, approve-first off, resume) need a real terminal and a typed yes.",
      "  sync --git <repo-folder> [--remote name] [--encrypt] [--key-file f] [--dry-run] [--no-push] [--yes]",
      "            Keep your notes in step across your own computers through a PRIVATE git repository you own: fetch, merge,",
      "            three-way merge into the database, write back, commit, push. No Monomem server. --encrypt seals every",
      "            file before it is committed; the key stays on your computers and never goes in the repository.",
      "  import --claude [--dry-run] [--yes] [--update] [--project <folder>[,<folder>]] [--namespace ns] [--include-index]",
      "            Import what Claude Code already remembers: CLAUDE.md files (user, this folder or --project) and auto memory",
      "            (~/.claude/projects/*/memory). Cut into separate notes at headings, tagged with their source file and project; running",
      "            it again adds only what is new. Anything that looks like a secret is skipped and never shown. Local only.",
      "  import --from claude-mem|mem0|basic-memory|mcp-memory [--path p] [--dry-run] [--yes] [--namespace ns]",
      "            Import another memory tool's notes: claude-mem's database (~/.claude-mem/claude-mem.db, opened read only;",
      "            observations and session summaries keep their type, files, project and dates), a mem0 JSON export (--path),",
      "            or a basic-memory folder (~/basic-memory). Same rules as --claude: secrets skipped, re-runs add only what is new.",
      "            How to switch over and uninstall the old tool: docs/switching.md.",
      "  import --dir <path> [--dry-run] [--allow-move]",
      "            Merge Markdown files back: newer side wins, conflicts are",
      "            reported and the losing version is saved under <dir>/.conflicts/.",
      "            Runs through the memory linter.",
      "  confirm <id> [--source \"what you checked\"]",
      "            A note from outside content (marked unconfirmed) is kept out of session start and cannot be pinned until a",
      "            person confirms it. Run it in a terminal and type yes. The confirm is for the note's current version.",
      "            Also re-confirms a note past its re-confirmation date (it says when the next check is due).",
      "  review [--ns <namespace>] [--json] [--confirm-all [--source \"what you checked\"]]",
      "            Lists the notes waiting for a person (id, title, why, writer): outside content nobody confirmed, and",
      "            notes not re-confirmed within confirm-days. --confirm-all confirms every listed note as you, after one typed yes.",
      "  config [get | set confirm-days <n> | set confirm-mode off|label|enforce]",
      "            Re-confirmation expiry. label (default): a note not changed or confirmed for confirm-days (default 30) is",
      "            labelled in search. enforce: it is also kept out of session start. off: nothing. Nothing is ever deleted.",
      "            Turning a mode on starts every note's clock then. Lowering protection (enforce to label or off) asks you to type yes.",
      "  quarantine [list | show <id> | approve <id> | keep-history <id> [--by <note id>] | reject <id>]",
      "            Review writes the memory linter held (MONOMEM_LINT) or an approve-first namespace held. show lists what was",
      "            saved on the same topic since; approve keeps the time it was written; keep-history stores it as replaced by",
      "            that newer note.",
      "  approve-first [<namespace> on|off | --all on|off]",
      "            Hold every agent write to a namespace in the quarantine queue until you approve it.",
      "            --all on|off: the same for every namespace, including ones created later. No arguments: list the namespaces with it on, and the --all switch. Writes from monomem commands are not held.",
      "  access [--since 24h|ISO] [--writer label] [--limit 100] [--json]",
      "            Who read memory: time, writer label, tool or route, result count, namespaces and a short",
      "            redacted query preview (never note text). Kept MONOMEM_ACCESS_LOG_DAYS (30; 0 = off).",
      "  flood | resume <label>",
      "            Writers the flood guard paused (more than MONOMEM_FLOOD_WRITES_PER_HOUR writes, default 500,",
      "            in an hour) / let one write again. Local stdio apps all share the label \"stdio\".",
      "  quality [--json] [--namespace ns]",
      "            What is worth a look: near-duplicates, stale notes with a newer twin, quarantined writes, notes",
      "            the linter flags, and captured rows about to decay. Each comes with the command that fixes it.",
      "  conflicts [--json] [--namespace ns]",
      "            Live notes from different writers that give different values for the same key (deploy target, package",
      "            manager, a version, a URL). Flag only: you choose supersede, pin, distrust, or remove just the fact.",
      "  facts [--namespace ns] [--json] [--as-of <ISO|7d|2h>] [--check]",
      "            The decisions agents recorded as facts: key, current value(s), writers, since. Marks disputed keys and keys",
      "            two or more writers agree on. --check prints one line and exits 1 if any fact is disputed (0 if none): for CI.",
      "  fact remove <note id> <key>",
      "            Drop one fact from a note. The note stays and gets a fact-removed:<key> tag; its text may still mention the old value.",
      "  decay [--dry-run] [--namespace ns]",
      "            Archive (never delete) captured observations idle MONOMEM_DECAY_DAYS (30) and summaries idle",
      "            MONOMEM_DECAY_SUMMARY_DAYS (180). Never: your own notes, decisions, anything tagged \"pinned\".",
      "            Also runs on its own in the expiry sweep and at the end of a captured session.",
      "  archive <id> | restore <id>",
      "            Soft-archive a note, or bring an archived one back (the undo for decay and archive). monomem ls --archived lists them.",
      "  restore <backup folder | state.db file> [--yes]",
      "            Put a backup back as your database. Refuses while Monomem or an app is using it; copies the current database aside first",
      "            (state.db.before-restore-<time>), removes the stale -wal/-shm files and checks the result. Also works with state.db.pre-vNN-backup.",
      "  add \"text\" [--title T] [--ns work] [--tag a,b] [--private | --sens public|internal|private]",
      "            Save a note from the shell (\"-\" reads a pipe). Same linter, secret refusal and quarantine as any other writer; written as \"cli\".",
      "  show <id> | ls [--ns x] [--limit 20] [--archived] | edit <id> [- | --editor] | forget <id>",
      "            Read, list, change (in $EDITOR, refused if the note changed meanwhile) or archive a note. The CLI is you, the owner: sensitivity limits apply to apps, not to it.",
      "            edit <id> - reads the new text from a pipe (first line the title); without a terminal edit needs - or --editor.",
      "            ls --archived lists forgotten notes with the restore <id> that brings each back.",
      "  audit [--since 24h] [--op create|update|delete|...] [--label <key name>] [--limit n] [--json]",
      "            Who changed what: the change log in plain words (never note text).",
      "  audit verify [--expect <head-hash>]",
      "            Walk the audit log's hash chain and report the first broken line (edits/deletions inside the chain).",
      "            Keep the printed head hash off this machine (a git commit, a password manager). --expect <hash> exits 1 if",
      "            that line is no longer in the log (rewritten or cut off); the log growing past it is fine. Usage errors exit 2.",
      "  scrub [--yes] [--out <dir>]   (also: purge-deleted)",
      "            Remove the text of long-deleted notes from the database file (rebuilds the search index and compacts it).",
      "            Without --yes it only explains. With --yes it takes a backup first, then shows the size before and after.",
      "  pii scan [--namespace ns] [--json]   Suggest notes that look like personal data; prints  label <id> private  commands. Changes nothing.",
      "  digest [--since yesterday|24h|7d|last] [--namespace ns] [--json]   Plain-language summary of what changed.",
      "  safety-report --out report.html      One-page HTML check-up (counts and settings; no note text, no keys).",
      "  demo [--slow] [--out receipt.html]   A scripted tour on a throwaway store; leaves nothing behind.",
      "  snippet [claude|codex|cursor|gemini|windsurf|generic]   Print a memory-habits block for an instructions file.",
      "  import --rules [--project dir[,dir]] [--dry-run] [--namespace ns]   Bring in .cursorrules, .cursor/rules, AGENTS.md, GEMINI.md, .windsurfrules.",
      "  delete <id> [--yes]",
      "            Delete a note permanently, with all its earlier versions. Asks first; cannot be undone.",
      "  encrypt <enable|status|disable>",
      "            enable   Create the AES-256-GCM key and encrypt every note",
      "                     body at rest. Keyword search then covers title+tags",
      "                     only (bodies cannot be indexed as ciphertext).",
      "            status   Report whether at-rest encryption is on, the key",
      "                     path, and how many bodies are encrypted.",
      "            disable  Decrypt every body and remove the key file.",
      "            When: running Monomem as a shared / multi-agent store.",
      "            See: docs/encryption-retention.md for the real tradeoffs.",
      "  supersede --old <ids> (--title T --body B [--tags a,b] [--confidence 0-1] | --new-id N)",
      "            Replace one or more notes with a newer one, SAFELY. It first shows exactly what would stop appearing in",
      "            search and what is not lost, then asks you to type the number of notes (or yes). Nothing is ever deleted:",
      "            the old note is kept, marked replaced, and can be brought back. From a script it only previews and prints a",
      "            one-time code: run again with --confirm-token <code> (same --title/--body) to go ahead.",
      "  supersede undo <id>",
      "            Bring a replaced note back exactly as it was (recorded).",
      "  history <id> [--json] [--include-distrusted] | history restore <id> <version> [--if-rev n] | history purge <id> [--yes]",
      "            A note's earlier versions: list them, put one back (as a new version, nothing is overwritten), or forget them.",
      "  pin [<id>] | unpin <id>",
      "            Pin a note so agents can read it but only this CLI can change, archive, replace or restore it. No id: list pins.",
      "  rollback --writer <name> --since <iso|30m|2h|7d> [--include-conflicts] [--yes] [--json]",
      "            Undo what one writer did since then: archive notes it created, put back the text of notes it changed.",
      "            Shows the plan first; notes others changed later are skipped unless --include-conflicts. \"stdio\" = every local app.",
      "  bench [--json] [--suite name] [--only id] [--seed n] [--dir folder] [--strict-gaps] [--verbose]",
      "            Run the provenance benchmark on a throwaway store: stale memory, contradiction recovery,",
      "            permission isolation, provenance retention. Offline, deterministic, exits 1 on a failure.",
      "            Your own data is never touched. See docs/BENCHMARK.md.",
      "  bench --longmemeval | --locomo [--data file] [--limit n] [--mode keyword|hybrid] [--granularity session|turn] [--json]",
      "            Retrieval benchmark (recall@k, nDCG, MRR) on a public dataset, in a temp folder. No LLM.",
      "  drill [--json]",
      "            Replay known memory-poisoning attacks on a copy of your store and your settings; your data is not changed.",
      "            With no store yet it says so (run setup first).",
      "  health [--json] [--card [file.svg]]",
      "            One grade A-F with the reason: setup, settings, drill, audit chain, held writes. Rule: monomem health --help",
      "  help      Show this help",
      "",
    ].join("\n")
  );
}

/** doctor warns above these (docs/footprint.md). */
const DOCTOR_MAX_DATA_BYTES = 1e9;
const DOCTOR_MAX_BACKLOG = 10_000;

/** doctor: settings that weaken protection, plus a data folder a cloud-sync client may copy. Warnings only; the list is shared with `monomem health`. */
async function doctorSecurityChecks(dataDir: string, bindHost: string, warn: (m: string) => void): Promise<void> {
  const { securityFindings } = await import("./health.js");
  for (const f of await securityFindings(dataDir, bindHost)) if (f.status !== "info") warn(f.detail);
}

async function doctor(): Promise<void> {
  const {
    DB_PATH,
    BIND_HOST,
    API_PORT,
    MCP_HTTP_PORT,
    resolveToken,
    DATA_DIR,
    DATA_DIR_SOURCE,
    LEGACY_DATA_DIR,
    TOKEN_FILE,
    insideNodeModules,
  } = await import("./config.js");
  const { existsSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  const { Store } = await import("./store.js");
  // Colour only for a person at a terminal: not when piped, and not when NO_COLOR is set (no-color.org).
  // FORCE_COLOR=0 / false means off (even on a terminal); any other value forces colour on.
  const force = process.env.FORCE_COLOR;
  const colour = (force === undefined || force === "" ? process.stdout.isTTY : force !== "0" && force !== "false") && !process.env.NO_COLOR;
  const tag = (t: string, code: number) => (colour ? `\x1b[${code}m${t}\x1b[0m` : t);
  let warnings = 0;
  let failures = 0;
  const ok = (m: string) => console.log("  " + tag("[ok]", 32) + "   " + m);
  const say = (kind: string, problem: string, fix?: string) => {
    console.log("  " + tag(`[${kind}]`, kind === "warn" ? 33 : 31) + " " + (fix ? "Problem: " : "") + problem);
    if (fix) console.log("         Fix: " + fix);
  };
  const warn = (m: string, fix?: string) => {
    warnings++;
    say("warn", m, fix);
  };
  const fail = (m: string, fix?: string) => {
    failures++;
    say("FAIL", m, fix);
  };
  // The first run of anything that needs the key creates it and says so on stderr, in the middle of this report.
  // Make it quietly here and report it in its proper place below.
  let keyJustCreated = false;
  {
    const orig = console.error;
    console.error = (...a: unknown[]): void => {
      if (/Generated new bearer token/.test(String(a[0]))) keyJustCreated = true;
      else orig(...(a as []));
    };
    try {
      resolveToken();
    } catch {
      /* reported below */
    } finally {
      console.error = orig;
    }
  }
  console.log("monomem doctor\n");

  const { nodeIsOk, MIN_NODE_TEXT, sqliteHasFts5 } = await import("./setup.js");
  if (nodeIsOk(process.versions.node)) {
    ok("Node " + process.versions.node);
  } else {
    fail("Node " + process.versions.node + ` is too old for the built-in SQLite (need ${MIN_NODE_TEXT} or newer; Node 23.x has no FTS5 at any version).`, "Install Node 22.16+ or 24 LTS from nodejs.org, open a new terminal, and run this again.");
  }
  // Asked, not inferred: a distro or custom build can lack FTS5 at any version,
  // and every search needs it. This is the check that cannot be wrong.
  if (sqliteHasFts5()) {
    ok("SQLite has FTS5 (search works)");
  } else {
    fail("this copy of SQLite has no FTS5, so every search will fail.", "Install Node 22.16+ or 24 LTS from nodejs.org.");
  }

  const why =
    DATA_DIR_SOURCE === "env"
      ? "MONOMEM_HOME"
      : DATA_DIR_SOURCE === "checkout"
        ? "git checkout with an existing ./data/state.db — kept as-is; set MONOMEM_HOME to move it"
        : "default";
  ok(`data dir ${DATA_DIR} (${why})`);
  {
    const rawHome = (process.env.MONOMEM_HOME ?? process.env.ONEMEMORY_HOME ?? "").trim();
    if (rawHome && !/^~(?=$|[\\/])/.test(rawHome) && !(await import("node:path")).isAbsolute(rawHome))
      warn(`MONOMEM_HOME is a relative path (${rawHome}), so the data folder depends on where each app starts.`, "Set MONOMEM_HOME to a full path.");
  }
  let dataDirWritable = true;
  try {
    const { accessSync, constants: fsc } = await import("node:fs");
    accessSync(DATA_DIR, fsc.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      dataDirWritable = false;
      fail(`Monomem cannot write to its data folder (${DATA_DIR}).`, "This is a permissions problem. Make the folder writable for your user (or run Monomem as the user who owns it), or point MONOMEM_HOME at a folder you can write to.");
    }
  }
  // On Windows the token file and database get the folder's inherited permissions (chmod does nothing
  // there). Inside the user profile that means "this user only"; elsewhere (D:\, a shared folder) often not.
  // Changing ACLs automatically could break backup or indexing tools, so this says how instead of doing it.
  if (process.platform === "win32") {
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");
    const home = resolve(homedir()).toLowerCase();
    if (!resolve(DATA_DIR).toLowerCase().startsWith(home + "\\")) {
      warn(
        `data dir is outside your user folder, so other accounts on this PC may be able to read the token and notes. ` +
          `To limit it to you: icacls "${DATA_DIR}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`
      );
    }
  }
  const { MAPPED_LEGACY_ENV } = await import("./legacy-env.js");
  if (MAPPED_LEGACY_ENV.length) {
    warn(
      `old-style setting(s) ${MAPPED_LEGACY_ENV.join(", ")} (from claude-bridge) are being read as MONOMEM_*; they still work. ` +
        "Rename them to MONOMEM_* when convenient (`monomem setup` does this for an old claude-bridge entry)."
    );
  }
  if (insideNodeModules(DB_PATH) || insideNodeModules(DATA_DIR)) {
    warn(
      "your data is inside node_modules — npm update / npx cache cleanup will delete it. " +
        "Set MONOMEM_HOME (or MONOMEM_DB_PATH) to a directory outside the package."
    );
  }
  if (
    resolvePath(LEGACY_DATA_DIR) !== resolvePath(DATA_DIR) &&
    existsSync(`${LEGACY_DATA_DIR}/state.db`) &&
    !process.env.MONOMEM_DB_PATH
  ) {
    warn(`an old 1.0.x database is still at ${LEGACY_DATA_DIR} (migrated copy is in ${DATA_DIR}); delete it when you're happy`);
  }

  let dbProblem = false;
  let distrustCount = 0;
  let hasLabelled = false;
  let hasPrivate = false;
  try {
    const s = new Store(DB_PATH);
    // The same count `monomem health` shows: every namespace and every kind. list() counts only hand-written notes
    // (kind "note"), so a store full of captured observations and session summaries read as a handful of notes.
    const total = s.countAll();
    const damaged = s.integrityProblem();
    if (damaged) {
      s.close();
      throw new Error(damaged);
    }
    const edges = s.edgeCount();
    const sample = edges === 0 && total >= 2 ? s.list({ limit: 60 }).notes : [];
    hasLabelled = s.labelledAboveDefault() > 0;
    hasPrivate = s.hasPrivateNotes();
    distrustCount = s.distrustRules().length;
    const { meterStats, meterLine } = await import("./meter.js");
    const footprint = meterLine(meterStats(s));
    const ruleLines = s.confirmRuleLines();
    s.close();
    ok(`database OK at ${DB_PATH} (${total} notes)`);
    ok(footprint);
    // 1.4.0: one line per confirm rule, so "why isn't my note in session start?" has an answer here.
    for (const l of ruleLines) console.log("  [info] " + l);
    // Migration v4 adds the similarity-edge table but does not score
    // existing notes: a store upgraded from 1.0.0 has notes and no edges
    // until a one-time rebuild.
    // A new store of unrelated notes also has no edges, so warn only when two notes ARE similar enough
    // to have been linked. ponytail: looks at the 60 newest notes only; widen if old stores slip through.
    const { cosineSimilarity } = await import("./consolidate.js");
    const { EDGE_SIMILARITY_THRESHOLD } = await import("./store.js");
    const similarPair = sample.some((a, i) =>
      sample.slice(i + 1).some((b) => a.namespace === b.namespace && cosineSimilarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`) >= EDGE_SIMILARITY_THRESHOLD)
    );
    if (similarPair) {
      warn(
        "notes but no similarity edges (a store created before 1.1, or notes brought in with import or restore, which skip linking to stay fast)",
        "run `monomem rebuild-edges` once to link existing notes"
      );
    }
  } catch (e) {
    dbProblem = true;
    const d = (await import("./db-problem.js")).describeDbFailure(DB_PATH, e);
    fail(d.problem, d.fix);
  }

  await doctorSecurityChecks(DATA_DIR, BIND_HOST, warn);

  // Pre-upgrade copies (`<db>.pre-v*-backup`) hold the notes as they were before an upgrade, outside
  // retention, deletes and at-rest encryption. Say that they exist, how big and how old, and how to remove them.
  for (const b of Store.preMigrationBackups(DB_PATH)) {
    const mb = (b.bytes / 1e6).toFixed(1);
    if (/\.partial(-journal|-wal|-shm)?$/.test(b.path)) {
      warn(`unfinished pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old): a copy that was interrupted. It is safe to delete (monomem backup --prune-premigration).`);
      continue;
    }
    console.log(
      `  [info] pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old). It still holds notes you may since have deleted or encrypted. ` +
        "Keep it until you have checked the upgrade, then remove it: monomem backup --prune-premigration"
    );
  }
  try {
    const { peekSigningKey, attestKeyPath } = await import("./attest.js");
    const { dirname } = await import("node:path");
    const { statSync } = await import("node:fs");
    const kp = attestKeyPath(dirname(DB_PATH));
    if (peekSigningKey(dirname(DB_PATH))) {
      const mode = statSync(kp).mode & 0o077;
      if (process.platform !== "win32" && mode !== 0) warn(`${kp} is readable by other users (it is tightened to 0600 when the server starts)`);
      else ok(`attestation key present (${kp}); back it up with --include-attest-key if you rely on signed exports`);
    }
  } catch {
    /* no key yet */
  }

  if (distrustCount > 0) {
    // include_distrusted is an ADMIN switch, and the primary token is always admin: an agent wired with it can ask for the
    // notes the policy hides (e.g. after a hostile note talks it into it). Agents should hold a write or read token.
    try {
      const { resolveTokens } = await import("./config.js");
      const scoped = resolveTokens().filter((t) => t.scope !== "admin");
      if (scoped.length === 0) {
        warn(
          `${distrustCount} distrust rule(s) exist, but the only token is the primary one, which is always admin: an agent holding it can pass include_distrusted ` +
            "and read the hidden notes. Give agents a write or read token (MONOMEM_TOKENS / tokens.json, see docs/token-namespaces.md) and keep the primary token off them."
        );
      } else {
        ok(`${distrustCount} distrust rule(s); ${scoped.length} non-admin token(s) configured (keep the primary admin token off agents)`);
      }
    } catch {
      /* token configuration unreadable: reported below */
    }
  }
  try {
    resolveToken();
    ok(
      `bearer token present (${process.env.MONOMEM_TOKEN?.trim() ? "MONOMEM_TOKEN" : TOKEN_FILE})${keyJustCreated ? " - created just now, because this was the first run" : ""}`
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (!dataDirWritable || /EACCES|EPERM|EROFS|permission/i.test(msg)) {
      if (dataDirWritable) fail("token: " + msg, "This looks like a permissions problem with " + TOKEN_FILE + ". Make it readable and writable for your user.");
    } else {
      fail("token: " + msg, "Set MONOMEM_TOKEN to a long random value (monomem token new prints one), or delete the token file and let Monomem make one.");
    }
  }

  // tokens.json: a file that cannot be read means the apps listed in it do not work (and removing one by hand does nothing).
  try {
    const { existsSync: ex, readFileSync: rf } = await import("node:fs");
    const { join: j } = await import("node:path");
    const tf = j(DATA_DIR, "tokens.json");
    if (ex(tf)) {
      try {
        const parsed = JSON.parse(rf(tf, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("it should hold a list");
      } catch (e) {
        fail(`${tf} cannot be read (${(e as Error).message}), so the apps listed in it cannot connect, and a running server keeps its old list.`, `Open ${tf}, fix or delete it, then run monomem doctor again. (A backup of the previous version may be at ${tf}.bak.)`);
      }
    }
  } catch {
    /* nothing to check */
  }

  // Which apps may connect, and what each may see.
  try {
    const { resolveTokens } = await import("./config.js");
    const apps = resolveTokens().filter((t) => t.label !== "primary");
    const limited = apps.filter((t) => t.max_sensitivity !== undefined);
    ok(`${apps.length} app key(s) besides the main one; ${limited.length} with a limit on what they can see`);
    // An administrator key is trusted by definition, so it is not nagged. A normal key with no limit reads private notes.
    const open = apps.filter((t) => t.max_sensitivity === undefined && t.scope !== "admin");
    if (open.length > 0 && hasLabelled) {
      warn(
        `${open.map((t) => `"${t.label || "(unnamed)"}"`).join(", ")} can read your private notes (no limit is set on ${open.length === 1 ? "its key" : "their keys"}), and you have notes labelled other than internal.`,
        `give each a limit: monomem token remove <name>, then monomem token add <name> --max internal   (see docs/give-an-app-limited-access.md)`
      );
    }
    // Apps connected without a key (stdio) can read everything, whatever limits other apps have.
    if (hasPrivate) {
      const { detectClients, realEnv } = await import("./setup.js");
      const { readFileSync } = await import("node:fs");
      const { PACKAGE_VERSION } = await import("./config.js");
      const wired = detectClients(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url))).filter((c) => {
        try {
          if (!c.exists) return false;
          const t = readFileSync(c.file, "utf8");
          return /"monomem"|\[mcp_servers\.monomem\]/.test(t) && !/Authorization/i.test(t);
        } catch {
          return false;
        }
      });
      if (wired.length) {
        warn(
          `${wired.map((c) => c.label).join(", ")} ${wired.length === 1 ? "is" : "are"} connected without a key, so it can read your private notes (a limit only applies to apps that connect with their own key).`,
          `monomem connect ${wired[0].id} --max internal   (then restart that app). If that app is fine to see everything, ignore this.`
        );
      }
    }
  } catch {
    /* token configuration unreadable: reported above */
  }

  // Server-side namespace resolution (opt-in): validate the spaces config
  // and report this directory's resolved namespace.
  const {
    loadNamespaceConfig,
    namespaceConfigSource,
    validateSpacePaths,
    resolveNamespace,
  } = await import("./namespace.js");
  const nsSource = namespaceConfigSource();
  if (nsSource) {
    const nsWhere = nsSource === "env" ? "MONOMEM_SPACES" : `${DATA_DIR}/spaces.json`;
    const nsCfg = loadNamespaceConfig();
    if (!nsCfg) {
      warn(`namespace config present (${nsWhere}) but invalid -- resolution disabled`);
    } else {
      const n = Object.keys(nsCfg.spaces).length;
      const missing = validateSpacePaths(nsCfg);
      if (missing.length === 0) {
        ok(`namespace resolution: ${n} space(s) configured, all paths exist`);
      }
      for (const p of missing) {
        warn(
          `namespace space path missing on disk: ${p} — create the directory, ` +
            `or remove the space from ${nsWhere}`
        );
      }
      try {
        const here = resolveNamespace(process.cwd(), nsCfg);
        ok(`namespace resolution: this directory -> "${here}"`);
      } catch (e) {
        warn("namespace resolution: " + (e as Error).message);
      }
    }
  }

  // Recall hook smoke test: run the real SessionStart path against this
  // database and check the payload shape. Also budget-check it: the hook
  // blocks session start, so a slow recall is worth knowing about.
  try {
    const { runRecall } = await import("./recall.js");
    const t0 = Date.now();
    // The hook prints its own failure to stderr; doctor reports it in its own words below.
    const origErr = console.error;
    console.error = (): void => {};
    let out: string;
    try {
      out = await runRecall({ budgetMs: 800, limit: 1, dbPath: DB_PATH });
    } finally {
      console.error = origErr;
    }
    const elapsed = Date.now() - t0;
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string };
    };
    if (dbProblem) {
      // The hook fails silent by design, so its "success" proves nothing here.
      warn("recall hook smoke test FAILED: the database could not be opened (see the database problem above); the hook only looks healthy because it fails silent");
    } else if (parsed?.hookSpecificOutput?.hookEventName === "SessionStart") {
      ok(`recall hook smoke test passed (${elapsed}ms)`);
    } else {
      warn("recall hook returned an unexpected payload shape");
    }
    if (elapsed > 800) {
      warn(`recall hook took ${elapsed}ms — over the 800ms soft budget`);
    }
  } catch (e) {
    warn("recall hook smoke test failed: " + (e as Error).message);
  }

  // Is the hook actually wired into Claude Code? A working `recall` that never fires is the common silent failure.
  // Only worth saying when Claude Code is on this computer, and only a warning if the person has already chosen the hook.
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const { detectClients, realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    const cc = detectClients(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url))).find((c) => c.id === "claude-code");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let parsed: { hooks?: { SessionStart?: unknown } } = {};
    let haveSettings = true;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof parsed;
    } catch {
      haveSettings = false;
    }
    if (!cc?.present && !haveSettings) {
      console.log("  [info] Claude Code was not found on this computer, so the start-of-session hook was not checked (what it is: https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md)");
    } else {
      const entries = parsed?.hooks?.SessionStart;
      const wired =
        Array.isArray(entries) &&
        /(monomem|onememory|cli\.js)[\s\S]{0,60}\b(recall|hook session-start)\b/.test(JSON.stringify(entries));
      if (wired && /npx\s+(?:-y\s+)?onememory-mcp\b/.test(JSON.stringify(entries))) {
        warn("SessionStart hook is the old onememory-mcp one: old hook, run `monomem setup --hook` to update it");
      } else if (wired) {
        ok("SessionStart hook wired in ~/.claude/settings.json");
      } else {
        console.log(
          "  [info] Claude Code has no monomem start-of-session hook (optional: it shows Claude your recent notes when a session starts; add it with  monomem setup --hook, details: https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md)"
        );
      }
      const captureWired = /(monomem|onememory|cli\.js)[\s\S]{0,60}\bhook post-tool\b/.test(JSON.stringify(parsed?.hooks ?? {}));
      console.log(`  [info] ${captureWired ? "automatic memory hooks wired" : "automatic memory hooks not installed (monomem setup --capture)"}`);
    }
  } catch {
    /* settings could not be inspected: not a problem with Monomem */
  }

  // An app entry or hook that points at a removed install, or launches another version with npx.
  try {
    const { appEntryProblems, realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    for (const p of appEntryProblems(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)))) warn(p, "run monomem setup");
  } catch {
    /* configs could not be inspected: not a problem with Monomem */
  }

  // Automatic memory: when did a hook last record something, and is anything waiting in the spool?
  // Footprint: how big the data folder is, and is anything piling up (docs/footprint.md).
  try {
    const { Store } = await import("./store.js");
    const { lastCaptureAt, captureBacklog, spoolSize, captureSettings, SPOOL_MAX_BYTES } = await import("./capture.js");
    const { dirBytes, DIR_BYTES_BUDGET_MS } = await import("./uninstall.js");
    const { DATA_DIR } = await import("./config.js");
    const spool = spoolSize(DATA_DIR);
    const set = captureSettings(DATA_DIR);
    let last: string | null = null;
    let backlog = 0;
    if (!dbProblem) {
      const s = new Store(DB_PATH);
      try {
        last = lastCaptureAt(s);
        backlog = captureBacklog(s);
      } finally {
        s.close();
      }
    }
    console.log(`  [info] capture: ${set.enabled ? "on" : "off (MONOMEM_CAPTURE / capture.json)"}; last event ${last ?? "never"}; spool ${spool} bytes; ${backlog} event(s) not yet distilled`);
    if (spool >= SPOOL_MAX_BYTES) warn(`the capture spool is full (${spool} bytes): new events are dropped until a hook can open the database`);
    else if (spool > 0) warn(`${spool} bytes of captured events are waiting in the spool; the next hook that can open the database stores them`);
    if (backlog > DOCTOR_MAX_BACKLOG) {
      warn(`${backlog} captured events are waiting to be distilled (over ${DOCTOR_MAX_BACKLOG}); that happens when a session starts or ends, so a failing session hook is the likely cause`);
    }
    const size = dirBytes(DATA_DIR);
    const mb = (size.bytes / 1e6).toFixed(1);
    if (size.truncated) {
      warn(`data folder ${DATA_DIR} is at least ${mb} MB and still growing — the scan stopped after ${DIR_BYTES_BUDGET_MS}ms instead of hanging; something unrelated to monomem may be using this folder, see docs/footprint.md`);
    } else if (size.bytes > DOCTOR_MAX_DATA_BYTES) {
      warn(`data folder ${DATA_DIR} is ${mb} MB (over ${DOCTOR_MAX_DATA_BYTES / 1e9} GB); docs/footprint.md says what is in it and what is safe to remove`);
    } else {
      ok(`data folder ${DATA_DIR} is ${mb} MB`);
    }
  } catch (e) {
    warn("capture status unavailable: " + (e as Error).message);
  }

  console.log(`\n  bind ${BIND_HOST}   api :${API_PORT}   mcp :${MCP_HTTP_PORT}`);
  console.log(
    "\n" +
      (failures > 0
        ? `Verdict: PROBLEM - ${failures} thing(s) must be fixed${warnings ? `, ${warnings} more worth a look` : ""}. Read the [fail] and [warn] lines above.`
        : warnings > 0
          ? `Verdict: works, but ${warnings} thing(s) are worth a look (see the [warn] lines above).`
          : "Verdict: All good. Nothing needs fixing.")
  );
  if (failures > 0) process.exitCode = 1;
}


import { didYouMean } from "./suggest.js";
const CONNECT_APPS = ["claude-code", "claude-desktop", "cursor", "codex", "gemini", "muse", "vscode", "zed", "windsurf"] as const;
const APP_ALIASES: Record<string, string> = { claude: "claude-code", "claudecode": "claude-code", desktop: "claude-desktop", "claude desktop": "claude-desktop", code: "vscode", "vs-code": "vscode", "visual-studio-code": "vscode", gemini_cli: "gemini", "codex-cli": "codex" };

// `monomem connect <app> [--max level] [--restricted] [--print]`: wire one app, optionally with its own key and limit.
async function connectCmd(): Promise<void> {
  const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["max", "db", "name"], bools: ["restricted", "print", "dry-run", "yes"] });
  const raw = (rest[0] ?? "").toLowerCase();
  const app = APP_ALIASES[raw] ?? raw;
  if (!app) {
    console.error(`Say which app to connect, for example:  monomem connect claude-code\nApps I know: ${CONNECT_APPS.join(", ")}`);
    process.exit(1);
  }
  if (!(CONNECT_APPS as readonly string[]).includes(app)) {
    const guess = didYouMean(app, CONNECT_APPS);
    console.error(`I do not know an app called "${rest[0]}".${guess ? ` Did you mean "${guess}"?` : ""}\nApps I know: ${CONNECT_APPS.join(", ")}`);
    process.exit(1);
  }
  const restricted = flags.restricted === true || str(flags.max) !== undefined;
  const t = await import("./tokens-admin.js");
  if (!restricted && flags.print !== true) {
    if (app === "windsurf") {
      console.log("Windsurf: I cannot check where its settings file lives, so I will not guess. Open Windsurf's MCP settings and add this server:\n");
      const { buildServerEntry, realEnv } = await import("./setup.js");
      const { PACKAGE_VERSION, DATA_DIR, DATA_DIR_SOURCE } = await import("./config.js");
      const env = { MONOMEM_CLIENT: "windsurf", ...(DATA_DIR_SOURCE === "env" ? { MONOMEM_HOME: DATA_DIR } : {}) };
      console.log(JSON.stringify({ mcpServers: { monomem: buildServerEntry(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)), { command: "auto" }, env) } }, null, 2));
      return;
    }
    process.argv.splice(2, process.argv.length - 2, "setup", "--only", app, ...(flags["dry-run"] === true ? ["--dry-run"] : []), ...(flags.yes === true ? ["--yes"] : []), "--no-hook", "--no-capture", "--terse", "--no-test-note");
    await setupCmd();
    if (!process.exitCode && flags["dry-run"] === true) console.log(`\nDry run: run the same command without --dry-run to connect ${app}.`);
    else if (!process.exitCode) console.log(`\nConnected ${app}. This app can read every note, including private ones. To keep it away from private notes: monomem connect ${app} --restricted`);
    return;
  }
  // Restricted: the app gets its own key and a limit, over the HTTP server.
  const dry = flags["dry-run"] === true;
  const named = str(flags.name)?.trim();
  let label = named || app;
  if (named && t.listApps().some((a) => a.label.toLowerCase() === named.toLowerCase())) {
    console.error(`A key labelled "${named}" already exists. Pick another --name, or see them with: monomem token list`);
    process.exit(1);
  }
  for (let n = 2; t.listApps().some((a) => a.label.toLowerCase() === label.toLowerCase()); n++) label = `${app}-${n}`;
  let made: { app: ReturnType<typeof t.listApps>[number]; token: string; ceilingWasDefault: boolean } | undefined;
  try {
    // A dry run must not create anything: no key is made, a placeholder stands in for it.
    made = dry
      ? { app: { label, scope: "write", max_sensitivity: (str(flags.max) as never) ?? "internal", source: "tokens" } as never, token: "<a new key would be made here>", ceilingWasDefault: str(flags.max) === undefined }
      : t.addApp({ label, scope: "write", ...(str(flags.max) !== undefined ? { max: str(flags.max)! } : {}) });
  } catch (e) {
    if (e instanceof t.TokenAdminError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { API_PORT, MCP_HTTP_PORT, PACKAGE_VERSION } = await import("./config.js");
  const url = `http://127.0.0.1:${MCP_HTTP_PORT}/mcp`;
  void API_PORT;
  console.log(dry ? `[dry run] Would make a key for "${label}" and nothing has been created. ${t.describeAccess(made.app)}` : `Made a key for "${label}". ${t.describeAccess(made.app)}`);
  if (made.ceilingWasDefault) console.log("(Limit: internal, because you did not choose one. Change it with --max public|internal|private.)");
  if (flags.print === true || app === "windsurf" || app === "claude-desktop" || app === "codex" || app === "gemini" || app === "muse" || app === "zed") {
    console.log(`\nI am not writing this app's settings file for you (${flags.print === true ? "you asked for --print" : "its format for key-based connections is not one I can check"}). Paste this into its MCP settings:\n`);
    console.log(t.connectionSnippet(made.token));
    console.log(`\nStart the server when you use it:  monomem start`);
    return;
  }
  // Anything that goes wrong from here on removes the key again: no working key is left that nothing uses.
  let code = 1;
  try {
    const { runSetup, realEnv, DEFAULT_OPTIONS } = await import("./setup.js");
    const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
    code = await runSetup(e, terminalIO(), {
      ...DEFAULT_OPTIONS,
      yes: flags.yes === true,
      dryRun: dry,
      hook: "no",
      capture: "no",
      noTestNote: true,
      noDoctor: true,
      terse: true,
      only: [app],
      httpEntry: { url, headers: { Authorization: `Bearer ${made.token}` } },
    });
  } catch (e) {
    console.error(`Setting up ${app} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = code;
  if (code === 0) {
    if (!dry) console.log(`\nDone. ${app} now connects with its own key. Start the server so it has something to talk to:  monomem start\nTake access away any time:  monomem token remove "${label}"`);
  } else if (!dry) {
    t.removeApp(label);
    console.error(`Nothing was connected, so the key for "${label}" was removed again.`);
  }
}

// `monomem open`: start the server if it is not running, then open the dashboard already signed in.
async function openCmd(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(3), { values: [], bools: ["print"] });
  const { API_PORT, resolveToken } = await import("./config.js");
  const base = `http://127.0.0.1:${API_PORT}`;
  const up = async (): Promise<boolean> => {
    try {
      return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };
  if (!(await up()) && flags.print !== true) {
    console.log("Starting Monomem in the background...");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await up())) {
      console.error(`Monomem did not start. Run  monomem doctor  to see why, or start it yourself with  monomem start  and look at what it prints.`);
      process.exit(1);
    }
  }
  // The address carries a one-time code (good for 60 seconds), not the key: the key would end up in browser history and in
  // the list of running programs. The dashboard swaps the code for the key.
  const { mintLoginCode } = await import("./login-code.js");
  void resolveToken;
  const url = `${base}/#code=${mintLoginCode()}`;
  if (flags.print === true) {
    console.log(url);
    console.log("(This address works once, for 60 seconds.)");
    return;
  }
  const { spawn } = await import("node:child_process");
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/%/g, "%%").replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => console.log(`I could not open a browser. Open this address yourself:\n${url.replace(/#.*/, "")}  (then paste your key; run monomem doctor to see where it is kept)`)).unref();
    console.log(`Opened the dashboard: ${base}`);
  } catch {
    console.log(`Open this address in your browser: ${base}`);
  }
}

async function init(): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || process.argv.includes("--print")) {
    // Not at a keyboard (or --print): just show how to wire an app by hand.
    // `monomem mcp` (the installed bin), not an absolute path into the package: that path changes on every update.
    console.log("Wire monomem into your agent (local, over stdio):\n");
    console.log("Claude Code:");
    console.log("  claude mcp add monomem -- monomem mcp\n");
    console.log("Claude Desktop / Cursor — add to the MCP config:");
    console.log(JSON.stringify({ mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } }, null, 2));
    console.log("\nVS Code / Copilot (.vscode/mcp.json):");
    console.log(JSON.stringify({ servers: { monomem: { type: "stdio", command: "monomem", args: ["mcp"] } } }, null, 2));
    console.log("\nNot installed globally? Use npx instead: command \"npx\", args [\"-y\", \"monomem\", \"mcp\"].");
    console.log("Easier: run  monomem init  in a terminal and I will do it with you, or  monomem connect <app>.");
    console.log("See INSTALL.md for every client, and INFRA.md to reach your phone.");
    return;
  }
  const { detectClients, realEnv } = await import("./setup.js");
  const { PACKAGE_VERSION } = await import("./config.js");
  const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
  const here = detectClients(e).filter((c) => c.present && c.id !== "project");
  console.log("Welcome to Monomem. It gives your AI apps one shared memory that lives on this computer.\n");
  if (here.length === 0) {
    console.log("I did not find any supported app on this computer. That is fine:");
    console.log("  - Install one (for example Claude Code or Cursor) and run  monomem init  again, or");
    console.log("  - Run  monomem connect claude-code  (or another app name) to create its settings anyway.");
    console.log("  - Not sure what is wrong? Run  monomem doctor.");
    return;
  }
  console.log("Apps I found:");
  here.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
  const answer = (await terminalIO().ask("\nWhich ones should use Monomem? Type numbers separated by commas, or press Enter for all: ")).trim();
  let chosen = here;
  if (answer) {
    const picks = new Set(answer.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= here.length));
    if (picks.size === 0) {
      console.log("I did not understand that, so nothing was changed. Run  monomem init  again and type, for example,  1,2");
      return;
    }
    chosen = here.filter((_, i) => picks.has(i + 1));
  }
  const keep = (await terminalIO().ask("Should any of these apps be kept away from your private notes? (y/N) ")).trim().toLowerCase().startsWith("y");
  const restrictedIds = new Set<string>();
  if (keep) {
    const { HTTP_CAPABLE } = await import("./setup.js");
    const names = (await terminalIO().ask(`Which ones? Type numbers from the list above (${chosen.map((c) => here.indexOf(c) + 1).join(", ")}): `)).trim();
    for (const n of names.split(/[,\s]+/).map(Number)) {
      const c = here[n - 1];
      if (c && chosen.includes(c)) restrictedIds.add(c.id);
    }
    for (const id of restrictedIds) if (!HTTP_CAPABLE.includes(id)) console.log(`(${id}: I cannot write a limited connection into its settings automatically; I will show you what to paste instead.)`);
  }
  const self = process.argv[1];
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[]): number => spawnSync(process.execPath, [self, ...args], { stdio: "inherit" }).status ?? 1;
  for (const c of chosen) {
    console.log(`\n--- ${c.label} ---`);
    if (restrictedIds.has(c.id)) run(["connect", c.id, "--restricted", "--yes"]);
    else run(["connect", c.id, "--yes"]);
  }
  console.log("\nAll set.");
  console.log("  Try it:  in one app say \"remember that I like green tea\", then in another ask \"what do I like to drink?\"");
  console.log("  See it:  monomem open        (opens your notes in the browser)");
  console.log("  Undo it: monomem uninstall reverses every app; monomem setup --undo reverses only the last one");
}

async function reindex(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { embeddingsEnabled, embeddingsConfig, embed, noteEmbeddingText } = await import(
    "./embeddings.js"
  );

  if (!embeddingsEnabled()) {
    console.error(
      "Embeddings are off. Set MONOMEM_EMBEDDINGS=on (and, if needed, " +
        "MONOMEM_EMBED_URL / MONOMEM_EMBED_MODEL) before reindexing."
    );
    return;
  }

  const cfg = embeddingsConfig();
  const store = new Store(DB_PATH);
  // `reindex all` recomputes every note's vector -- use it after changing the
  // embedding model or its dimension. Plain `reindex` only fills missing ones.
  const all = process.argv[3] === "all";
  const ids = all
    ? store.exportAll().map((n) => n.id) // gate-ok: local shell command (reindex): the operator owns the database file
    : store.noteIdsMissingVectors();
  console.error(
    `monomem reindex${all ? " all" : ""}: ${ids.length} note(s) to embed (model ${cfg.model}).`
  );

  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const note = store.read(id); // gate-ok: local shell command (show): the operator owns the database file
    if (!note) continue;
    if (!mayEmbed(note)) continue; // private notes are not sent to the embeddings endpoint (MONOMEM_ALLOW_PRIVATE_REMOTE=1 allows it)
    const vec = await embed(noteEmbeddingText(note.title, note.body), cfg);
    if (vec) {
      store.setVector(id, vec, cfg.model);
      done += 1;
    } else {
      failed += 1;
    }
  }
  store.close();
  console.error(
    `Done. Embedded ${done}, failed ${failed}. Total vectors now: see 'doctor'.`
  );
}

async function recall(): Promise<void> {
  // Claude Code SessionStart hook. FAIL-SILENT by design: always prints a
  // valid hook JSON payload and exits 0, whatever happens -- including a
  // module-load failure (broken install), which degrades to the
  // empty-context payload instead of a crash.
  const emptyHookJson =
    '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}';
  const recallMod: typeof import("./recall.js") | undefined = await import(
    "./recall.js"
  ).catch((e: Error) => {
    console.error(
      `monomem recall: failed to load recall module (${e.message}); returning empty context`
    );
    return undefined;
  });
  if (!recallMod) {
    console.log(emptyHookJson);
    process.exit(0);
  }

  const args = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(name + "="));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  // A typo like --limt silently degrades the hook (the flag is ignored);
  // say so on stderr instead. Exit code stays 0 -- fail-silent by design.
  for (const a of args) {
    if (
      a.startsWith("-") &&
      !a.startsWith("--budget-ms") &&
      !a.startsWith("--limit") &&
      !a.startsWith("--db") &&
      !a.startsWith("--written-by") &&
      !a.startsWith("--not-written-by") &&
      a !== "--json" &&
      a !== "--text" &&
      a !== "--include-distrusted"
    ) {
      console.error(`monomem recall: unknown option "${a}" ignored`);
    }
  }
  const numFlag = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      // --budget-ms 0 (or garbage) used to silently become the default.
      console.error(
        `monomem recall: ignoring invalid ${name} "${raw}" (using ${fallback})`
      );
      return fallback;
    }
    return Math.floor(n);
  };
  const payload = await recallMod.runRecall({
    budgetMs: numFlag("--budget-ms", 800),
    limit: numFlag("--limit", 10),
    writtenBy: flag("--written-by"),
    notWrittenBy: flag("--not-written-by"),
    includeDistrusted: args.includes("--include-distrusted"),
    ...(flag("--db") ? { dbPath: flag("--db") } : {}),
  });
  // Run by hand at a keyboard (both ends a terminal, no --json), print what Claude would be shown, as text. The hook, which has
  // its output piped, gets exactly the JSON it always did.
  const byHand = !args.includes("--json") && ((process.stdin.isTTY && process.stdout.isTTY) || args.includes("--text"));
  if (byHand) {
    let text = "";
    try {
      text = (JSON.parse(payload) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    } catch {
      /* fall through to the raw payload */
    }
    console.log(text.trim() ? text : "Nothing to show yet: no notes match this folder. (Add one with: monomem add \"something worth remembering\")");
    process.exit(0);
  }
  console.log(payload);
  process.exit(0);
}

// The capture hooks: `monomem hook <event>` with the agent's hook JSON on stdin. FAIL-OPEN by design (see hook.ts):
// prints nothing or one valid hook JSON object, and exits 0 whatever happens, including a module that fails to load.
async function hookCmd(): Promise<void> {
  const event = process.argv[3] ?? "";
  let out = "";
  try {
    const { runHook, readStdin } = await import("./hook.js");
    const args = process.argv.slice(4);
    const i = args.indexOf("--db");
    out = await runHook(event, await readStdin(), i >= 0 && args[i + 1] ? { dbPath: args[i + 1] } : {});
  } catch (e) {
    console.error(`monomem hook: ${(e as Error).message}`);
    out = event === "session-start" ? '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}' : "";
  }
  if (out) process.stdout.write(out + "\n", () => process.exit(0));
  else process.exit(0);
}

// Find near-duplicate notes and merge them. Safe by default: without --yes
// (or with --dry-run) this only reports candidates and previews merges —
// nothing is written. Pass --yes to actually merge.
async function consolidate(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const {
    findCandidatesCooperative,
    consolidateNotes,
    buildConsolidationPreview,
    groupCandidateIds,
    clampThreshold,
    thresholdWasClamped,
    THRESHOLD_MIN,
    THRESHOLD_MAX,
  } = await import("./consolidate.js");
  const { maybeEmbed } = await import("./search-service.js");

  const args = process.argv.slice(3);
  let dryRun = false;
  let yes = false;
  let namespace: string | undefined;
  let thresholdRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--namespace" && i + 1 < args.length) namespace = args[++i];
    else if (a.startsWith("--namespace=")) namespace = a.slice("--namespace=".length);
    else if (a === "--threshold" && i + 1 < args.length) thresholdRaw = args[++i];
    else if (a.startsWith("--threshold=")) thresholdRaw = a.slice("--threshold=".length);
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }
  const rawThreshold =
    thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  const threshold = clampThreshold(rawThreshold, 0.95);
  if (thresholdWasClamped(rawThreshold)) {
    // Don't silently rewrite user input: say what happened.
    console.error(
      `Warning: --threshold "${thresholdRaw}" is outside ${THRESHOLD_MIN}..${THRESHOLD_MAX}; using ${threshold}`
    );
  }

  const store = new Store(DB_PATH);
  try {
    const notes = store
      .exportAll({ live: true }) // gate-ok: local shell command (lint scan): the operator owns the database file
      .filter((n) => !namespace || n.namespace === namespace);
    // Cooperative scan: yields to the event loop so a large sweep doesn't
    // stall; identical results to the sync version.
    const candidates = await findCandidatesCooperative(notes, { threshold });
    if (candidates.length === 0) {
      console.log("No duplicate candidates found.");
      return;
    }
    const byId = new Map(notes.map((n) => [n.id, n]));
    console.log(
      `Found ${candidates.length} duplicate candidate pair(s) (threshold ${threshold}):`
    );
    for (const c of candidates) {
      console.log(
        `  #${c.idA} "${byId.get(c.idA)?.title}" <-> #${c.idB} "${byId.get(c.idB)?.title}" ` +
          `(score ${c.score.toFixed(3)})`
      );
    }

    // Connected components: an A-B, B-C chain merges as one group so the
    // second pair never trips over the first pair's deleted note.
    const groups = groupCandidateIds(candidates);

    if (dryRun) {
      for (const g of groups) {
        const gnotes = g.map((id) => byId.get(id)!).filter(Boolean);
        const p = buildConsolidationPreview(gnotes);
        // The preview shows the FULL merged body: approving a destructive
        // merge from title/tag-count/body-length alone is approving blind.
        console.log(
          `\nWould merge [${g.join(", ")}] -> title "${p.title}" ` +
            `(${p.tags.length} tag(s), namespace "${p.namespace}")`
        );
        console.log("--- merged body ---");
        console.log(p.body);
        console.log("--- end merged body ---");
      }
      return;
    }
    if (!yes) {
      console.log("\nRe-run with --yes to merge these, or --dry-run for a merge preview.");
      return;
    }

    await gatePinned(store, groups.flat(), "merge (it deletes the source notes)");
    let mergedCount = 0;
    for (const g of groups) {
      try {
        const merged = consolidateNotes(store, g, { deleteSources: true });
        // Make the merged note visible to semantic search (consolidateNotes
        // itself doesn't embed; store.create is embedding-agnostic).
        await maybeEmbed(store, merged);
        console.log(`Merged [${g.join(", ")}] -> #${merged.id} "${printable(merged.title)}"`);
        mergedCount += 1;
      } catch (e) {
        console.error(`Skipped [${g.join(", ")}]: ${(e as Error).message}`);
      }
    }
    console.log(`Done: ${mergedCount} merge(s).`);
  } finally {
    store.close();
  }
}

// `monomem relevant "message" [--limit 5] [--namespace ns]`: keyword
// extraction + permissive search over the local store. Prints the keywords
// used (transparency) and the matching notes.
async function relevant(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { runRelevantSearch } = await import("./search-service.js");

  const args = process.argv.slice(3);
  let limit: number | undefined;
  let namespace: string | undefined;
  let writtenBy: string | undefined;
  let notWrittenBy: string | undefined;
  let includeDistrusted = false;
  let asOfRaw: string | undefined;
  let asJson = false;
  let modeRaw: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      console.log(
        [
          'monomem search|relevant "words" [options]     (search with no words lists your newest notes)',
          "  --limit n               how many to show (default 5; 20 when listing)",
          "  --namespace ns          only this namespace (--ns for short)",
          "  --as-of <ISO|7d|2h>     the notes as they were then",
          "  --written-by w | --not-written-by w   keep or drop one writer's notes",
          "  --include-distrusted    also show notes from writers you distrust (marked)",
          "  --mode keyword|semantic|hybrid   search only: semantic needs an embedding service (docs/search.md); without one you get keyword results and a note saying so",
          "  --json                  machine-readable output",
          "A search longer than 4096 characters or 64 words is refused.",
        ].join("\n")
      );
      return;
    }
    const valueFlag = /^--(mode|as-of|limit|namespace|ns|written-by|not-written-by)(=.*)?$/.exec(a);
    if (a === "--json") asJson = true;
    else if (a === "--include-distrusted") includeDistrusted = true;
    else if (valueFlag) {
      let v: string;
      if (valueFlag[2] !== undefined) v = valueFlag[2].slice(1);
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) v = args[++i];
      else {
        console.error(`--${valueFlag[1]} needs a value`);
        process.exit(1);
      }
      const k = valueFlag[1];
      if (k === "mode") modeRaw = v;
      else if (k === "as-of") asOfRaw = v;
      else if (k === "limit") limit = Number(v);
      else if (k === "namespace" || k === "ns") namespace = v;
      else if (k === "written-by") writtenBy = v;
      else notWrittenBy = v;
    }
    else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else parts.push(a);
  }
  const message = parts.join(" ");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error("--limit must be a whole number, 1 or more.");
    process.exit(1);
  }
  {
    const { queryTooLong } = await import("./store.js");
    const tooLong = queryTooLong(message);
    if (tooLong) {
      console.error(tooLong);
      process.exit(1);
    }
  }
  if (!message.trim() && !asOfRaw && process.argv[2] === "search") {
    // `search` with no words lists notes, as the help says.
    const rest = args.filter((a) => a !== "--json");
    await (await import("./everyday-cli.js")).lsCmd([...rest, ...(asJson ? ["--json"] : [])]);
    return;
  }
  if (!message.trim() && !asOfRaw) {
    console.error('Usage: monomem relevant "some natural language message" [--limit 5] [--namespace ns] [--as-of <ISO|7d|2h>] [--json]');
    process.exit(1);
  }
  if (asOfRaw) {
    if (writtenBy || notWrittenBy) {
      console.error("--as-of cannot be combined with --written-by / --not-written-by (who wrote a note at that time is not reconstructed).");
      process.exit(1);
    }
    const { parseAsOf, asOfView, asOfSearch, asOfHeader, asOfFields, localTimeOffset } = await import("./asof.js");
    let when: Date;
    try {
      when = parseAsOf(asOfRaw);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    const store = new Store(DB_PATH);
    try {
      const view = asOfView(store, when, { ...(namespace ? { namespace } : {}), ...(includeDistrusted ? { includeDistrusted: true } : {}) });
      const hits = asOfSearch(view, message, limit ?? (message.trim() ? 5 : 20));
      if (asJson) {
        console.log(
          JSON.stringify(
            { as_of: when.toISOString(), as_of_local: localTimeOffset(when), not_kept: view.notKept, archived_then: view.archivedThen, archive_log_since: view.archiveSince, results: hits.map((h) => asOfFields(h)) },
            null,
            2
          )
        );
        return;
      }
      console.log(asOfHeader(view));
      if (hits.length === 0) console.log(message.trim() ? "No matching notes at that time." : "No notes at that time.");
      for (const h of hits) {
        const edited = h.kept ? (h.editedSince ? " [edited since]" : "") : " [edited since; old text gone]";
        console.log(`  #${h.note.id} [${printable(h.note.namespace, 100)}] ${printable(h.note.title)}${edited}`);
        if (h.kept && h.note.body.trim()) console.log(`      ${printable(h.note.body.replace(/\s+/g, " ").trim(), 80)}`);
        console.log(`      writer then: ${h.writer ? `${printable(h.writer.by, 80)} (version ${h.writer.rev})` : "not recorded"}`);
      }
    } finally {
      store.close();
    }
    return;
  }
  const store = new Store(DB_PATH);
  try {
    const { annotateStaleness } = await import("./staleness.js");
    const { noteFlags } = await import("./taint.js");
    const { semanticNotice, runSearch } = await import("./search-service.js");
    if (modeRaw !== undefined && !["keyword", "semantic", "hybrid"].includes(modeRaw)) {
      console.error("--mode must be keyword, semantic or hybrid");
      process.exit(1);
    }
    const notice = semanticNotice(modeRaw);
    // One extra hit is fetched to tell whether the list was cut, so the output can say how to see more.
    const want = limit ?? 5;
    const moreLine = (shown: number, cut: boolean): void => {
      if (cut) console.log(`Showing ${shown}; more notes match. More: --limit ${Math.min(200, want * 2)}`);
    };
    if (modeRaw && process.argv[2] === "search" && message.trim()) {
      // `search --mode` is the full search (the one that can use embeddings); `relevant` stays the keyword-extraction search.
      const all = await runSearch(store, message, { namespace, limit: want + 1, mode: modeRaw as "keyword" | "semantic" | "hybrid", ...(writtenBy ? { writtenBy } : {}), ...(notWrittenBy ? { notWrittenBy } : {}), ...(includeDistrusted ? { includeDistrusted: true } : {}) });
      const hits = all.slice(0, want);
      if (asJson) return void console.log(JSON.stringify({ ...(notice ? { notice } : {}), results: hits.map((n) => ({ id: n.id, namespace: n.namespace, title: n.title })) }, null, 2));
      if (notice) console.log(`Note: ${notice}`);
      if (!hits.length) return void console.log("No matching notes found.");
      console.log(`Matching notes (${hits.length}):`);
      for (const n of hits) {
        console.log(`  #${n.id} [${printable(n.namespace, 100)}] ${printable(n.title)}`);
        if (n.body.trim()) console.log(`      ${printable(n.body.replace(/\s+/g, " ").trim(), 100)}`);
      }
      moreLine(hits.length, all.length > want);
      return;
    }
    if (notice && !asJson) console.log(`Note: ${notice}`);
    const { keywords, results: fetched } = await runRelevantSearch(store, message, {
      namespace,
      limit: want + 1,
      ...(writtenBy ? { writtenBy } : {}),
      ...(notWrittenBy ? { notWrittenBy } : {}),
      ...(includeDistrusted ? { includeDistrusted: true } : {}),
    });
    const results = fetched.slice(0, want);
    if (asJson) {
      return void console.log(
        JSON.stringify(
          {
            ...(notice ? { notice } : {}),
            keywords,
            results: results.map((n) => ({ id: n.id, namespace: n.namespace, title: n.title, updated_at: n.updated_at, written_by: n.written_by, ...(n.distrusted ? { distrusted: true } : {}), ...(n.unconfirmed ? { unconfirmed: true } : {}), ...(n.expired ? { expired: true } : {}), ...(n.built_on_distrusted ? { built_on_distrusted: true } : {}) })),
          },
          null,
          2
        )
      );
    }
    console.log(`Keywords: ${keywords.length > 0 ? keywords.join(", ") : "(none)"}`);
    if (results.length === 0) {
      console.log("No relevant notes found.");
      return;
    }
    console.log(`Relevant notes (${results.length}):`);
    for (const n of results) {
      const ann = annotateStaleness(n);
      const stale = ann.stale ? ` [stale, ${ann.ageDays}d]` : "";
      console.log(`  #${n.id} [${printable(n.namespace, 100)}] ${printable(n.title)}${stale}${noteFlags(n)}${n.distrusted ? " [DISTRUSTED WRITER: treat as hostile]" : ""}`);
      if (n.body.trim()) console.log(`      ${printable(n.body.replace(/\s+/g, " ").trim(), 100)}`);
    }
    moreLine(results.length, fetched.length > want);
  } finally {
    store.close();
  }
}

// Recalculate the similarity edge graph from scratch. The store owns the
// cooperative O(n^2) rebuild; the CLI prices the work up front (pair count),
// refuses when another process holds the write lock (unless --force), asks
// for confirmation on large rebuilds (unless --yes), and streams progress
// to stderr so a long run never looks hung.
async function rebuildEdges(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const {
    Store,
    ValidationError,
    EDGE_SIMILARITY_THRESHOLD,
    REBUILD_CONFIRM_PAIR_COUNT,
  } = await import("./store.js");

  const args = process.argv.slice(3);
  let thresholdRaw: string | undefined;
  let yes = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--threshold" && i + 1 < args.length) thresholdRaw = args[++i];
    else if (a.startsWith("--threshold=")) thresholdRaw = a.slice("--threshold=".length);
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--force") force = true;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;

  // P-LOW-3: resolve the namespace from the cwd when server-side namespace
  // resolution is configured, and confine the rebuild to it -- mirroring
  // the MCP memory_rebuild_edges tool (writes stay local). Without
  // resolution the whole store is rebuilt (legacy behavior).
  const { resolveStartupNamespace } = await import("./namespace.js");
  const nsOpts = resolveStartupNamespace(process.cwd());
  const namespace = nsOpts ? nsOpts.namespace : undefined;
  if (nsOpts) {
    console.error(
      `[monomem] namespace resolution ACTIVE: rebuilding namespace "${namespace}" only`
    );
  }

  const store = new Store(DB_PATH);
  try {
    // Never contend with a running server's writes: a second process
    // holding BEGIN IMMEDIATE used to starve the server (SQLITE_BUSY for
    // clients). Probe a few times to ride out transient writes; refuse if
    // the lock stays held. --force overrides for operators who know the
    // server is down.
    if (!force) {
      let busy = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (store.writeLockHeld()) {
          busy = true;
          await new Promise((r) => setTimeout(r, 250));
        } else {
          busy = false;
          break;
        }
      }
      if (busy) {
        console.error(
          "Refusing: another process holds the database write lock (is the server running?). " +
            "Re-run when it is idle, or pass --force if you are sure nothing is writing."
        );
        process.exit(1);
      }
    }

    const plan = store.rebuildPlan({ namespace });
    const notes = plan.reduce((s, g) => s + g.notes, 0);
    const pairs = plan.reduce((s, g) => s + g.pairs, 0);
    console.error(
      `Rebuilding similarity edges${namespace ? ` (namespace "${namespace}")` : ""}: ` +
        `${notes} notes, ~${pairs.toLocaleString("en-US")} pairs to score.`
    );
    if (pairs > REBUILD_CONFIRM_PAIR_COUNT && !yes) {
      if (!process.stdin.isTTY) {
        console.error(
          `Refusing: ~${pairs.toLocaleString("en-US")} pairs exceeds the ` +
            `${REBUILD_CONFIRM_PAIR_COUNT.toLocaleString("en-US")}-pair confirmation threshold ` +
            "and stdin is not interactive. Re-run with --yes to proceed non-interactively."
        );
        process.exit(1);
      }
      const ok = await askYesNo(
        `Score ~${pairs.toLocaleString("en-US")} pairs across ${notes} notes? [y/N] `
      );
      if (!ok) {
        console.error("Aborted.");
        process.exit(1);
      }
    }

    const t0 = Date.now();
    const { created, removed } = await store.rebuildEdgesCooperative({
      threshold,
      namespace,
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        process.stderr.write(
          `\rRebuilding edges: ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} pairs (${pct}%)`
        );
      },
    });
    process.stderr.write("\n");
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `Rebuilt similarity edges (threshold ${threshold ?? EDGE_SIMILARITY_THRESHOLD}): ` +
        `${created} created, ${removed} removed ` +
        `(${pairs.toLocaleString("en-US")} pairs scored in ${secs}s).`
    );
  } catch (e) {
    // A bad threshold is a usage error, not a crash: say so and exit 1.
    if (e instanceof ValidationError) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

/** Tiny flag parser: --name value / --name=value / boolean flags. */
function parseFlags(
  args: string[],
  spec: { values: string[]; bools: string[] }
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  // A value is never swallowed from a KNOWN following flag (`--label --any-server` is a missing value), but a value
  // that merely starts with "--" (a base64url key can) is still a value.
  const looksLikeFlag = (t: string): boolean => {
    if (!t.startsWith("--") || t.length <= 2) return false;
    const n = t.slice(2, t.indexOf("=") > 0 ? t.indexOf("=") : undefined);
    return spec.values.includes(n) || spec.bools.includes(n);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // everything after a bare -- is positional (a base64url key or a label may start with "-")
      rest.push(...args.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    let name = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    // --ns is short for --namespace wherever a command takes --namespace.
    if (name === "ns" && !spec.values.includes("ns") && spec.values.includes("namespace")) name = "namespace";
    if (name && spec.values.includes(name)) {
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) flags[name] = args[++i];
      else {
        console.error(`--${name} needs a value`);
        process.exit(1);
      }
    } else if (name && spec.bools.includes(name)) {
      flags[name] = true;
    } else if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else rest.push(a); // a base64url key id may start with a single "-"; that is a value, not an option
  }
  return { flags, rest };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// `monomem backup [--out dir]`: hot copy via VACUUM INTO (see backup.ts).
async function backupCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { backupStore } = await import("./backup.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["out"], bools: ["include-approval-key", "include-attest-key", "include-key", "prune-premigration"] });
  if (flags["prune-premigration"] === true) {
    // Remove the copies the upgrade made (`<db>.pre-v*-backup`): they hold the notes as they were before
    // the upgrade, including any deleted or forgotten since, and are outside encryption and retention.
    const { unlinkSync } = await import("node:fs");
    const found = Store.preMigrationBackups(DB_PATH);
    if (found.length === 0) {
      console.log("No pre-upgrade copies found next to the database.");
      return;
    }
    for (const f of found) {
      unlinkSync(f.path);
      console.log(`Removed ${f.path} (${f.bytes} bytes, ${f.age_days} day(s) old).`);
    }
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  // Default in the home folder, never the current one: run inside a repo, a backup (notes + key) there could get committed.
  // With MONOMEM_HOME set (a test or a second store) it goes next to that data folder instead, not into the real home.
  const { homedir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { DATA_DIR, DATA_DIR_SOURCE } = await import("./config.js");
  const out = str(flags.out) ?? join(DATA_DIR_SOURCE === "env" ? dirname(DATA_DIR) : homedir(), `monomem-backup-${stamp}`);
  const store = new Store(DB_PATH);
  try {
    const r = backupStore(store, DB_PATH, out, {
      includeApprovalKey: flags["include-approval-key"] === true,
      includeAttestKey: flags["include-attest-key"] === true,
      includeKey: flags["include-key"] === true,
    });
    console.log(`Backed up ${r.notes} note(s) (${r.bytes} bytes) to ${r.db}`);
    console.log(
      r.approvalKey
        ? "Included the command-task approval key (--include-approval-key): guard this backup like the encryption key."
        : "The command-task approval key was NOT copied: after a restore, existing approvals read as stale (fail closed) and an admin re-approves queued command tasks."
    );
    if (r.attestKey) {
      console.log(`Included the attestation signing key (--include-attest-key): guard this backup like the encryption key.`);
    } else if (r.attestKeyLeftOut) {
      console.log(
        "The attestation signing key (.attest-key) was NOT copied: a restore keeps the server_id but creates a NEW signing key, so peers that\n" +
          "trusted the old one must be told the new key. Use --include-attest-key to keep the identity."
      );
    }
    if (r.key) {
      console.log(`Copied the encryption key to ${r.key} (mode 0600) because you asked for --include-key.`);
      console.log(
        "WARNING: this backup is only readable with that key, and anyone holding both can read everything.\n" +
          "         Move the key out of this folder and store it separately (password manager / another drive)."
      );
    } else if (r.keyLeftOut) {
      console.log(`Your notes are encrypted. The key was NOT put in this backup folder (on purpose): it is at ${r.keyLeftOut}.`);
      console.log("Keep a copy of that key somewhere else (a password manager or another drive); without it this backup cannot be read.");
      console.log("To put the key in the backup folder anyway: monomem backup --include-key");
    }
  } catch (e) {
    console.error(`Backup failed: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    store.close();
  }
}

// `monomem runner-status [--namespace ns] [--json]`
async function runnerStatusCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { runnerStatus, ago } = await import("./liveness.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["json"] });
  const store = new Store(DB_PATH);
  try {
    const ns = str(flags.namespace);
    const st = runnerStatus(store, ns ? [ns] : undefined);
    if (flags.json) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const r = st.runner;
    console.log(
      r.state === "never_seen"
        ? "Runner: no heartbeat seen"
        : `Runner: ${r.state} (last heartbeat ${ago(r.age_seconds ?? 0)} ago; counted offline after ${ago(r.stale_after_seconds)})`
    );
    const more = st.truncated ? "at least " : "";
    console.log(`Commands waiting: ${more}${st.waiting_total} (${st.expiring_soon_total} expiring within 1 h), expired approvals: ${more}${st.expired_total}`);
    for (const t of st.targets) {
      console.log(
        `  runner "${t.target}": ${t.state}` +
          (t.age_seconds !== null ? ` (last heartbeat ${ago(t.age_seconds)} ago)` : "") +
          `, waiting ${t.waiting}, expiring soon ${t.expiring_soon}, expired ${t.expired}` +
          (t.oldest_waiting_seconds !== null ? `, oldest waited ${ago(t.oldest_waiting_seconds)} (task #${t.oldest_waiting_task_id})` : "")
      );
    }
    for (const n of st.namespaces) {
      console.log(
        `  [${printable(n.namespace, 100)}] waiting ${n.waiting}, expiring soon ${n.expiring_soon}, expired ${n.expired}` +
          (n.oldest_waiting_seconds !== null ? `, oldest waited ${ago(n.oldest_waiting_seconds)} (task #${n.oldest_waiting_task_id})` : "")
      );
    }
    if (st.notice) console.log(st.notice);
  } finally {
    store.close();
  }
}

// `monomem watch [--consumer c] [--wait 25] [--namespace ns] [--exec prog args...]`
async function watchCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { watchLoop } = await import("./watch.js");
  const argv = process.argv.slice(3);
  // Everything after --exec is the program and its arguments, verbatim.
  const at = argv.indexOf("--exec");
  const exec = at >= 0 ? argv.slice(at + 1) : undefined;
  if (at >= 0 && (!exec || exec.length === 0)) {
    console.error("--exec needs a program, e.g. --exec notify-send Monomem");
    process.exit(1);
  }
  const { flags } = parseFlags(at >= 0 ? argv.slice(0, at) : argv, { values: ["consumer", "wait", "namespace", "written-by", "not-written-by"], bools: ["include-distrusted"] });
  const wait = str(flags.wait) !== undefined ? Number(flags.wait) : 25;
  if (!Number.isInteger(wait) || wait < 1 || wait > 55) {
    console.error("--wait must be a whole number of seconds from 1 to 55 (25 recommended)");
    process.exit(1);
  }
  const abort = new AbortController();
  // First signal: stop cleanly (kill the running handler, finish). A second one exits at once.
  const onSignal = (sig: NodeJS.Signals): void => {
    if (abort.signal.aborted) process.exit(sig === "SIGINT" ? 130 : 143);
    abort.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  const store = new Store(DB_PATH);
  try {
    console.error(`watching as "${str(flags.consumer) ?? "watch"}" (Ctrl+C to stop)`);
    await watchLoop(store, {
      consumer: str(flags.consumer) ?? "watch",
      waitSeconds: wait,
      namespaces: str(flags.namespace) ? [str(flags.namespace)!] : undefined,
      filter: {
        ...(str(flags["written-by"]) ? { writtenBy: str(flags["written-by"])! } : {}),
        ...(str(flags["not-written-by"]) ? { notWrittenBy: str(flags["not-written-by"])! } : {}),
        ...(flags["include-distrusted"] ? { includeDistrusted: true } : {}),
      },
      exec,
      signal: abort.signal,
    });
  } finally {
    store.close();
  }
}

// `monomem never-show <id> [--undo]`: keep a note out of the session-start context for good (it stays searchable).
async function neverShowCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { setNeverShow } = await import("./context-inject.js");
  const args = process.argv.slice(3);
  const id = Number(args.find((a) => !a.startsWith("-")));
  if (!Number.isInteger(id) || id < 1) {
    console.error("usage: monomem never-show <note id> [--undo]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const n = setNeverShow(store, id, !args.includes("--undo"));
    if (!n) {
      console.error(`no note with id ${id}`);
      process.exit(1);
    }
    console.log(args.includes("--undo") ? `#${id} can be shown at session start again` : `#${id} will not be shown at session start again (undo: monomem never-show ${id} --undo)`);
  } finally {
    store.close();
  }
}

// `--max-sensitivity <level>`: a label, or stop (a typo must not export everything).
function parseMaxSensitivityFlag(raw: string): Sensitivity {
  const v = parseSensitivity(raw);
  if (!v) {
    console.error(`--max-sensitivity must be ${SENSITIVITY_HELP} (got ${JSON.stringify(raw)}); nothing was exported`);
    process.exit(1);
  }
  return v;
}

// `monomem label <id> [level]`: show or set one note's sensitivity label (full local trust, like every CLI command).
async function labelCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const args = process.argv.slice(3).filter((a) => !a.startsWith("-"));
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1 || args.length > 2) {
    console.error(`usage: monomem label <note id> [${SENSITIVITY_LEVELS.join("|")}]`);
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const n = store.readVisible(id, { includeDistrusted: true }); // local CLI, full trust
    if (!n) {
      console.error(`no note with id ${id}`);
      process.exit(1);
    }
    if (args[1] === undefined) {
      console.log(`#${id} is ${n.sensitivity ?? DEFAULT_SENSITIVITY}`);
      return;
    }
    try {
      const next = store.update(id, { sensitivity: args[1] }, { keepWriter: true });
      console.log(`#${id} is now ${next?.sensitivity ?? DEFAULT_SENSITIVITY}`);
      if (next?.sensitivity === "private") {
        console.log("Limited apps cannot see this; apps with no limit (including your main Claude connection) still can.");
        console.log("Next step: monomem connect <app> --max internal   (for the session hook: set MONOMEM_RECALL_MAX_SENSITIVITY=internal)");
      }
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      console.error(e.message);
      process.exit(1);
    }
  } finally {
    store.close();
  }
}

// `monomem changes`: the change feed over the local store (full local
// trust, like every CLI command). Prints every page.
async function changes(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { runChanges } = await import("./changes.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["since", "consumer", "namespace", "source", "limit", "written-by", "not-written-by", "note-written-by", "not-note-written-by"],
    bools: ["json", "purge", "include-distrusted"],
  });
  const store = new Store(DB_PATH);
  try {
    if (flags.purge) {
      const n = store.purgeChangeLogAll();
      console.log(`Purged ${n} change-log row(s) and every "last" marker.`);
      return;
    }
    const base = {
      namespaces: str(flags.namespace) ? [str(flags.namespace)!] : undefined,
      source: str(flags.source),
      limit: str(flags.limit) ? Number(flags.limit) : undefined,
      ...(str(flags["written-by"]) ? { writtenBy: str(flags["written-by"])! } : {}),
      ...(str(flags["not-written-by"]) ? { notWrittenBy: str(flags["not-written-by"])! } : {}),
      ...(str(flags["note-written-by"]) ? { noteWrittenBy: str(flags["note-written-by"])! } : {}),
      ...(str(flags["not-note-written-by"]) ? { notNoteWrittenBy: str(flags["not-note-written-by"])! } : {}),
      ...(flags["include-distrusted"] ? { includeDistrusted: true } : {}),
    };
    let page = runChanges(store, {
      ...base,
      since: str(flags.since) ?? "24h",
      consumer: str(flags.consumer),
    });
    if (flags.json) {
      const all = [...page.changes];
      while (page.nextCursor) {
        page = runChanges(store, { ...base, cursor: page.nextCursor });
        all.push(...page.changes);
      }
      console.log(JSON.stringify({ ...page, changes: all, nextCursor: null }, null, 2));
      return;
    }
    const c = page.counts;
    console.log(
      `Changes ${page.since} -> ${page.until}: ${c.created} created, ${c.updated} updated, ${c.deleted} deleted` +
        (page.quarantined ? `, ${page.quarantined} quarantined` : "")
    );
    for (const [src, n] of Object.entries(page.bySource)) {
      console.log(`  ${src || "(no source)"}: +${n.created} ~${n.updated} -${n.deleted}`);
    }
    // One page only (--limit entries, default 100): a long window is summed up above, not printed in full.
    // Except --since last: its marker moves only when the final page is read, so every page is printed.
    const isLast = (str(flags.since) ?? "").trim().toLowerCase() === "last";
    for (;;) {
      for (const e of page.changes) {
        const mark = e.kind === "created" ? "+" : e.kind === "updated" ? "~" : "-";
        console.log(`${mark} #${e.id} [${printable(e.namespace, 100)}] ${printable(e.title)}  (${e.at}${e.source ? `, ${printable(e.source)}` : ""})${e.distrusted ? " [DISTRUSTED WRITER]" : ""}`);
      }
      if (!page.nextCursor) break;
      if (!isLast) {
        console.log(`... ${Math.max(0, c.total - page.changes.length)} more (use --json or a narrower --since)`);
        break;
      }
      page = runChanges(store, { ...base, cursor: page.nextCursor });
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem export --format md --dir <path>` / `--format json [--out f]`.
async function exportCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["format", "dir", "namespace", "out", "max-sensitivity"],
    // --no-attest is accepted and does nothing: attestations are opt-in (--attest) since 1.4.1.
    bools: ["no-prune", "force", "attest", "no-attest", "include-distrusted", "no-history"],
  });
  const format = str(flags.format) ?? (str(flags.dir) ? "md" : undefined);
  // The ceiling for this export: the flag, else MONOMEM_EXPORT_MAX_SENSITIVITY. Either one wrong stops the export.
  let exportCeiling: Sensitivity | undefined;
  if (str(flags["max-sensitivity"]) !== undefined) exportCeiling = parseMaxSensitivityFlag(str(flags["max-sensitivity"])!);
  else if ((process.env.MONOMEM_EXPORT_MAX_SENSITIVITY ?? "").trim()) {
    const v = parseSensitivity(process.env.MONOMEM_EXPORT_MAX_SENSITIVITY!);
    if (!v) {
      console.error(`MONOMEM_EXPORT_MAX_SENSITIVITY must be ${SENSITIVITY_HELP} (got ${JSON.stringify(process.env.MONOMEM_EXPORT_MAX_SENSITIVITY)}); nothing was exported`);
      process.exit(1);
    }
    exportCeiling = v;
  }
  const { EXPORT_PAGE_SIZE } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    if (format === "json") {
      const ns = str(flags.namespace);
      // STREAMED export: the old path called exportAll() then JSON.stringify
      // on the whole array, holding every row + record + the finished string
      // in memory at once (~3x the backup). With months of notes that spikes
      // hard on a small box. exportBatch pages by primary key so peak memory
      // is one page. The output is still valid {"notes":[...]} JSON, only
      // pretty-printed with one note per line so diffs stay readable.
      const { createWriteStream, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { chmodQuiet } = await import("./config.js");

      const outPath = str(flags.out);
      let out: NodeJS.WritableStream;
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        out = createWriteStream(outPath, { mode: 0o600 });
      } else {
        out = process.stdout;
      }
      const write = (s: string): Promise<void> =>
        out.write(s) ? Promise.resolve() : new Promise((r) => out.once("drain", r));

      // Attestations are OPT-IN (--attest): without it the file is byte-compatible with
      // every release before 1.4.0, `{"notes": [...]}`. With it, an `export` header
      // (this server and its public key) and a signed attestation per note (see
      // attest.ts). If the signing key cannot be created the backup is still
      // written, without them: a backup must not fail over a signature.
      let attest = flags.attest === true;
      let header = "";
      if (attest) {
        try {
          header = `  "export": ${JSON.stringify(store.exportHeader())},\n`;
        } catch (e) {
          attest = false;
          console.error(`Exporting without attestations: ${(e as Error).message}`);
        }
      }
      await write(`{\n${header}  "notes": [\n`);
      let afterId = 0;
      let first = true;
      let count = 0;
      for (;;) {
        const page = actorStore.run({ label: "cli-export", authed: true, ...(exportCeiling ? { maxSensitivity: exportCeiling } : {}) }, () =>
          store.exportBatch(afterId, EXPORT_PAGE_SIZE, { attest, history: flags["no-history"] !== true }) // gate-ok: local shell command (export): the operator owns the database file
        );
        if (page.length === 0) break;
        afterId = page[page.length - 1].id;
        for (const note of page) {
          if (ns && note.namespace !== ns) continue;
          await write((first ? "" : ",\n") + "    " + JSON.stringify(note));
          first = false;
          count++;
        }
        if (page.length < EXPORT_PAGE_SIZE) break;
      }
      await write("\n  ]\n}\n");
      if (outPath && "end" in out) {
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve());
          out.on("error", reject);
        });
        chmodQuiet(outPath, 0o600); // mode only applies on create
        console.error(`Exported ${count} note(s) to ${outPath}`);
      }
      (await import("./security.js")).audit({ op: "export", label: "cli", kind: "export", detail: `json notes=${count}${attest ? " attest" : ""}${ns ? " namespace" : ""}${outPath ? " file" : " stdout"}` });
      return;
    }
    if (format !== "md" || !str(flags.dir)) {
      console.error("Usage: monomem export --format md --dir <path> [--namespace ns] [--no-prune] [--force] [--include-distrusted] [--max-sensitivity public|internal|private]");
      console.error("       monomem export --format json [--out file] [--attest]");
      process.exit(1);
    }
    const { exportMarkdown } = await import("./sync.js");
    const r = exportMarkdown(store, str(flags.dir)!, {
      namespace: str(flags.namespace),
      prune: !flags["no-prune"],
      force: flags.force === true,
      includeDistrusted: flags["include-distrusted"] === true,
      ...(str(flags["max-sensitivity"]) !== undefined ? { maxSensitivity: parseMaxSensitivityFlag(str(flags["max-sensitivity"])!) } : {}),
    });
    console.log(
      `Exported ${r.notes} note(s) to ${r.dir}: ${r.written} written, ${r.unchanged} unchanged, ${r.removed} removed.`
    );
    (await import("./security.js")).audit({ op: "export", label: "cli", kind: "export", detail: `md notes=${r.notes}${flags.force === true ? " force" : ""}${str(flags.namespace) ? " namespace" : ""}` });
    for (const s of r.skipped ?? []) console.error(`skipped     ${s.file} — ${s.detail}`);
    if (r.skipped?.length) {
      console.error(
        `${r.skipped.length} file(s) were edited outside Monomem since the last sync and were NOT overwritten. ` +
          "Run `monomem import` first, or re-run export with --force (the edited files are saved to .conflicts/)."
      );
    }
  } finally {
    store.close();
  }
}

// `monomem import --dir <path> [--dry-run]`: merge Markdown files back.
async function importCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { importMarkdown } = await import("./sync.js");
  const { flags, rest: importRest } = parseFlags(process.argv.slice(3), {
    values: ["dir", "file", "project", "namespace", "from", "path"],
    bools: ["dry-run", "json", "allow-move", "dedupe", "no-dedupe", "require-attestation", "claude", "rules", "yes", "update", "include-index"],
  });
  if (str(flags.from)) {
    const { runForeignImport, FOREIGN_SOURCES } = await import("./foreign-import.js");
    const from = str(flags.from) as (typeof FOREIGN_SOURCES)[number];
    if (!FOREIGN_SOURCES.includes(from)) {
      console.error(`Usage: monomem import --from ${FOREIGN_SOURCES.join("|")} [--path p] [--dry-run] [--yes] [--namespace ns]`);
      process.exit(1);
    }
    const { realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    process.exitCode = await runForeignImport(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)), terminalIO(), {
      from,
      path: str(flags.path),
      dryRun: flags["dry-run"] === true,
      yes: flags.yes === true,
      namespace: str(flags.namespace),
      dbPath: DB_PATH,
    });
    return;
  }
  if (flags.rules === true) {
    if (importRest.length) {
      console.error(`import --rules wants a project FOLDER, not a file ("${importRest[0]}"). Use:  monomem import --rules --project <folder>   (it finds .cursorrules, AGENTS.md and the others inside it)`);
      process.exitCode = 1;
      return;
    }
    const { runRulesImport } = await import("./rules-import.js");
    const projects = (str(flags.project) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    process.exitCode = await runRulesImport({ projects: projects.length ? projects : [process.cwd()], dryRun: flags["dry-run"] === true, namespace: str(flags.namespace), dbPath: DB_PATH });
    return;
  }
  if (flags.claude === true) {
    const { runClaudeImport } = await import("./claude-import.js");
    const { realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
    process.exitCode = await runClaudeImport(e, terminalIO(), {
      dryRun: flags["dry-run"] === true,
      yes: flags.yes === true,
      update: flags.update === true,
      projects: (str(flags.project) ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      namespace: str(flags.namespace),
      includeIndex: flags["include-index"] === true,
      dbPath: DB_PATH,
    });
    return;
  }
  if (str(flags.file)) {
    // Duplicate protection is ON unless --no-dedupe. It used to be `flags["dedupe"] === true`,
    // which passed an explicit `dedupe: false` whenever the flag was absent and so beat the
    // store default -- `monomem import` twice still doubled every note.
    await importJsonFile(str(flags.file)!, flags["no-dedupe"] !== true, flags.json === true, flags["require-attestation"] === true);
    return;
  }
  if (!str(flags.dir)) {
    console.error("Usage: monomem import --dir <path> [--dry-run] [--allow-move]");
    console.error("       monomem import --file backup.json [--no-dedupe] [--json] [--require-attestation]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const r = await importMarkdown(store, str(flags.dir)!, { dryRun: flags["dry-run"] === true, allowMove: flags["allow-move"] === true });
    if (r.counts.rejected > 0) process.exitCode = 1;
    if (flags.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    for (const e of r.entries) {
      if (e.action === "unchanged") continue;
      console.log(`${e.action.padEnd(11)} ${e.file}${e.id ? ` (#${e.id})` : ""}${e.detail ? ` — ${e.detail}` : ""}`);
    }
    const c = r.counts;
    console.log(
      `${flags["dry-run"] ? "[dry run] " : ""}Imported from ${r.dir}: ${c.created} created, ${c.updated} updated, ` +
        `${c.restored} restored, ${c.unchanged} unchanged, ${c.skipped} skipped, ${c.conflict} conflict(s), ` +
        `${c.quarantined} quarantined, ${c.rejected} rejected.`
    );
    if (r.foreignHeld > 0) console.log(`${r.foreignHeld} note(s) from other machines held for review (monomem quarantine list).`);
    if (c.rejected > 0) {
      console.error(
        `\n!!! ${c.rejected} FILE(S) WERE REJECTED AND NOT IMPORTED (see the "rejected" lines above). ` +
          `Nothing was dropped silently; fix those files and import again. Exit status 1.`
      );
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem import --file backup.json`: restore a JSON backup (the shape of
// `export --format json` / GET /export). Attestations in it are checked
// against the trusted attesters; see docs/trust.md.
async function importJsonFile(file: string, dedupe: boolean, json: boolean, requireAttestation = false): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError, attestationsToShow } = await import("./store.js");
  const { printable } = await import("./security.js");
  const { streamBackupNotes, StreamJsonError, checkBackupNote } = await import("./stream-json.js");
  const { statSync } = await import("node:fs");
  try {
    statSync(file);
  } catch (e) {
    console.error(`Cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  // PASS 1, before anything is written (or the database is even opened): stream the WHOLE file and check its structure and
  // the shape of every note (valid JSON to the end, depth, element size, text fields, tag lists). A truncated, corrupt or
  // hostile file therefore imports NOTHING, and says so. Memory stays flat: one note at a time.
  let elements = 0;
  let notObjects = 0;
  const scalarStats = { scalars: 0 };
  try {
    for await (const note of streamBackupNotes(file, scalarStats)) {
      const bad = checkBackupNote(note);
      if (bad === "skip") {
        notObjects++;
        continue;
      }
      elements++;
      if (bad) throw new StreamJsonError(`note #${elements}: ${bad}`);
    }
  } catch (e) {
    if (e instanceof StreamJsonError) {
      console.error(`Cannot import ${file}: ${e.message}. Nothing was imported: the whole file is checked before anything is written.`);
      process.exit(1);
    }
    throw e;
  }
  notObjects += scalarStats.scalars;
  const store = new Store(DB_PATH);
  // The file is STREAMED: notes are read, parsed and written IMPORT_FILE_BATCH at a time, so memory stays flat
  // however big the backup is (both shapes: {"notes":[...]} with or without the `export` header, and a bare [...]).
  const IMPORT_FILE_BATCH = 500;
  const total: import("./store.js").ImportReport = { quarantined: [], rejected: [] };
  const att = { verified: 0, unverified: 0, reasons: {} as Record<string, number>, untrusted_keys: new Map<string, { key_id: string; server_id: string; notes: number }>() };
  let imported = 0;
  let skipped = 0;
  let pinnedInFile = 0; // an export carries `pinned: true` for reference; import never pins
  let batch: import("./store.js").ImportNote[] = [];
  let batchWeight = 0;
  let handled = 0; // elements that went through importNotes (imported, skipped or rejected)
  // A batch is also bounded by size, not only by count: 500 notes of several MB each would otherwise sit in memory at once.
  const IMPORT_FILE_BATCH_CHARS = 32_000_000;
  const weigh = (n: import("./store.js").ImportNote): number =>
    (typeof n.title === "string" ? n.title.length : 0) + (typeof n.body === "string" ? n.body.length : 0) + (Array.isArray(n.tags) ? n.tags.reduce((a, t) => a + String(t).length + 4, 0) : 0) + 400;
  let batches = 0;
  let deferred = false;
  const flush = async (last: boolean): Promise<void> => {
    if (batch.length === 0) return;
    // A restore that fits in one batch links its notes inline (the graph is complete at once); a bigger one defers the
    // O(n^2) similarity linking, like the HTTP import does, and tells the operator to run `rebuild-edges`.
    const defer = !(last && batches === 0);
    if (defer) deferred = true;
    const report: import("./store.js").ImportReport = { quarantined: [], rejected: [] };
    const created = await store.importNotes(batch, { report, dedupe, deferEdges: defer, ...(requireAttestation ? { requireAttestation: true } : {}) });
    batches++;
    handled += batch.length;
    batch = [];
    batchWeight = 0;
    imported += created.length;
    skipped += report.skipped ?? 0;
    total.quarantined.push(...report.quarantined);
    total.rejected.push(...report.rejected);
    const a = report.attestations;
    if (a) {
      att.verified += a.verified;
      att.unverified += a.unverified;
      for (const [k, v] of Object.entries(a.reasons)) att.reasons[k] = (att.reasons[k] ?? 0) + v;
      for (const u of a.untrusted_keys) {
        const k = `${u.key_id}|${u.server_id}`;
        const seen = att.untrusted_keys.get(k);
        if (seen) seen.notes += u.notes;
        else att.untrusted_keys.set(k, { ...u });
      }
    }
  };
  try {
    try {
      for await (const note of streamBackupNotes(file)) {
        if (checkBackupNote(note) === "skip") continue;
        if ((note as { pinned?: unknown }).pinned === true) pinnedInFile++;
        batch.push(note as import("./store.js").ImportNote);
        batchWeight += weigh(note as import("./store.js").ImportNote);
        if (batch.length >= IMPORT_FILE_BATCH || batchWeight >= IMPORT_FILE_BATCH_CHARS) await flush(false);
      }
      await flush(true);
    } catch (e) {
      // The file passed the whole-file check, so this is a fault while writing (the disk, a lock) or a file that changed
      // since. Batches written earlier stay written: say exactly how far it got and how to continue safely.
      const msg = e instanceof Error ? e.message : String(e);
      const left = Math.max(0, elements - handled);
      console.error(
        `Import stopped: ${msg}\n` +
          `${imported} note(s) were imported before the error, ${left} were not. ` +
          (imported + (skipped || 0) > 0 || handled > 0
            ? "Nothing is rolled back. Fix the cause and run the SAME command again: notes already imported are skipped (recognised by title, body and created_at, which every export carries) rather than duplicated."
            : "Nothing was written.") +
          (deferred ? " Run `monomem rebuild-edges` afterwards." : "")
      );
      process.exit(1);
    }
    total.attestations = { verified: att.verified, unverified: att.unverified, reasons: att.reasons, untrusted_keys: [...att.untrusted_keys.values()] };
    if (skipped) total.skipped = skipped;
    if (json) {
      console.log(JSON.stringify({ imported, ...total, ...(notObjects ? { ignored_entries: notObjects } : {}), ...(pinnedInFile ? { pinned_not_imported: pinnedInFile } : {}), attestations: attestationsToShow(total.attestations) }, null, 2));
      return;
    }
    console.log(`Imported ${imported} note(s)${total.skipped ? `, skipped ${total.skipped} already present` : ""}.`);
    if (pinnedInFile) console.log(`${pinnedInFile} note(s) were pinned in the file; pins are not imported (monomem pin <id> pins one again).`);
    if (notObjects) console.log(`${notObjects} entr${notObjects === 1 ? "y" : "ies"} in the file ${notObjects === 1 ? "was" : "were"} not a note (not an object) and ${notObjects === 1 ? "was" : "were"} ignored.`);
    const a = attestationsToShow(total.attestations);
    if (a) {
      console.log(`Attestations: ${a.verified} verified, ${a.unverified} unverified (stamped as imported by this command, flagged imported_unverified).`);
      for (const [why, n] of Object.entries(a.reasons)) console.log(`  ${n} x ${printable(why)}`);
      for (const k of a.untrusted_keys) {
        // key_id / server_id come from the file: shown quoted and stripped of control characters, never as part of a command to paste.
        console.log(`  key ${printable(k.key_id)} (server ${printable(k.server_id)}) signed ${k.notes} note(s) but is not trusted. To trust it you must get its public key from that server's admin (monomem trust identity there).`);
      }
    }
    if (deferred) console.log("The similarity graph was not rebuilt for this large import: run `monomem rebuild-edges` when convenient.");
    if (total.quarantined.length) console.log(`${total.quarantined.length} note(s) held by the linter (monomem quarantine).`);
    if (total.rejected.length) {
      console.error(`${total.rejected.length} note(s) rejected:`);
      for (const r of total.rejected.slice(0, 200)) console.error(`  ${printable(r.title)}: ${printable(r.error)}`);
      if (total.rejected.length > 200) console.error(`  ... and ${total.rejected.length - 200} more (use --json for the full list)`);
      process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

function trustHelp(): void {
  console.log(
    [
      "monomem trust: whom this store does not believe.",
      "",
      "  trust [list] [--json]                    the distrust list, trusted attesters, recent changes, this server's id",
      "  trust identity [--json]                  this server's id and public key (creates the signing key if needed)",
      "  trust distrust <writer> --namespace <ns|'*'>     leave a writer's notes out of every read and never run them",
      "  trust undistrust <writer> --namespace <ns|'*'>",
      "        <writer> is a token label, or a writer id <server_id>/<label>. Quote the star: --namespace '*'.",
      "  trust attester-add <public-key> --server-id <id> [--label text] [--not-after <ISO time>] [--any-server]",
      "        Believe signed exports from that server. A key is trusted for ONE server (--server-id);",
      "        --any-server accepts a key for any server id (discouraged). --not-after ends trust in the key",
      "        at that time: afterwards it is believed for nothing, old exports too (re-import first, or keep the key without it). A key starting with '-': --public-key <key>.",
      "  trust attester-remove <key-id>",
      "  trust attester-revoke <key-id> [--reason text]   stop believing anything signed by that key, whatever date it claims",
      "        (not_after only EXPIRES trust; a leaked key needs revoking). trust attester-unrevoke <key-id> undoes it.",
      "  trust export-key --out <file>            copy this server's signing key (mode 0600) to move its identity",
      "  trust rotate [--keep-old-private]        make a new signing key. The old PUBLIC key is recorded so this server still",
      "        recognises its earlier exports; the old private key is deleted unless --keep-old-private.",
      "        Running servers switch to the new key at their next signed export, no restart needed.",
      "",
      "Attestations (signed exports), cross-server writer ids, `rotate` and `--any-server` are EXPERIMENTAL:",
      "their wire format and commands may change. See docs/trust.md.",
    ].join("\n")
  );
}

// `monomem trust ...`: the trust policy (docs/trust.md). Local, like every CLI command.
async function trustCmd(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.some((a) => a === "--help" || a === "-h") || args[0] === "help") {
    trustHelp();
    return;
  }
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { flags, rest } = parseFlags(args, {
    values: ["namespace", "server-id", "label", "public-key", "writer", "key-id", "not-after", "out", "reason"],
    bools: ["json", "any-server", "keep-old-private"],
  });
  const action = rest[0] ?? "list";
  const known = ["list", "identity", "distrust", "undistrust", "attester-add", "attester-remove", "attester-revoke", "attester-unrevoke", "export-key", "rotate"];
  if (!known.includes(action)) {
    console.error(`Unknown trust action: ${action}\n`);
    trustHelp();
    process.exit(1);
  }
  const maxRest = action === "list" || action === "identity" || action === "rotate" || action === "export-key" ? 1 : 2;
  if (rest.length > maxRest) {
    console.error(
      `Unexpected extra argument(s): ${rest.slice(maxRest).map((x) => JSON.stringify(x.slice(0, 40))).join(" ")}. ` +
        "If you typed --namespace * the shell expanded the star into file names: write --namespace '*'."
    );
    process.exit(1);
  }
  const nsFlag = str(flags.namespace);
  if (nsFlag && nsFlag !== "*") {
    const { existsSync } = await import("node:fs");
    if (existsSync(nsFlag)) {
      console.error(`Note: "${nsFlag}" is also a file or folder in this directory. If you meant every namespace, quote the star: --namespace '*'.`);
    }
  }
  const store = new Store(DB_PATH);
  const show = (v: unknown, text: string): void => console.log(flags.json ? JSON.stringify(v, null, 2) : text);
  try {
    switch (action) {
      case "list": {
        // Read-only: never creates the signing key.
        const identity = store.peekIdentity();
        const view = store.trustView();
        const out = { ...identity, distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log };
        if (flags.json) {
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        console.log(`This server: ${identity.server_id}${identity.key_id ? ` (signing key ${identity.key_id})` : " (no signing key yet: `monomem trust identity` creates it)"}`);
        console.log(`Distrusted writers (${out.distrust.length}):`);
        for (const r of out.distrust) console.log(`  [${r.namespace}] ${r.writer}  (added ${r.added_at} by ${r.added_by})`);
        console.log(`Trusted attesters (${out.attesters.length}):`);
        for (const a of out.attesters) {
          console.log(
            `  ${a.key_id} server=${a.server_id || "(ANY - unpinned)"} ${a.label ? `"${a.label}" ` : ""}${a.not_after ? `not_after=${a.not_after} ` : ""}[${a.source}]`
          );
        }
        if (out.revoked.length) {
          console.log(`Revoked keys (${out.revoked.length}):`);
          for (const r of out.revoked) console.log(`  ${r.key_id}  (revoked ${r.at} by ${r.by}${r.reason ? `: ${r.reason}` : ""})`);
        }
        if (out.log.length) {
          console.log("Recent changes:");
          for (const l of out.log) console.log(`  ${l.at} ${l.actor} ${l.action} [${l.namespace}] ${l.subject}`);
        }
        return;
      }
      case "export-key": {
        const out = str(flags.out);
        if (!out) {
          console.error("Usage: monomem trust export-key --out <file>");
          process.exit(1);
        }
        const r = store.exportSigningKey(out!);
        show(r, `Copied signing key ${r.key_id} to ${r.path} (${process.platform === "win32" ? "Windows: file modes do not apply, so protect the folder's permissions" : "mode 0600"}). Guard it: whoever holds it can sign as this server. Do not run two live servers with the same key.`);
        return;
      }
      case "rotate": {
        const r = store.rotateSigningKey({ keepOldPrivate: flags["keep-old-private"] === true });
        show(
          r,
          `New signing key ${r.new_key_id}${r.old_key_id ? ` (replaces ${r.old_key_id})` : ""}.\n` +
            (r.old_key_id
              ? `The old PUBLIC key is recorded as a retired key of this server, so exports it signed still verify here. ` +
                (r.old_key_file ? `The old private key was kept as ${r.old_key_file} (guard it or delete it).` : "The old private key was deleted.") +
                "\nIf the old key LEAKED, also run: monomem trust attester-revoke " + r.old_key_id + " (and tell your peers to do the same).\n"
              : "") +
            "Running servers and MCP processes pick up the new key at their next signed export; no restart is needed.\n" +
            `Give the new public key to the peers that verify this server's exports:\n  monomem trust attester-add --public-key ${r.public_key} --server-id ${store.serverId()}\n` +
            (r.old_key_id ? "A peer keeps believing the old key until it removes it (attester-remove) or revokes it (attester-revoke); not_after only expires trust." : "")
        );
        return;
      }
      case "identity": {
        const i = store.identity();
        show(i, `server_id:  ${i.server_id}\nkey_id:     ${i.key_id}\npublic_key: ${i.public_key}\n\nGive the public_key (and server_id) to the admin of the server that should believe this server's exports:\n  monomem trust attester-add --public-key ${i.public_key} --server-id ${i.server_id} --label "<name>"`);
        return;
      }
      case "distrust":
      case "undistrust": {
        const writer = str(flags.writer) ?? rest[1];
        if (!writer) {
          console.error(`Usage: monomem trust ${action} <writer> --namespace <ns|*>   (writer: a token label or <server_id>/<label>; --writer <w> or -- <w> if it starts with "-")`);
          process.exit(1);
        }
        const ns = str(flags.namespace);
        if (!ns) {
          console.error('--namespace is required (use --namespace "*" for every namespace)');
          process.exit(1);
        }
        if (action === "distrust") {
          const r = store.distrustAdd(ns!, writer);
          const matched = store.distrustMatchCount(r.namespace, r.writer);
          show(
            { ...r, matched_notes: matched },
            `Distrusting "${r.writer}" in [${r.namespace}]: its notes are now left out of every read and never run (${matched} existing note(s) match` +
              `${matched === 0 ? " - none yet: check the spelling against the written_by of a note (`monomem recall --include-distrusted`): labels are exact and case-sensitive" : ""}).`
          );
        } else {
          await requireOperator(`trust undistrust ${writer} [${ns}]`);
          const removed = store.distrustRemove(ns!, writer);
          show({ removed }, removed ? `No longer distrusting "${writer}" in [${ns}].` : `"${writer}" was not on the list for [${ns}].`);
        }
        return;
      }
      case "attester-add": {
        const key = str(flags["public-key"]) ?? rest[1];
        if (!key) {
          console.error("Usage: monomem trust attester-add <public-key> --server-id <id> [--label <text>] [--not-after <ISO time>] [--any-server]   (a key starting with \"-\": --public-key <key>)");
          process.exit(1);
        }
        await requireOperator("trust attester-add");
        const r = store.attesterAdd({
          public_key: key,
          server_id: str(flags["server-id"]),
          label: str(flags.label),
          any_server: flags["any-server"] === true,
          not_after: str(flags["not-after"]),
        });
        show(
          r,
          `Trusting key ${r.key_id}${r.server_id ? ` for server ${r.server_id}` : " for ANY server id (the key's holder can claim to be any peer)"}` +
            `${r.not_after ? `, until ${r.not_after} (afterwards for nothing, old exports included)` : ""}.` +
            (r.replaced ? ` (This replaced an earlier entry: pin ${r.replaced.server_id || "any"}, not_after ${r.replaced.not_after || "none"}.)` : "")
        );
        return;
      }
      case "attester-remove": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-remove <key-id>");
          process.exit(1);
        }
        const removed = store.attesterRemove(id);
        show({ removed }, removed ? `Removed key ${id}.` : `Key ${id} was not on the list (a key set in MONOMEM_TRUSTED_ATTESTERS is removed there).`);
        return;
      }
      case "attester-revoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-revoke <key-id> [--reason <text>]");
          process.exit(1);
        }
        const r = store.attesterRevoke(id, str(flags.reason) ?? "");
        show(r, r.already ? `Key ${r.key_id} was already revoked.` : `Revoked key ${r.key_id}: nothing signed by it is believed any more, whatever date the signature claims.`);
        return;
      }
      case "attester-unrevoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-unrevoke <key-id>");
          process.exit(1);
        }
        await requireOperator(`trust attester-unrevoke ${id}`);
        const removed = store.attesterUnrevoke(id);
        show({ removed }, removed ? `Key ${id} is no longer revoked (add it with attester-add if you want to trust it).` : `Key ${id} was not on the revocation list.`);
        return;
      }
      default:
        console.error(`Unknown trust action: ${action}`);
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem token add <name> --scope read|write|admin [--namespace ns] [--max public|internal|private | --no-limit] | list | remove <name> | new`:
// edits tokens.json. `--label <name>` is the same as the positional name. `add` hands out access, so it needs the operator gate;
// `list` and `remove` lower nothing. A running server notices the change within a couple of seconds (no restart).
async function tokenCmd(): Promise<void> {
  const t = await import("./tokens-admin.js");
  const { envTokenLabels } = await import("./token-file.js");
  const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["label", "scope", "namespace", "max"], bools: ["admin", "json", "no-limit"] });
  const action = rest[0];
  const usageLine = "Usage: monomem token add <name> [--scope read|write|admin] [--namespace ns] [--max public|internal|private | --no-limit] | token list | token remove <name>";
  try {
    if (action === "new") {
      console.log(t.newTokenValue());
    } else if (action === "add") {
      const label = str(flags.label) ?? rest[1];
      if (!label) throw new t.TokenAdminError(usageLine);
      const scope = str(flags.scope);
      const asAdmin = scope === "admin" || flags.admin === true;
      const noLimit = flags["no-limit"] === true;
      await requireOperator(`token add (${scope ?? "write"} token "${label}"${noLimit ? ", with NO sensitivity limit" : ""})`);
      const made = t.addApp({
        label,
        ...(scope !== undefined && scope !== "admin" ? { scope } : {}),
        ...(str(flags.namespace) !== undefined ? { namespace: str(flags.namespace)! } : {}),
        ...(str(flags.max) !== undefined ? { max: str(flags.max)! } : {}),
        admin: asAdmin,
        noLimit,
      });
      console.log(t.addedReport(made, noLimit));
      console.log("Client setup (Claude Code, Cursor, Codex): INSTALL.md, section 'Connect to a shared server'.");
    } else if (action === "list" && rest.length === 1) {
      const apps = t.listApps().filter((a) => a.source === "file" || flags.json === true);
      if (flags.json === true) {
        console.log(JSON.stringify(apps, null, 2));
        return;
      }
      const fromEnv = envTokenLabels();
      if (!apps.length) console.log(`No tokens in ${t.tokensPath()} (the primary token is not listed here).`);
      for (const a of apps) {
        const limit = a.max_sensitivity ?? "NO LIMIT (can read private notes)";
        console.log(`${printable(a.label)}  ${a.scope}${a.namespace ? `  namespace=${printable(a.namespace)}` : ""}  sees up to: ${limit}${a.source === "main" ? "  (the main key)" : ""}`);
      }
      if (fromEnv?.length) console.log(`${fromEnv.length} more token(s) come from MONOMEM_TOKENS (labels: ${fromEnv.map((l) => printable(l, 40)).join(", ")}). They are not editable here.`);
    } else if ((action === "remove" || action === "rm") && rest.length === 2) {
      // Removing a token that is not there is not an error (the command stays scriptable), but it says so.
      console.log(
        t.removeApp(rest[1])
          ? `Removed token "${printable(rest[1])}". A running server stops accepting it within a couple of seconds, with no restart.`
          : `No token labelled "${printable(rest[1])}" in tokens.json. See the names with: monomem token list (tokens set in the environment must be removed there).`
      );
    } else {
      throw new t.TokenAdminError(usageLine);
    }
  } catch (e) {
    if (!(e instanceof t.TokenAdminError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

// `monomem quarantine [list | show <id> | approve <id> | keep-history <id> [--by <note id>] | reject <id>]`.
async function quarantineCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError, QUARANTINE_CAS_NOTE } = await import("./store.js");
  const { maybeEmbed } = await import("./search-service.js");
  const [action = "list", idRaw] = process.argv.slice(3);
  const store = new Store(DB_PATH);
  try {
    if (action === "list") {
      const items = store.listQuarantine({ limit: 500 });
      if (items.length === 0) {
        console.log("Quarantine is empty.");
        return;
      }
      for (const q of items) {
        const what = q.op === "update" ? `update of #${q.target_id}` : "new note";
        console.log(`#${q.id} [${printable(q.namespace, 100)}] ${what}: ${q.title == null ? "(title unchanged)" : printable(q.title)}  (${q.created_at})`);
        console.log(`    reasons: ${q.reasons.map((r) => `${r.label} in ${r.field}`).join("; ")}`);
        if (q.body) {
          const preview = q.body.length > 200 ? q.body.slice(0, 200) + "…" : q.body;
          console.log(`    body: ${preview.replace(/\n/g, "\n          ")}`);
        }
      }
      console.log("\nTo decide: monomem quarantine show <id>, then approve <id> | keep-history <id> | reject <id>  (in a terminal)");
      return;
    }
    const id = Number(idRaw);
    if (!["show", "approve", "keep-history", "reject"].includes(action) || !Number.isInteger(id)) {
      console.error("Usage: monomem quarantine [list | show <id> | approve <id> | keep-history <id> [--by <note id>] | reject <id>]");
      process.exit(1);
    }
    if (action === "show") {
      showHeld(store, id, QUARANTINE_CAS_NOTE);
      return;
    }
    if (action === "keep-history") {
      const byAt = process.argv.indexOf("--by");
      const by = byAt > 0 ? Number(process.argv[byAt + 1]) : undefined;
      if (by !== undefined && !Number.isInteger(by)) {
        console.error("--by takes a note id");
        process.exit(1);
      }
      await requireOperator(`quarantine keep-history ${id}`);
      const kept = store.keepQuarantineAsHistory(id, by);
      await maybeEmbed(store, kept.note);
      console.log(`Kept #${id} as history -> note #${kept.note.id} "${printable(kept.note.title)}", replaced by note #${kept.superseded_by}.`);
      return;
    }
    if (action === "reject") {
      if (!store.rejectQuarantine(id)) {
        console.error(`No quarantined write with id ${id}`);
        process.exit(1);
      }
      console.log(`Rejected quarantined write #${id}.`);
      return;
    }
    await requireOperator(`quarantine approve ${id}`);
    const note = store.approveQuarantine(id);
    await maybeEmbed(store, note);
    console.log(`Approved #${id} -> note #${note.id} "${printable(note.title)}"`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

/** `monomem quarantine show <id>`: the held write in full, plus what was saved in its namespace since it was held. */
function showHeld(store: import("./store.js").Store, id: number, casNote: string): void {
  const q = store.getQuarantine(id);
  const ctx = store.quarantineContext(id);
  if (!q || !ctx) {
    console.error(`No quarantined write with id ${id}`);
    process.exit(1);
  }
  const what = q.op === "update" ? `update of #${q.target_id}` : "new note";
  console.log(`#${q.id} [${printable(q.namespace, 100)}] ${what}: ${q.title == null ? "(title unchanged)" : printable(q.title)}`);
  console.log(`    written ${q.created_at}${q.written_by ? ` by ${printable(q.written_by, 100)}` : ""}`);
  console.log(`    reasons: ${q.reasons.map((r) => `${r.label} in ${r.field}`).join("; ")}`);
  if (q.body) console.log(`    body: ${q.body.replace(/\n/g, "\n          ")}`);
  if (ctx.target_changed) console.log(`    Note #${q.target_id} has changed since this edit was held, so approving it will fail.`);
  const n = ctx.notes.length;
  if (n === 0) {
    console.log(`\nNothing on the same topic was saved in ${printable(q.namespace, 100)} since this was held.`);
  } else {
    console.log(`\nSince this was held, ${n} newer note${n === 1 ? "" : "s"} in ${printable(q.namespace, 100)}:`);
    for (const c of ctx.notes) console.log(`    #${c.id} "${printable(c.title)}" (${c.written_by ? `agent ${printable(c.written_by, 100)}, ` : ""}${c.updated_at.slice(0, 10)})`);
  }
  console.log(`\n${casNote}`);
  console.log(`Decide: monomem quarantine approve ${id}${n ? ` | keep-history ${id}` : ""} | reject ${id}`);
}

// `monomem approve-first [<namespace> on|off]`: operator-only switch (no MCP tool sets it).
/** `monomem confirm <id> [--source <s>]`: a person's confirm (kind human), behind the operator gate. */
async function confirmCmd(args: string[]): Promise<void> {
  const usage = 'Usage: monomem confirm <id> [--source "what you checked it against"]';
  const si = args.indexOf("--source");
  const source = si >= 0 ? args[si + 1] : undefined;
  const rest = args.filter((_, i) => si < 0 || (i !== si && i !== si + 1));
  const id = Number(rest[0]);
  if (rest.length !== 1 || !Number.isInteger(id) || id < 1 || (si >= 0 && (source === undefined || source.startsWith("--")))) {
    console.error(usage);
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const n = store.read(id); // gate-ok: the CLI is the operator
    if (!n) {
      console.error(`Error: no note with id ${id}`);
      process.exit(1);
    }
    await requireOperator(`confirm note #${id} ("${printable(n.title, 60)}")`);
    const r = store.confirm(id, { source });
    if (!r) {
      console.error(`Error: no note with id ${id}`);
      process.exit(1);
    }
    console.log(printable(r.message, 400));
    if (!r.counted) process.exitCode = 1;
  } finally {
    store.close();
  }
}

/**
 * `monomem review [--ns <ns>] [--json] [--confirm-all [--source <s>]]`: the notes waiting for a person. Titles are shown
 * here because the reader is the operator at a terminal; they never go into session start or an MCP reply.
 */
async function reviewCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["ns", "namespace", "source"], bools: ["json", "confirm-all"] });
  if (rest.length) {
    console.error('Usage: monomem review [--ns <namespace>] [--json] [--confirm-all [--source "what you checked"]]');
    process.exit(1);
  }
  const ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const items = store.reviewList(ns !== undefined ? [ns] : undefined);
    if (flags.json === true) {
      console.log(JSON.stringify({ notes: items }, null, 2));
      if (flags["confirm-all"] !== true) return;
    } else if (!items.length) {
      console.log("Nothing waits for review.");
      return;
    } else {
      console.log(`${items.length} note${items.length === 1 ? "" : "s"} wait for a person:`);
      for (const r of items) {
        console.log(`  #${r.id} [${printable(r.namespace, 100)}] ${printable(r.title, 120)} (by ${printable(r.writer || "unknown", 100)})`);
        console.log(`      ${printable(r.why, 300)}`);
      }
      if (flags["confirm-all"] !== true) {
        console.log("\nConfirm one after checking it: monomem confirm <id> --source \"what you checked\"");
        return;
      }
    }
    if (!items.length) return;
    const source = typeof flags.source === "string" ? flags.source : "reviewed with monomem review";
    await requireOperator(`confirm all ${items.length} notes listed above as checked ("${printable(source, 60)}")`);
    let counted = 0;
    for (const r of items) {
      const res = store.confirm(r.id, { source });
      if (res?.counted) counted++;
      else if (res) console.log(`  #${r.id}: ${printable(res.message, 300)}`);
    }
    console.log(`Confirmed ${counted} of ${items.length} notes.`);
    if (counted < items.length) process.exitCode = 1;
  } finally {
    store.close();
  }
}

/** `monomem config [get | set confirm-days <n> | set confirm-mode off|label|enforce]`: settings kept in the store. */
async function configCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem config [get | set confirm-days <n> | set confirm-mode off|label|enforce]";
  const [verb = "get", key, value, ...extra] = args;
  if (extra.length || (verb !== "get" && verb !== "set") || (verb === "get" && key !== undefined) || (verb === "set" && (value === undefined || (key !== "confirm-days" && key !== "confirm-mode")))) {
    console.error(usage);
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const show = (): void => {
      const c = store.confirmSettings();
      console.log(`confirm-mode: ${c.mode}${c.set_at ? ` (since ${c.set_at.slice(0, 16).replace("T", " ")})` : " (default)"}`);
      console.log(`confirm-days: ${c.days}`);
    };
    if (verb === "get") return show();
    const before = store.confirmSettings();
    const RANK: Record<string, number> = { off: 0, label: 1, enforce: 2 };
    try {
      if (key === "confirm-mode") {
        if (!(value in RANK)) throw new ValidationError("confirm-mode must be one of: off, label, enforce");
        if (RANK[value] < RANK[before.mode]) await requireOperator(`lower re-confirmation expiry from ${before.mode} to ${value}`);
        store.setConfirmSettings({ mode: value as "off" | "label" | "enforce" });
      } else {
        const days = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
        if (days > before.days && before.mode !== "off") await requireOperator(`lengthen re-confirmation from ${before.days} to ${value} days`);
        // Under enforce, shortening the period takes notes out of session start; the store restarts the clock, and a person decides.
        if (days < before.days && before.mode === "enforce") await requireOperator(`shorten re-confirmation under enforce from ${before.days} to ${value} days`);
        store.setConfirmSettings({ days });
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
    show();
  } finally {
    store.close();
  }
}

async function approveFirstCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const [ns, state] = process.argv.slice(3);
  if (ns !== undefined && (!ns.trim() || (state !== "on" && state !== "off"))) {
    console.error("Usage: monomem approve-first [<namespace> on|off | --all on|off]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    if (ns === undefined) {
      const list = store.approveFirstNamespaces();
      console.log(`All namespaces: ${store.approveFirstAll() ? "on (every namespace, including new ones)" : "off"}`);
      console.log(list.length ? `Approve-first for these namespaces: ${list.join(", ")}` : "Approve-first for individual namespaces: none.");
      return;
    }
    if (ns === "--all") {
      if (state === "off") await requireOperator("approve-first off for all namespaces");
      store.setApproveFirstAll(state === "on");
      console.log(
        state === "on"
          ? "Approve-first is on for every namespace, including ones created later: agent writes wait in `monomem quarantine`."
          : "Approve-first is off for all namespaces (any per-namespace setting still applies). Writes already held stay in `monomem quarantine`."
      );
      return;
    }
    if (state === "off") await requireOperator(`approve-first off for "${ns.trim()}"`);
    store.setApproveFirst(ns, state === "on");
    console.log(
      state === "on"
        ? `Approve-first is on for "${ns.trim()}": agent writes there now wait in \`monomem quarantine\`.`
        : `Approve-first is off for "${ns.trim()}". Writes already held stay in \`monomem quarantine\`.`
    );
  } finally {
    store.close();
  }
}

// `monomem access [--since <iso|duration>] [--writer <label>] [--limit N] [--json]`: the read access log (operator only).
async function accessCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { resolveSince } = await import("./changes.js");
  const { printable } = await import("./security.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["since", "writer", "limit"], bools: ["json"] });
  const store = new Store(DB_PATH);
  try {
    const since = typeof flags.since === "string" ? resolveSince(flags.since) ?? undefined : undefined;
    const entries = store.accessLog({
      ...(since ? { since } : {}),
      ...(typeof flags.writer === "string" ? { writer: flags.writer } : {}),
      ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
    });
    const paused = store.pausedWriters();
    if (flags.json) {
      console.log(JSON.stringify({ entries, paused }, null, 2));
      return;
    }
    if (!entries.length) console.log("No reads logged" + (since || flags.writer ? " for that filter." : " yet."));
    for (const e of entries) {
      const q = e.query ? `  "${printable(e.query, 120)}"` : "";
      console.log(`${e.at.slice(0, 19).replace("T", " ")}  ${printable(e.writer || "(unknown)", 40).padEnd(16)} ${e.tool.padEnd(18)} ${String(e.results).padStart(4)} result(s)  ${printable(e.namespaces || "-", 60)}${q}`);
    }
    if (paused.length) console.log(`\nPaused by the flood guard: ${paused.join(", ")} (monomem resume <label>)`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem flood`: writers the flood guard paused. `monomem resume <label>`: lift a pause (operator only).
async function floodCmd(resume: boolean): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, floodWritesPerHour } = await import("./store.js");
  const label = process.argv[3];
  if (resume && !label?.trim()) {
    console.error("Usage: monomem resume <writer label>   (see `monomem flood` for the paused ones)");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    if (resume) {
      await requireOperator(`resume ${label.trim()}`);
      console.log(store.resumeWriter(label) ? `Resumed "${label.trim()}": its writes are accepted again.` : `"${label.trim()}" was not paused.`);
      return;
    }
    const limit = floodWritesPerHour();
    const paused = store.pausedWriters();
    console.log(limit ? `Flood guard: a writer is paused after ${limit} writes in an hour.` : "Flood guard: off (MONOMEM_FLOOD_WRITES_PER_HOUR=0).");
    console.log(paused.length ? `Paused: ${paused.join(", ")}. Resume with: monomem resume <label>` : "No writer is paused.");
  } finally {
    store.close();
  }
}

// `monomem decay [--dry-run] [--namespace ns]`: archive (never delete) idle captured rows now; --dry-run only lists them.
async function decayCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, decayConfig } = await import("./store.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["dry-run"] });
  const ns = str(flags.namespace);
  const namespaces = ns ? [ns] : undefined;
  const store = new Store(DB_PATH);
  try {
    const cfg = decayConfig();
    if (cfg.days === 0) {
      console.log("Decay is off (MONOMEM_DECAY_DAYS=0).");
      return;
    }
    if (flags["dry-run"]) {
      const rows = store.decayCandidates(Date.now(), namespaces);
      if (!rows.length) {
        console.log("Nothing would be archived.");
        return;
      }
      for (const r of rows) console.log(`#${r.id} [${printable(r.namespace, 100)}] ${r.obs_type || r.kind}: ${printable(r.title)}  (idle ${r.idleDays} days)`);
      console.log(`${rows.length} row(s) would be archived. Run \`monomem decay\` to archive them; \`monomem restore <id>\` brings one back.`);
      return;
    }
    const n = store.sweepDecay(Date.now(), namespaces);
    console.log(`Archived ${n} idle captured row(s). Nothing was deleted: \`monomem restore <id>\` brings one back.`);
  } finally {
    store.close();
  }
}

// `monomem delete <id> [--yes]`: the permanent delete, for a person. An agent's state_delete only archives.
async function deleteCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { audit } = await import("./security.js");
  const id = Number(process.argv[3]);
  if (!Number.isInteger(id)) {
    console.error("Usage: monomem delete <id> [--yes]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const note = store.read(id); // gate-ok: local shell command (permanent delete): the operator owns the database file
    if (!note) {
      console.error(`No note #${id}.`);
      process.exit(1);
    }
    await gatePinned(store, [id], "delete");
    if (!process.argv.includes("--yes")) {
      if (!process.stdin.isTTY) {
        console.error("A permanent delete cannot be undone: run it at a terminal and answer the question, or add --yes.");
        process.exit(1);
      }
      const ok = await askYesNo(`Permanently delete note #${id} "${note.title}" and all its earlier versions? This cannot be undone. [y/N] `);
      if (!ok) {
        console.log("Nothing deleted.");
        return;
      }
    }
    store.delete(id);
    audit({ op: "note.delete", id, namespace: note.namespace, label: "cli", kind: "note" });
    console.log(`Deleted #${id} "${note.title}" permanently.`);
    // Store.delete already tried; a second try answers whether another app is still holding part of the log.
    if (!store.checkpointWal()) {
      console.log("Its text can stay in state.db-wal until every app using Monomem disconnects (the last one to close clears it); after that, `monomem scrub --yes` also clears it.");
    }
  } finally {
    store.close();
  }
}

// `monomem archive <id>` / `monomem restore <id>`: the same soft archive and restore as POST /notes/:id/archive|restore.
// `monomem restore <backup folder | state.db>`: put a backup back as the live database (a number is a note id: that is the other restore).
async function restoreBackupCmd(): Promise<void> {
  const { DB_PATH, API_PORT } = await import("./config.js");
  const { inspectBackup, dbBusy, applyRestore, RestoreError, BUSY_MESSAGE } = await import("./restore.js");
  const args = process.argv.slice(3);
  const yes = args.includes("--yes");
  const target = args.find((a) => !a.startsWith("--"))!;
  try {
    const plan = inspectBackup(target);
    console.log(`Backup: ${plan.source}`);
    console.log(`  ${plan.notes} note(s), database version ${plan.schema}${plan.schema < (await import("./store.js")).SCHEMA_VERSION ? " (older; it is upgraded the next time Monomem opens it, and a .pre-vNN-backup copy is kept)" : ""}.`);
    if (plan.encrypted) console.log("  Its notes are encrypted: you also need the key that went with it (the .key file), or they cannot be read.");
    // Busy is judged by the database lock alone: a server on the port that has the file open holds the lock too.
    if (dbBusy(DB_PATH)) {
      console.error(BUSY_MESSAGE);
      process.exit(1);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(1000) })).ok) {
        console.log(`  (Something answers on port ${API_PORT} but does not have this database open; if it is a Monomem server for this store, restart it after the restore.)`);
      }
    } catch {
      /* nothing on the port */
    }
    if (!yes) {
      console.log(`\nThis replaces ${DB_PATH}. Your current database is copied aside first (${DB_PATH}.before-restore-<time>).`);
      if (!process.stdin.isTTY) {
        console.log("Nothing was changed. Run it again with --yes to go ahead.");
        process.exit(2);
      }
      const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question("Go ahead? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (a !== "y" && a !== "yes") {
        console.log("Nothing was changed.");
        return;
      }
    }
    const r = applyRestore(plan, DB_PATH);
    console.log(`Restored ${plan.notes} note(s).`);
    if (r.keptCurrentAt) console.log(`Your previous database is kept at ${r.keptCurrentAt}. To go back: monomem restore "${r.keptCurrentAt}" --yes`);
    console.log("Start Monomem again, then run: monomem doctor");
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function archiveCmd(action: "archive" | "restore"): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const id = Number(process.argv[3]);
  if (!Number.isInteger(id)) {
    console.error(`Usage: monomem ${action} <id>`);
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const before = store.read(id); // gate-ok: local shell command (archive/restore): the operator owns the database file
    if (!before || (action === "archive") !== !before.archived_at) {
      console.error(before ? `Note #${id} is ${action === "archive" ? "already archived" : "not archived"}.` : `No note #${id}.`);
      process.exit(1);
    }
    await gatePinned(store, [id], action);
    const note = action === "archive" ? store.archive(id) : store.restore(id);
    console.log(`${action === "archive" ? "Archived" : "Restored"} #${id} "${printable(note?.title)}".${action === "archive" ? ` Undo: monomem restore ${id}` : ""}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem quality [--json] [--namespace ns]`: what in the store is worth a look, with the command that fixes each.
async function qualityCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { qualityReport, QUALITY_TYPES } = await import("./quality.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["json"] });
  const ns = str(flags.namespace);
  const store = new Store(DB_PATH);
  try {
    const report = await qualityReport(store, ns ? [ns] : undefined);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const { conflictLines, reportHeader } = await import("./conflicts.js");
    if (!report.issues.length && !report.conflict_groups.length) {
      console.log("No quality issues found.");
      return;
    }
    console.log(QUALITY_TYPES.map((t) => `${report.counts[t]} ${t}`).join(", ") + `, ${reportHeader({ groups: report.conflict_groups, total: report.conflict_total, capped: report.conflict_capped })}`);
    for (const l of conflictLines(report.conflict_groups)) console.log(l);
    for (const i of report.issues) {
      console.log(`\n[${i.type}] [${printable(i.namespace, 100)}] ${i.detail}`);
      console.log(`    fix: ${i.fix}${i.alt ? `   (or: ${i.alt})` : ""}`);
    }
  } finally {
    store.close();
  }
}

/**
 * `monomem encrypt <enable|status|disable>` -- at-rest body encryption.
 *
 * enable  creates the AES-256-GCM key (if absent) and encrypts every
 *         plaintext body in place. disable decrypts them and removes the key.
 * Both open the store AFTER touching the key file, so the Store constructor
 * picks up the new encryption state. See docs/encryption-retention.md.
 */
async function encryptCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const crypto = await import("./crypto.js");
  const { dirname } = await import("node:path");
  const { existsSync, renameSync, rmSync } = await import("node:fs");
  // ONE key resolver: the same directory the Store itself looks in (beside
  // the database), so MONOMEM_DB_PATH pointing elsewhere cannot split the
  // key from the data.
  const keyDir = dirname(DB_PATH);
  const [action] = process.argv.slice(3);

  if (action !== "enable" && action !== "status" && action !== "disable") {
    console.error("Usage: monomem encrypt <enable|status|disable>");
    process.exit(1);
  }

  if (action === "status") {
    const store = new Store(DB_PATH); // opening restores a key stranded by a crashed `disable`
    const enabled = crypto.encryptionEnabled(keyDir);
    const keyFile = crypto.keyPath(keyDir);
    try {
      console.log(`encryption: ${enabled ? "on" : "off"}`);
      console.log(`key file:   ${keyFile}${enabled ? "" : " (not present)"}`);
      console.log(`encrypted bodies: ${store.encryptedCount()}`);
      if (enabled) {
        console.log(
          "note: keyword search covers title+tags only for encrypted notes " +
            "(bodies are not indexed as ciphertext)."
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (action === "enable") {
    // Create the key, then encrypt. A running server notices the key file on
    // its next write (it checks per write, under the write lock), so notes
    // written meanwhile are sealed too -- and encryptAll picks up any that
    // slipped in as plaintext before the key existed.
    const key = crypto.ensureKey(keyDir);
    const store = new Store(DB_PATH);
    try {
      // Verify the Store sees the very key we just made before touching data.
      if (!existsSync(crypto.keyPath(keyDir))) throw new Error("key file vanished after creation");
      const n = store.encryptAll(key);
      console.log(`Enabled at-rest encryption. Encrypted ${n} note ${n === 1 ? "body" : "bodies"}.`);
      console.log(`Key file: ${crypto.keyPath(keyDir)} -- back it up; losing it loses the bodies.`);
      console.log("Keyword search now covers title+tags only (bodies cannot be indexed as ciphertext).");
      const copies = Store.preMigrationBackups(DB_PATH);
      if (copies.length) {
        console.log(
          `WARNING: ${copies.length} pre-upgrade copy(ies) of this database exist and were made BEFORE encryption, so their note bodies are PLAINTEXT:\n` +
            copies.map((c) => `         ${c.path}`).join("\n") +
            "\n         Remove them once you are happy with the upgrade: monomem backup --prune-premigration"
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  // disable: decrypt everything BEFORE removing the key, so a failure leaves
  // the store untouched and still readable. The key file is moved aside
  // INSIDE the decrypting transaction (under the write lock): a running
  // server's next write then sees "no key" and stores plaintext, instead of
  // sealing a body with a key that is about to be deleted.
  new Store(DB_PATH).close(); // opening restores a key stranded by a crashed `disable`
  const key = crypto.loadKey(keyDir);
  if (!key) {
    console.error("Encryption is not enabled (no key file); nothing to disable.");
    process.exit(1);
  }
  const keyFile = crypto.keyPath(keyDir);
  const aside = `${keyFile}.disabling-${process.pid}`;
  let moved = false;
  const store = new Store(DB_PATH);
  let decrypted: number;
  try {
    decrypted = store.decryptAll(key, {
      beforeCommit: () => {
        renameSync(keyFile, aside);
        moved = true;
      },
    });
  } catch (e) {
    if (moved && !existsSync(keyFile)) renameSync(aside, keyFile); // commit failed: keep the key
    throw e;
  } finally {
    store.close();
  }
  // Delete the key only after every body decrypted and the transaction committed.
  rmSync(aside, { force: true });
  console.log(`Disabled at-rest encryption. Decrypted ${decrypted} note ${decrypted === 1 ? "body" : "bodies"}.`);
  console.log("Key file removed. Keyword search again covers full body text.");
}

/** `monomem supersede ...` and `monomem history ...` (see supersede-cli.ts). */
async function supersedeCmd(kind: "supersede" | "history" | "pin" | "unpin" | "rollback"): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { supersedeCli, historyCli, pinCli, rollbackCli } = await import("./supersede-cli.js");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io = {
    out: (t: string): void => console.log(t),
    err: (t: string): void => console.error(t),
    ask: (prompt: string): Promise<string> =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a: string) => {
          rl.close();
          resolve(a);
        });
      }),
    interactive,
  };
  const store = new Store(DB_PATH);
  try {
    const args = process.argv.slice(3);
    if (kind === "unpin") await requireOperator(`unpin ${args[0] ?? ""}`.trim());
    if (kind === "supersede" || kind === "history") await gatePinned(store, pinnedTargets(kind, args), kind === "supersede" ? "supersede" : `history ${args[0]}`);
    // 1.4.0: promoting outside content no person confirmed (pin, or replace with it) needs the person at the terminal.
    if (kind === "pin" && args.length === 1) await gateOutside(store, [Number(args[0])].filter(Number.isInteger), "pinning");
    if (kind === "supersede") await gateOutside(store, newIdTarget(args), "replacing notes with");
    // --confirm-token: the code names the replacement (made by a preview, maybe over MCP while the note was not yet marked).
    // Confirming it from the CLI would record the operator's human confirm, so the person must be at the terminal.
    if (kind === "supersede") {
      const code = confirmTokenArg(args);
      if (code) {
        const { supersedeTokenNewId } = await import("./supersede.js");
        await gateOutside(store, [supersedeTokenNewId(store, code)].filter((n) => n > 0), "replacing notes with");
      }
    }
    process.exitCode =
      kind === "supersede"
        ? await supersedeCli(store, args, io)
        : kind === "history"
          ? await historyCli(store, args, io)
          : kind === "rollback"
            ? await rollbackCli(store, args, io)
            : await pinCli(store, kind, args, io);
  } finally {
    store.close();
  }
}

/** The --confirm-token value of a supersede command, or "". */
function confirmTokenArg(args: string[]): string {
  const i = args.findIndex((a) => a === "--confirm-token" || a.startsWith("--confirm-token="));
  return i < 0 ? "" : args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : (args[i + 1] ?? "");
}

/** The --new-id of a supersede command (the note that would take the others' place), or none. */
function newIdTarget(args: string[]): number[] {
  const i = args.findIndex((a) => a === "--new-id" || a.startsWith("--new-id="));
  const v = i < 0 ? "" : args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : (args[i + 1] ?? "");
  return [Number(v)].filter((n) => Number.isInteger(n) && n > 0);
}

/** Note ids a supersede / history command would change or retire (empty for reads and for arguments it cannot parse). */
function pinnedTargets(kind: "supersede" | "history", args: string[]): number[] {
  const first = args.find((a) => !a.startsWith("--"));
  if (kind === "history") {
    if (first !== "restore" && first !== "purge") return [];
    return [Number(args.filter((a) => !a.startsWith("--"))[1])].filter(Number.isInteger);
  }
  if (first === "undo") return [Number(args.filter((a) => !a.startsWith("--"))[1])].filter(Number.isInteger);
  const i = args.findIndex((a) => a === "--old" || a.startsWith("--old="));
  const v = i < 0 ? "" : args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : (args[i + 1] ?? "");
  return v.split(",").map(Number).filter(Number.isInteger);
}

/** TTY yes/no prompt; anything but y/yes aborts. */
function terminalIO(): import("./setup.js").SetupIO {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (prompt) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a: string) => {
          rl.close();
          resolve(a);
        });
      }),
  };
}

// `monomem sync --git <repo>`: see sync-git.ts.
async function syncCmd(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["git", "remote", "key-file"],
    bools: ["encrypt", "dry-run", "no-push", "yes"],
  });
  if (!str(flags.git)) {
    console.error("Usage: monomem sync --git <repo-folder> [--remote name] [--encrypt] [--key-file f] [--dry-run] [--no-push] [--yes]");
    process.exit(1);
  }
  const { DB_PATH, DATA_DIR } = await import("./config.js");
  const { runGitSync } = await import("./sync-git.js");
  const io = terminalIO();
  process.exitCode = await runGitSync(io, {
    repo: str(flags.git)!,
    remote: str(flags.remote),
    encrypt: flags.encrypt === true,
    keyFile: str(flags["key-file"]),
    dryRun: flags["dry-run"] === true,
    noPush: flags["no-push"] === true,
    yes: flags.yes === true,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    env: process.env,
  });
}

// `monomem setup`: see setup.ts.
async function setupCmd(): Promise<void> {
  const { runSetup, realEnv, DEFAULT_OPTIONS } = await import("./setup.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["only", "db", "command"],
    bools: ["dry-run", "yes", "undo", "hook", "no-hook", "capture", "no-capture", "project", "no-test-note", "no-doctor", "force-empty", "terse"],
  });
  const command = str(flags.command) ?? "auto";
  if (!["auto", "node", "npx"].includes(command)) {
    console.error("--command must be auto, node or npx");
    process.exit(1);
  }
  if (flags.hook === true && flags["no-hook"] === true) {
    console.error("Choose one of --hook and --no-hook");
    process.exit(1);
  }
  if (flags.capture === true && flags["no-capture"] === true) {
    console.error("Choose one of --capture and --no-capture");
    process.exit(1);
  }
  const { PACKAGE_VERSION } = await import("./config.js");
  const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
  process.exitCode = await runSetup(e, terminalIO(), {
    ...DEFAULT_OPTIONS,
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    undo: flags.undo === true,
    hook: flags.hook === true ? "yes" : flags["no-hook"] === true ? "no" : "ask",
    capture: flags.capture === true ? "yes" : flags["no-capture"] === true ? "no" : "ask",
    project: flags.project === true,
    noTestNote: flags["no-test-note"] === true,
    noDoctor: flags["no-doctor"] === true,
    forceEmpty: flags["force-empty"] === true,
    terse: flags.terse === true,
    only: str(flags.only)?.split(",").map((x) => x.trim()).filter(Boolean),
    db: str(flags.db),
    command: command as "auto" | "node" | "npx",
  });
}

// `monomem uninstall`: see uninstall.ts.
async function uninstallCmd(): Promise<void> {
  const { realEnv } = await import("./setup.js");
  const { runUninstall } = await import("./uninstall.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: [], bools: ["purge", "dry-run", "yes", "no-backup"] });
  const { PACKAGE_VERSION } = await import("./config.js");
  process.exitCode = await runUninstall(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)), terminalIO(), {
    purge: flags.purge === true,
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    noBackup: flags["no-backup"] === true,
  });
}

// Untrusted text (note titles, imported text) printed to the terminal goes through this; bound in main() once config is loaded.
let printable: typeof import("./security.js").printable = (s) => String(s ?? "");

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function printCommandHelp(cmd: string): void {
  const h = helpFor(cmd);
  console.log(h ? `monomem ${cmd}\n\n${h}\n\nAll commands: monomem help --all` : `monomem ${cmd}: no extra options. All commands: monomem help --all`);
}

/** The help lines for one command, taken from the full help (so there is one text to keep right). */
function helpFor(cmd: string): string | null {
  const orig = console.log;
  let buf = "";
  console.log = (s?: unknown): void => void (buf += String(s ?? "") + "\n");
  try {
    usage(true);
  } finally {
    console.log = orig;
  }
  const out: string[] = [];
  let on = false;
  for (const line of buf.split("\n")) {
    const head = /^ {2}(\S+)/.exec(line);
    // Every command word on a head line counts ("  show <id> | ls [--ns x] | edit <id> | forget <id>" is ls's line too).
    const words = head ? [...line.matchAll(/(?:^ {2}|\| )([a-z-]+)/g)].map((m) => m[1]) : [];
    if (head) on = head[1].split("|").includes(cmd) || words.includes(cmd) || (cmd === "scrub" && head[1] === "purge-deleted");
    else if (!/^ {6,}/.test(line)) on = false;
    if (on) out.push(line);
  }
  return out.length ? out.join("\n") : null;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "start";
  // --ns is short for --namespace (as in ls) for these commands, each of which parses its own flags.
  if (["relevant", "search", "export", "quality", "conflicts", "facts", "digest", "pii", "decay"].includes(cmd)) {
    process.argv = process.argv.map((a, i) => (i < 3 ? a : a === "--ns" ? "--namespace" : a.startsWith("--ns=") ? "--namespace=" + a.slice(5) : a));
  }
  if ((process.argv.includes("--help") || process.argv.includes("-h")) && process.argv.indexOf(cmd) === 2 && COMMANDS.includes(cmd) && !cmd.startsWith("-") && cmd !== "help" && cmd !== "trust") {
    printCommandHelp(cmd);
    return;
  }
  // Old Node: say so in plain words BEFORE anything loads node:sqlite (which would crash with a stack trace).
  // setup.js is safe to load here -- it never imports node:sqlite.
  if (!["help", "--help", "-h"].includes(cmd)) {
    const { nodeIsOk, MIN_NODE_TEXT } = await import("./setup.js");
    if (!nodeIsOk(process.versions.node)) {
      console.error(
        `Monomem needs Node.js ${MIN_NODE_TEXT} or newer, and this computer has Node ${process.versions.node}.\n` +
          "  Fix: install Node 22.16+ or 24 LTS (https://nodejs.org), open a NEW terminal, check with:  node -v\n" +
          "  Just want to set it up now? This runs setup with a temporary Node 24 (nothing to install):\n" +
          "      npx -y -p node@24 -p monomem monomem setup\n" +
          "  Your apps will still start Monomem with the Node on this computer, so upgrade Node before relying on it.\n" +
          "  Nothing was changed. (Can't upgrade Node? Docker works too: see INSTALL.md.)"
      );
      process.exit(1);
    }
  }
  if (!COMMANDS.includes(cmd)) {
    const guess = suggestCommand(cmd);
    console.error(`Unknown command '${cmd}'.${guess ? ` Did you mean '${guess}'?` : ""}\nRun 'monomem help' to see the commands.`);
    process.exit(1);
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { PACKAGE_VERSION } = await import("./config.js");
    console.log(PACKAGE_VERSION);
    return;
  }
  // Move 1.0.x state out of the package before anything opens the DB.
  // (`bench` runs on a throwaway store and must never touch the real data directory.)
  // A dry run of `import --claude` / `import --from` or `sync` must not create anything, not even the data folder.
  const dry = process.argv.includes("--dry-run") && ((cmd === "import" && (process.argv.includes("--claude") || process.argv.includes("--from") || process.argv.includes("--rules"))) || cmd === "sync");
  // The capture hooks (`hook`) never move or create data folders: they run on every tool call and must stay quick and quiet.
  if (!dry && !["help", "--help", "-h", "init", "bench", "demo", "snippet", "setup", "uninstall", "hook"].includes(cmd)) {
    (await import("./config.js")).prepareDataDir();
    printable = (await import("./security.js")).printable;
  }
  // Fixed writer marker for notes this process writes with no token behind
  // them (written_by): the long-running server's own jobs, the stdio MCP
  // server, or an `monomem ...` command run by the machine owner.
  setProcessWriter(
    cmd === "start" || cmd === "serve" ? "server" : cmd === "mcp" || cmd === "mcp:stdio" ? "stdio" : cmd === "hook" ? "capture" : "cli"
  );
  switch (cmd) {
    case "start":
    case "serve":
      await import("./start.js");
      break;
    case "mcp":
    case "mcp:stdio":
      await import("./mcp-stdio.js");
      break;
    case "doctor":
      await doctor();
      break;
    case "init":
      await init();
      break;
    case "setup":
      await setupCmd();
      break;
    case "uninstall":
      await uninstallCmd();
      break;
    case "sync":
      await syncCmd();
      break;
    case "reindex":
      await reindex();
      break;
    case "recall":
      await recall();
      break;
    case "hook":
      await hookCmd();
      break;
    case "consolidate":
      await consolidate();
      break;
    case "rebuild-edges":
      await rebuildEdges();
      break;
    case "relevant":
    case "search":
      await relevant();
      break;
    case "changes":
      await changes();
      break;
    case "backup":
      await backupCmd();
      break;
    case "runner-status":
      await runnerStatusCmd();
      break;
    case "watch":
      await watchCmd();
      break;
    case "export":
      await exportCmd();
      break;
    case "import":
      await importCmd();
      break;
    case "trust":
      await trustCmd();
      break;
    case "token":
      await tokenCmd();
      break;
    case "quarantine":
      await quarantineCmd();
      break;
    case "approve-first":
      await approveFirstCmd();
      break;
    case "confirm":
      await confirmCmd(process.argv.slice(3));
      break;
    case "review":
      await reviewCmd(process.argv.slice(3));
      break;
    case "config":
      await configCmd(process.argv.slice(3));
      break;
    case "access":
      await accessCmd();
      break;
    case "flood":
      await floodCmd(false);
      break;
    case "resume":
      await floodCmd(true);
      break;
    case "decay":
      await decayCmd();
      break;
    case "add":
      await (await import("./everyday-cli.js")).addCmd(process.argv.slice(3));
      break;
    case "show":
      await (await import("./everyday-cli.js")).showCmd(process.argv.slice(3));
      break;
    case "ls":
      await (await import("./everyday-cli.js")).lsCmd(process.argv.slice(3));
      break;
    case "edit":
      await (await import("./everyday-cli.js")).editCmd(process.argv.slice(3));
      break;
    case "forget":
    case "archive":
    case "restore":
      if (cmd === "restore" && process.argv[3] && !/^\d+$/.test(process.argv[3])) {
        await restoreBackupCmd();
        break;
      }
      if (cmd === "forget" && process.stdin.isTTY && !process.argv.includes("--yes")) {
        const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
        const a = (await rl.question(`Forget note #${process.argv[3]}? It is archived, not deleted, and "monomem restore ${process.argv[3]}" brings it back. [y/N] `)).trim().toLowerCase();
        rl.close();
        if (a !== "y" && a !== "yes") {
          console.log("Left as it was.");
          break;
        }
      }
      await archiveCmd(cmd === "forget" ? "archive" : cmd);
      break;
    case "delete":
      await deleteCmd();
      break;
    case "audit": {
      // `audit verify` is the hash-chain check; anything else is the plain-words viewer of who changed what.
      if (process.argv[3]?.startsWith("--") && process.argv[3] !== "--expect") {
        await (await import("./phase-b-cli.js")).auditCmd();
        break;
      }
      const usage = "Usage: monomem audit verify [--expect <head-hash>]   |   monomem audit --since 24h [--op create|update|delete] [--label <key>] [--limit n] [--json]";
      const rest = process.argv.slice(4);
      const ei = rest.indexOf("--expect");
      const expect = ei >= 0 ? rest[ei + 1]?.trim().toLowerCase() : undefined;
      const extraArgs = rest.filter((_, k) => k !== ei && k !== ei + 1 || ei < 0);
      if (process.argv[3] !== "verify" || extraArgs.length > 0 || (ei >= 0 && !/^[0-9a-f]{64}$/.test(expect ?? ""))) {
        console.error(usage + (ei >= 0 ? " (the head hash is 64 hex characters, as printed by `monomem audit verify`)" : ""));
        process.exit(2);
      }
      const { verifyAuditChain } = await import("./security.js");
      const r = verifyAuditChain(undefined, expect);
      const extra = `${r.forks} fork(s) (two processes writing at once, or a line inserted), ${r.unchained} line(s) from before the chain`;
      if (!r.ok) {
        console.error(`Audit chain BROKEN: ${r.breaks} break(s), first at line ${r.brokenLine} of ${r.file} (it follows from none of the lines before it). ${extra}.`);
        process.exit(1);
      }
      console.log(`Audit chain intact: ${r.lines} line(s), ${extra}.`);
      console.log(`Head ${r.head ?? "(empty)"}: keep it somewhere that is not this machine (a git commit, a password manager), then check later with: monomem audit verify --expect <head>.`);
      console.log("Detects lines edited or removed inside the chain. Not: a line inserted (it looks like a fork), rotated files deleted, or a full rewrite by anyone who can write the file. Without a saved head it also cannot see the newest lines cut off.");
      if (r.anchor) {
        if (!r.anchor.found) {
          console.error("Anchor NOT FOUND: no line in the log has the hash you gave. The log was rewritten or cut off before that point (or the hash is from another log).");
          process.exit(1);
        }
        console.log(r.anchor.linesAfter === 0 ? "Anchor OK: the hash you gave is the current head." : `Anchor OK: the line you noted is still in the chain, ${r.anchor.linesAfter} line(s) older than the head (the log has grown since).`);
      }
      break;
    }
    case "quality":
      await qualityCmd();
      break;
    case "conflicts":
      await (await import("./conflicts.js")).conflictsCmd(process.argv.slice(3));
      break;
    case "facts":
      await (await import("./facts.js")).factsCmd(process.argv.slice(3));
      break;
    case "fact":
      await (await import("./facts.js")).factRemoveCmd(process.argv.slice(3));
      break;
    case "encrypt":
      await encryptCmd();
      break;
    case "why":
      await (await import("./why.js")).whyCmd(process.argv.slice(3));
      break;
    case "receipts":
    case "meter": {
      const r = await import("./receipts.js");
      await (cmd === "meter" ? r.meterCmd : r.receiptsCmd)(process.argv.slice(3));
      break;
    }
    case "never-show":
      await neverShowCmd();
      break;
    case "label":
      await labelCmd();
      break;
    case "token":
      await tokenCmd();
      break;
    case "connect":
      await connectCmd();
      break;
    case "open":
      await openCmd();
      break;
    case "supersede":
      await supersedeCmd("supersede");
      break;
    case "history":
      await supersedeCmd("history");
      break;
    case "pin":
    case "unpin":
    case "rollback":
      await supersedeCmd(cmd);
      break;
    case "drill": {
      const { drillMain } = await import("./drill.js");
      process.exitCode = await drillMain(process.argv.slice(3));
      break;
    }
    case "health": {
      const { healthMain } = await import("./health.js");
      process.exitCode = await healthMain(process.argv.slice(3));
      break;
    }
    case "bench": {
      const args = process.argv.slice(3);
      if (args.includes("--longmemeval") || args.includes("--locomo")) {
        // Imported before anything loads config.js: it moves MONOMEM_HOME to a temp folder first.
        const { retrievalMain } = await import("./bench/retrieval.js");
        process.exitCode = await retrievalMain(args);
        break;
      }
      const { benchMain } = await import("./bench/index.js");
      process.exitCode = await benchMain(args);
      break;
    }
    case "purge-deleted":
    case "scrub":
    case "pii":
    case "digest":
    case "safety-report":
    case "demo":
    case "snippet": {
      const m = await import("./phase-b-cli.js");
      await { scrub: m.scrubCmd, "purge-deleted": m.scrubCmd, pii: m.piiCmd, digest: m.digestCmd, "safety-report": m.safetyReportCmd, demo: m.demoCmd, snippet: m.snippetCmd }[cmd]!();
      break;
    }
    case "help":
    case "--help":
    case "-h": {
      // `monomem help <cmd>` is the same as `monomem <cmd> --help`; an unknown word falls back to the general help.
      const sub = process.argv[3];
      if (sub && sub !== "all" && !sub.startsWith("-") && helpFor(sub)) printCommandHelp(sub);
      else usage(process.argv.includes("--all") || sub === "all");
      break;
    }
    default:
      console.error(`Unknown command '${cmd}'. Run 'monomem help' to see the commands.`);
      process.exit(1);
  }
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  // A damaged database file (SQLITE_CORRUPT 11, SQLITE_NOTADB 26) from any command: say what to do, not only SQLite's words.
  const code = (e as { errcode?: number }).errcode;
  if (code === 11 || code === 26 || /malformed|not a database|disk image/i.test(msg)) {
    try {
      const { DB_PATH } = await import("./config.js");
      const d = (await import("./db-problem.js")).describeDbFailure(DB_PATH, e);
      console.error(`${d.problem}\nFix: ${d.fix}`);
      process.exit(1);
    } catch {
      /* fall through to the plain message */
    }
  }
  console.error(msg);
  process.exit(1);
});
