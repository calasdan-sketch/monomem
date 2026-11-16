#!/usr/bin/env node
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseFlags, str, terminalIO } from "./cli/shared.js";
import { gatePinned, gateOutside, requireOperator } from "./operator-gate.js";
import { actorStore, setProcessWriter } from "./actor.js";
import type { RestatedNote } from "./search-service.js";
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
  "encrypt", "meter", "receipts", "why", "never-show", "supersede", "history", "pin", "unpin", "rollback", "bench", "drill", "health", "audit", "verify-receipt",
  "add", "show", "ls", "forget", "edit", "connect", "open", "label", "scrub", "purge-deleted", "pii", "digest", "safety-report", "demo", "snippet", "confirm", "review", "taint", "config", "service", "stale", "project-rules",
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

/**
 * Words people type first that are not commands. Each gets the real commands as a hint; nothing runs (no aliases: approve
 * and distrust are trust decisions, so the person types the full command and sees what it does).
 */
const VERB_HINTS: Record<string, string> = {
  undo: [
    "There is no 'undo' command. What do you want to undo?",
    "  An edit to one note:            monomem history <id>, then  monomem history restore <id> <version>",
    "  Everything one agent did:       monomem rollback --writer <writer> --since 1h   (shows the plan first)",
    "  A replacement (supersede):      monomem supersede undo <id>",
    "  A forgotten note:               monomem restore <id>",
    "  The last setup run:             monomem setup --undo",
  ].join("\n"),
  approve: "There is no 'approve' command. To approve a held write: monomem quarantine approve <id>   (see them: monomem quarantine list)",
  reject: "There is no 'reject' command. To reject a held write: monomem quarantine reject <id>   (see them: monomem quarantine list)",
  distrust:
    "There is no 'distrust' command. To leave a writer's notes out of every read: monomem trust distrust <writer> --namespace '*'\n" +
    "  A local app's notes are written by stdio:<app> (for example stdio:cursor); monomem show <id> prints a note's writer.",
};

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
      "  stale --code            Notes about files that changed in git since they were written",
      "  project-rules [--dry-run]   Copy notes a person confirmed or pinned into this repo's AGENTS.md block (asks first)",
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
      "  service install|status|uninstall [--print]   Keep the server running in the background after you sign in",
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
      "  service install|status|uninstall [--print]",
      "            Run the server in the background from sign-in: a Task Scheduler task (Windows), a LaunchAgent (macOS) or a",
      "            systemd --user unit (Linux), each running this node with this cli.js; output in <data>/server.log.",
      "            --print shows the file and the commands and changes nothing. setup never installs one.",
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
      "  hook <session-start|user-prompt|post-tool|post-tool-failure|stop|subagent-stop|session-end|pre-compact|file-context> [--db <file>]",
      "            Automatic memory: the agent's lifecycle hooks (hook JSON on stdin). Records what the agent does, redacted,",
      "            on this machine only, and distills it into observations and a session summary. Always exits 0.",
      "            Off switch: MONOMEM_CAPTURE=off. When: installed by `monomem setup --capture`.",
      "            file-context (PreToolUse on Read) lists what memory knows about the file, once per session; it never",
      "            blocks or changes the Read. pre-compact (Claude Code PreCompact) saves the session so far as its summary.",
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
      "  import --from claude-code-chats [--path ~/.claude/projects] [--dry-run] [--yes] [--namespace ns]",
      "            Make your past Claude Code conversations searchable: one note per message (what you typed and Claude's",
      "            replies; no tool output), each with the message it replied to. Goes into the \"chats\" namespace and is",
      "            never shown at session start; find it with search. Secrets skipped, re-runs add only what is new.",
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
      "            Also lists notes agents flagged and notes whose files changed in git; review keep <id> keeps one as it is.",
      "  stale --code [--ns <namespace>] [--json]",
      "            Notes written about files (state_write files) that a later commit changed, with the files and the commit",
      "            each note was written against. Compares with the committed code (HEAD), on this computer only.",
      "  project-rules [--file AGENTS.md|CLAUDE.md] [--ns <namespace>] [--dry-run]",
      "            Copy the notes a person confirmed or pinned into a fenced block of this repository's AGENTS.md (or",
      "            CLAUDE.md), for apps that read only rules files. Left out: anything unconfirmed, admin- or agent-confirmed,",
      "            distrusted, disputed, flagged, about changed code, private, or flagged by the linter. Shows the change and asks",
      "            you to type yes at a terminal; only the block is ever written. Monomem never writes these files otherwise.",
      "  taint clear [--all | --session <id> | --here]",
      "            Ends the open outside-content windows (a hooked session read the web: local apps' notes written meanwhile are",
      "            marked). Run it in a terminal and type yes. Marks already written stay; nothing is deleted.",
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
      "  show <id> | ls [--ns x] [--limit 20] [--archived] [--include-distrusted] | edit <id> [- | --editor] | forget <id>",
      "            Read, list, change (in $EDITOR, refused if the note changed meanwhile) or archive a note. The CLI is you, the owner: sensitivity limits apply to apps, not to it.",
      "            edit <id> - reads the new text from a pipe (first line the title); without a terminal edit needs - or --editor.",
      "            ls --archived lists forgotten notes with the restore <id> that brings each back.",
      "  audit [--since 24h] [--op create|update|delete|...] [--label <key name>] [--limit n] [--json]",
      "            Who changed what: the change log in plain words (never note text).",
      "  audit verify [--expect <head-hash> | --checkpoint <file>] [--all-signatures] [--strict]",
      "            Walk the audit log's hash chain and its Ed25519 signatures (the store key, .attest-key) and report the first",
      "            broken line or bad signature. Keep the printed head hash off this machine (a git commit, a password manager).",
      "            --expect <hash> / --checkpoint <file> exit 1 if that line is no longer in the log (rewritten or cut off); the",
      "            log growing past it is fine. --all-signatures checks every line (default: the newest, the anchor and key",
      "            hand-overs); --strict also fails on unsigned lines after signing began. Usage errors exit 2.",
      "  audit checkpoint [--out <file>]   The log head as a signed checkpoint: keep it off this machine.",
      "  verify-receipt <seq> <chain_hash>  |  verify-receipt --file <receipt.json> [--pubkey <file|base64url>] [--note <id>]",
      "            Check the signed receipt a write returned (accepted, held or refused). With --pubkey: the signature only,",
      "            offline, no store needed. Without: also that its line is still in the unbroken, signed audit log. --note:",
      "            whether the note still has the content the receipt names. Exits 1 when it does not verify; usage errors 2.",
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
      "  encrypt <enable|status [--surfaces] [--json]|disable>",
      "            enable   Create the AES-256-GCM key and encrypt every note",
      "                     body at rest. Keyword search then covers title+tags",
      "                     only (bodies cannot be indexed as ciphertext).",
      "            status   Report whether at-rest encryption is on, the key",
      "                     path, and how many bodies are encrypted. --surfaces lists",
      "                     every place note text can exist and whether it is encrypted now.",
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
      "  bench [--json] [--suite stale|contradiction|isolation|provenance|poison] [--only id] [--seed n] [--dir folder] [--strict-gaps] [--verbose]",
      "            Run the provenance benchmark on a throwaway store: stale memory, contradiction recovery,",
      "            permission isolation, provenance retention, memory poisoning. Offline, deterministic, exits 1 on a failure.",
      "            Your own data is never touched. See docs/BENCHMARK.md.",
      "  bench --scale 10k [--json]",
      "            Speed on a synthetic store (temp folder): session start, search and write p50/p95, plain and",
      "            encrypted. Exits 1 at 10k+ notes when encrypted session start p50 is 50 ms or more.",
      "  bench --longmemeval | --locomo [--data file] [--limit n] [--mode keyword|hybrid] [--granularity session|turn] [--encrypted] [--split a|b] [--json]",
      "            Retrieval benchmark (recall@k, nDCG, MRR) on a public dataset, in a temp folder. No LLM.",
      "            --split a|b runs half the data: LongMemEval-S by a hash of the question id, LoCoMo by conversation",
      "            (1-5 = a, 6-10 = b): tune on one half, check on the other.",
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
    const { semanticNotice, runSearch, restatedFlag } = await import("./search-service.js");
    const { BODY_INDEX_MAX_NOTES } = await import("./store/body-index.js");
    if (modeRaw !== undefined && !["keyword", "semantic", "hybrid"].includes(modeRaw)) {
      console.error("--mode must be keyword, semantic or hybrid");
      process.exit(1);
    }
    const notice = semanticNotice(modeRaw);
    const restatedJson = (n: RestatedNote) => (n.restated_by !== undefined ? { restated_by: n.restated_by } : {});
    // One extra hit is fetched to tell whether the list was cut, so the output can say how to see more.
    const want = limit ?? 5;
    const moreLine = (shown: number, cut: boolean): void => {
      if (cut) console.log(`Showing ${shown}; more notes match. More: --limit ${Math.min(200, want * 2)}`);
    };
    // "No relevant notes found." while the match is hidden by the distrust list reads as an empty store: count the hidden
    // matches by running the same search with them (only when a distrust rule exists; the search reads, nothing more).
    const hiddenLine = async (search: (opts: { includeDistrusted: true }) => Promise<Array<{ distrusted?: true }>>): Promise<void> => {
      if (includeDistrusted || store.distrustRules().length === 0) return;
      const n = (await search({ includeDistrusted: true })).filter((x) => x.distrusted).length;
      if (n > 0) console.log(`${n} matching note${n === 1 ? "" : "s"} hidden because ${n === 1 ? "its" : "their"} writer is distrusted. See who: monomem trust list. Show ${n === 1 ? "it" : "them"}: add --include-distrusted`);
    };
    // Encrypted bodies are searched through the in-memory body index (C-06). When it is off or the store is above its size
    // cap, search sees titles and tags only: an empty result must not read as "nothing mentions it".
    const sealedLine = (): void => {
      const idx = store.bodyIndexInfo().state;
      if (idx === "ready") return;
      const n = store.encryptedCount();
      if (n > 0) console.log(`${n} note${n === 1 ? " has an encrypted body" : "s have encrypted bodies"}: their body text was not searched (titles and tags were)${idx === "too large" ? `: the in-memory body index is not built above ${BODY_INDEX_MAX_NOTES.toLocaleString("en-US")} notes` : idx === "off" ? ": MONOMEM_BODY_INDEX=off" : ""}.`);
    };
    if (modeRaw && process.argv[2] === "search" && message.trim()) {
      // `search --mode` is the full search (the one that can use embeddings); `relevant` stays the keyword-extraction search.
      const opts = { namespace, limit: want + 1, mode: modeRaw as "keyword" | "semantic" | "hybrid", ...(writtenBy ? { writtenBy } : {}), ...(notWrittenBy ? { notWrittenBy } : {}) };
      const all = await runSearch(store, message, { ...opts, ...(includeDistrusted ? { includeDistrusted: true } : {}) });
      const hits = all.slice(0, want);
      if (asJson) return void console.log(JSON.stringify({ ...(notice ? { notice } : {}), results: hits.map((n) => ({ id: n.id, namespace: n.namespace, title: n.title, ...(n.distrusted ? { distrusted: true } : {}), ...restatedJson(n) })) }, null, 2));
      if (notice) console.log(`Note: ${notice}`);
      if (!hits.length) {
        console.log("No matching notes found.");
        sealedLine();
      }
      else console.log(`Matching notes (${hits.length}):`);
      for (const n of hits) {
        console.log(`  #${n.id} [${printable(n.namespace, 100)}] ${printable(n.title)}${restatedFlag(n)}${n.distrusted ? " [DISTRUSTED WRITER: treat as hostile]" : ""}`);
        if (n.body.trim()) console.log(`      ${printable(n.body.replace(/\s+/g, " ").trim(), 100)}`);
      }
      moreLine(hits.length, all.length > want);
      await hiddenLine((x) => runSearch(store, message, { ...opts, ...x }));
      return;
    }
    if (notice && !asJson) console.log(`Note: ${notice}`);
    const relOpts = { namespace, limit: want + 1, ...(writtenBy ? { writtenBy } : {}), ...(notWrittenBy ? { notWrittenBy } : {}) };
    const { keywords, results: fetched } = await runRelevantSearch(store, message, { ...relOpts, ...(includeDistrusted ? { includeDistrusted: true } : {}) });
    const results = fetched.slice(0, want);
    if (asJson) {
      return void console.log(
        JSON.stringify(
          {
            ...(notice ? { notice } : {}),
            keywords,
            results: results.map((n) => ({ id: n.id, namespace: n.namespace, title: n.title, updated_at: n.updated_at, written_by: n.written_by, ...(n.distrusted ? { distrusted: true } : {}), ...(n.unconfirmed ? { unconfirmed: true } : {}), ...(n.expired ? { expired: true } : {}), ...(n.built_on_distrusted ? { built_on_distrusted: true } : {}), ...restatedJson(n) })),
          },
          null,
          2
        )
      );
    }
    console.log(`Keywords: ${keywords.length > 0 ? keywords.join(", ") : "(none)"}`);
    if (results.length === 0) {
      console.log("No relevant notes found.");
      sealedLine();
    }
    else console.log(`Relevant notes (${results.length}):`);
    for (const n of results) {
      const ann = annotateStaleness(n);
      const stale = ann.stale ? ` [stale, ${ann.ageDays}d]` : "";
      console.log(`  #${n.id} [${printable(n.namespace, 100)}] ${printable(n.title)}${stale}${noteFlags(n)}${restatedFlag(n)}${n.distrusted ? " [DISTRUSTED WRITER: treat as hostile]" : ""}`);
      if (n.body.trim()) console.log(`      ${printable(n.body.replace(/\s+/g, " ").trim(), 100)}`);
    }
    moreLine(results.length, fetched.length > want);
    await hiddenLine(async (x) => (await runRelevantSearch(store, message, { ...relOpts, ...x })).results);
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
    // Grouped by who the server stamped as the writer, not by the source a writer claims for itself (any app can claim one).
    for (const [w, n] of Object.entries(page.byWriter)) {
      console.log(`  ${w ? printable(w, 100) : "(writer not recorded)"}: +${n.created} ~${n.updated} -${n.deleted}`);
    }
    // One page only (--limit entries, default 100): a long window is summed up above, not printed in full.
    // Except --since last: its marker moves only when the final page is read, so every page is printed.
    const isLast = (str(flags.since) ?? "").trim().toLowerCase() === "last";
    for (;;) {
      for (const e of page.changes) {
        const mark = e.kind === "created" ? "+" : e.kind === "updated" ? "~" : "-";
        // A note born in the window and changed since is reported once, as created, with its LAST writer: say so, or a person's
        // note an agent edited reads as the agent creating it and claiming the person's source.
        const later = e.kind === "created" && (e.rev ?? 1) > 1;
        // The claimed source adds nothing when it is the stamped writer's own name ("by cli, claims cli").
        const sameAsWriter = !!e.source && (e.source === e.written_by || `stdio:${e.source}` === e.written_by);
        const by = later
          ? `, new in this window and changed since; last by ${printable(e.written_by || "unknown", 100)}${e.source ? `, source "${printable(e.source, 100)}"` : ""}`
          : `${e.written_by ? `, by ${printable(e.written_by, 100)}` : ""}${e.source && !sameAsWriter ? `, claims "${printable(e.source, 100)}"` : ""}`;
        console.log(`${mark} #${e.id} [${printable(e.namespace, 100)}] ${printable(e.title)}  (${e.at}${by})${e.distrusted ? " [DISTRUSTED WRITER]" : ""}`);
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

/**
 * R2-07 `monomem project-rules [--file AGENTS.md|CLAUDE.md] [--ns <ns>] [--dry-run]`: the person-confirmed notes into a fenced
 * block of this repository's rules file. Shows the diff, then a typed yes at a terminal (requireOperator); --dry-run only shows.
 */
async function projectRulesCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["file", "ns", "namespace"], bools: ["dry-run"] });
  const { RULES_FILES, planProjectRules, currentBlock, FENCE_BEGIN } = await import("./project-rules.js");
  const file = typeof flags.file === "string" ? flags.file : "AGENTS.md";
  if (rest.length || !(RULES_FILES as readonly string[]).includes(file)) {
    console.error(`Usage: monomem project-rules [--file ${RULES_FILES.join("|")}] [--ns <namespace>] [--dry-run]   (writes only in this repository's top folder)`);
    process.exit(1);
  }
  const { execFileSync } = await import("node:child_process");
  let root = "";
  try {
    root = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* not a repository */
  }
  if (!root) {
    console.error("Refused: run project-rules inside a git repository; it writes that repository's rules file and nothing else.");
    process.exit(1);
  }
  let ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
  if (ns === undefined) {
    const { resolveRecallNamespace } = await import("./recall.js");
    const res = await resolveRecallNamespace(process.cwd());
    if (res.kind === "unresolvable") {
      console.error("Refused: this folder's namespace could not be worked out (see the message above). Name one with --ns.");
      process.exit(1);
    }
    if (res.kind === "resolved") ns = res.namespace;
  }
  const { join } = await import("node:path");
  const path = join(root, file);
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const store = new Store(DB_PATH);
  let plan: ReturnType<typeof planProjectRules>;
  try {
    plan = planProjectRules(store, path, ns);
  } catch (e) {
    console.error(`Refused: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    store.close();
  }
  const { lineDiff } = await import("./line-diff.js");
  const show = (): void => {
    console.log(`${plan.lines.length} note${plan.lines.length === 1 ? " goes" : "s go"} into ${path}${ns !== undefined ? ` (namespace ${printable(ns, 60)})` : ""}; ${plan.left.length} left out.`);
    // No namespace is set for this folder, so every namespace's confirmed notes qualify: name them, and say how to narrow it.
    if (ns === undefined && plan.namespaces.length) {
      console.log(`  Drawn from every namespace (no namespace is set for this folder): ${plan.namespaces.map((n) => printable(n, 60)).join(", ")}. Keep it to one: --ns <namespace>`);
    }
    for (const l of plan.left.slice(0, 20)) console.log(`  left out #${l.id}: ${l.why}`);
    for (const l of lineDiff(currentBlock(plan.before), currentBlock(plan.after), 200)) console.log(`  ${l}`);
  };
  if (plan.after === plan.before) return void console.log(`${file} is already up to date. Nothing changed.`);
  if (!plan.lines.length && !(plan.before ?? "").includes(FENCE_BEGIN)) {
    return void console.log("No note qualifies yet (a person confirms one with monomem confirm <id>, or pins it). Nothing written.");
  }
  if (flags["dry-run"] === true) {
    show();
    return void console.log("Dry run: nothing was written.");
  }
  await requireOperator(`write ${plan.lines.length} note${plan.lines.length === 1 ? "" : "s"} into the Monomem block of ${path}`, show);
  const { writeFileSync, renameSync, existsSync, readFileSync } = await import("node:fs");
  if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== plan.before) {
    console.error(`Refused: ${path} changed while you were reading the diff. Nothing written; run it again.`);
    process.exit(1);
  }
  const tmp = `${path}.monomem-${process.pid}.tmp`;
  writeFileSync(tmp, plan.after);
  renameSync(tmp, path);
  console.log(`Wrote the Monomem block in ${path}. Text outside the block is unchanged. Run it again after confirming or changing notes.`);
}

/** `monomem config [get | set confirm-days <n> | set confirm-mode off|label|enforce]`: settings kept in the store. */
/**
 * `monomem taint clear [--all | --session <id> | --here]`: a person ends the open outside-content windows (the periods in which a
 * hooked session read the web and local apps' notes are marked). It lowers protection, so it needs a terminal and a typed yes.
 * Stamps already written stay; nothing is deleted.
 */
async function taintCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem taint clear [--all | --session <id> | --here]";
  const [verb, flag, val, ...extra] = args;
  const ok = verb === "clear" && !extra.length && ((flag === "--all" || flag === "--here") && val === undefined ? true : flag === "--session" && typeof val === "string" && val.length > 0);
  if (!ok) {
    console.error(usage);
    process.exit(1);
  }
  await requireOperator(`taint clear ${flag === "--session" ? `--session ${val}` : flag}`);
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const n = store.taintClear(flag === "--all" ? { all: true } : flag === "--here" ? { cwd: process.cwd() } : { session: val as string });
    console.log(n ? `Closed ${n} open outside-content window${n === 1 ? "" : "s"}. Notes already marked keep their mark.` : "No open outside-content window matched. Nothing changed.");
  } finally {
    store.close();
  }
}

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
  // `restore <id> <version>` is how people guess "put back an older text". That is `history restore`; this command only
  // brings back an archived note. Do nothing and name the right one.
  const version = process.argv[4];
  if (action === "restore" && version !== undefined && /^\d+$/.test(version)) {
    console.error(
      `monomem restore <id> brings back an archived note; it takes no version, so nothing was changed.\n` +
        `To put back version ${version} of note #${id}: monomem history restore ${id} ${version}   (see the versions: monomem history ${id})`
    );
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
/** One sentence, the same in `encrypt status`, `encrypt enable` and docs/encryption-retention.md (recall.ts askServerForBodyHits). */
const HOOK_BODY_INDEX = "The session-start hook never builds the body index; it uses a running Monomem server's index for this store if there is one, else it matches titles and tags.";
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
    console.error("Usage: monomem encrypt <enable|status [--surfaces] [--json]|disable>");
    process.exit(1);
  }

  if (action === "status") {
    const store = new Store(DB_PATH); // opening restores a key stranded by a crashed `disable`
    const enabled = crypto.encryptionEnabled(keyDir);
    const keyFile = crypto.keyPath(keyDir);
    try {
      if (process.argv.includes("--surfaces")) {
        // C-04: every place note content can exist, from counts on this store (docs/encryption-retention.md says the same).
        const { DATA_DIR } = await import("./config.js");
        const rows = store.encryptionSurfaces({ dataDir: DATA_DIR, dbPath: DB_PATH });
        if (process.argv.includes("--json")) return void console.log(JSON.stringify({ key: enabled, key_file: keyFile, surfaces: rows }, null, 2));
        console.log(`encryption key: ${enabled ? keyFile : "none (monomem encrypt enable)"}`);
        const w = Math.max(...rows.map((r) => r.surface.length));
        const count = (r: (typeof rows)[number]): string => (r.encrypted !== "nothing stored" && (r.sealed !== undefined || r.plain !== undefined) ? ` (${r.sealed !== undefined ? `${r.sealed} sealed, ` : ""}${r.plain ?? 0} plain)` : "");
        for (const r of rows) console.log(`  ${r.surface.padEnd(w)}  ${(r.encrypted + count(r)).padEnd(34)}  ${r.detail}`);
        console.log("Encryption here is confidentiality only: it does not stop an older sealed copy being put back. Whole-disk encryption covers titles, the index and logs too.");
        return;
      }
      const sealed = store.encryptedCount();
      // Sealed bodies with no key is not "off": it is on with the key gone (doctor FAILs on the same state).
      console.log(
        enabled ? "encryption: on" : sealed > 0 ? `encryption: on, but the key file is missing at ${keyFile}: ${sealed} note bod${sealed === 1 ? "y" : "ies"} cannot be read until you restore it from your backup (check: monomem doctor)` : "encryption: off"
      );
      console.log(`key file:   ${keyFile}${enabled ? "" : " (not present)"}`);
      console.log(`encrypted bodies: ${sealed}`);
      const plain = store.plaintextBodyCount();
      console.log(`plaintext bodies: ${plain}${enabled && plain > 0 ? "  (seal them: monomem encrypt enable)" : ""}`);
      if (enabled) {
        console.log(
          "note: the on-disk search index holds titles and tags only. Body search uses an index kept in memory by each Monomem " +
            "process that searches (servers build it at start). " + HOOK_BODY_INDEX + " The system can page that memory to swap or a hibernation file: use whole-disk encryption too. " +
            "MONOMEM_BODY_INDEX=off turns it off. Details: monomem encrypt status --surfaces"
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
      console.log(
        "Body search keeps working from an index held in memory only (never on disk). " + HOOK_BODY_INDEX + " " +
          "That memory can reach swap or a hibernation file: use whole-disk encryption too (monomem encrypt status --surfaces)."
      );
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
  console.log("Key file removed. Bodies are plain again and in the on-disk search index; no in-memory body index is kept.");
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
    // The gates run inside the command, on the ids its own parser chose (a pinned note it would change; outside content
    // it would promote: pin, or replace with it, which records your yes as a human confirm). See CliIO.gate.
    gate: async (g: "pinned" | "outside", ids: number[], what: string): Promise<void> =>
      g === "pinned" ? gatePinned(store, ids, what) : gateOutside(store, ids, what),
  };
  const store = new Store(DB_PATH);
  try {
    const args = process.argv.slice(3);
    if (kind === "unpin") await requireOperator(`unpin ${args[0] ?? ""}`.trim());
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
    const hint = Object.hasOwn(VERB_HINTS, cmd.toLowerCase()) ? VERB_HINTS[cmd.toLowerCase()] : undefined;
    if (hint) {
      console.error(hint);
      process.exit(1);
    }
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
  // doctor on a machine with no data folder (never set up, or after uninstall --purge) says so and creates nothing.
  if (cmd === "doctor" && (await (await import("./doctor/index.js")).notSetUp())) return;
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
      await (await import("./doctor/index.js")).doctor(fileURLToPath(import.meta.url));
      break;
    case "init":
      await (await import("./cli/connect.js")).init(fileURLToPath(import.meta.url));
      break;
    case "setup":
      await (await import("./cli/connect.js")).setupCmd(fileURLToPath(import.meta.url));
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
      await (await import("./cli/trust.js")).trustCmd();
      break;
    case "token":
      await (await import("./cli/trust.js")).tokenCmd();
      break;
    case "quarantine":
      await (await import("./cli/trust.js")).quarantineCmd();
      break;
    case "approve-first":
      await (await import("./cli/trust.js")).approveFirstCmd();
      break;
    case "confirm":
      await (await import("./cli/trust.js")).confirmCmd(process.argv.slice(3));
      break;
    case "review":
      await (await import("./cli/trust.js")).reviewCmd(process.argv.slice(3));
      break;
    case "project-rules":
      await projectRulesCmd(process.argv.slice(3));
      break;
    case "stale": {
      // R2-03: notes whose anchored files changed in git since they were written.
      const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["ns", "namespace"], bools: ["code", "json"] });
      if (rest.length || flags.code !== true) {
        console.error("Usage: monomem stale --code [--ns <namespace>] [--json]");
        process.exit(1);
      }
      const ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
      const { DB_PATH } = await import("./config.js");
      const { Store } = await import("./store.js");
      const store = new Store(DB_PATH);
      try {
        const list = store.codeChangedList(ns !== undefined ? [ns] : undefined);
        if (flags.json === true) console.log(JSON.stringify({ code_changed: list }, null, 2));
        else if (!list.length) console.log("No note is about code that changed since it was written.");
        else (await import("./cli/trust.js")).printCodeChanged(list);
      } finally {
        store.close();
      }
      break;
    }
    case "taint":
      await taintCmd(process.argv.slice(3));
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
      // `audit verify` is the signed hash-chain check, `audit checkpoint` its portable anchor; anything else is the
      // plain-words viewer of who changed what.
      const sub = process.argv[3];
      if (sub === "verify") await (await import("./audit-cli.js")).auditVerifyCmd(process.argv.slice(4));
      else if (sub === "checkpoint") await (await import("./audit-cli.js")).auditCheckpointCmd(process.argv.slice(4));
      else if (sub?.startsWith("--") && sub !== "--expect") await (await import("./phase-b-cli.js")).auditCmd();
      else {
        console.error("Usage: monomem audit verify [--expect <head-hash>] [--checkpoint <file>] [--all-signatures] [--strict]   |   monomem audit checkpoint [--out <file>]   |   monomem audit --since 24h [--op create|update|delete] [--label <key>] [--limit n] [--json]");
        process.exit(2);
      }
      break;
    }
    case "verify-receipt":
      // R2-06 + round 3: a write receipt is a signed audit-log line; see audit-cli.ts.
      await (await import("./audit-cli.js")).verifyReceiptCmd(process.argv.slice(3));
      break;
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
      await (await import("./cli/trust.js")).tokenCmd();
      break;
    case "connect":
      await (await import("./cli/connect.js")).connectCmd(fileURLToPath(import.meta.url));
      break;
    case "service": {
      const { flags, rest } = parseFlags(process.argv.slice(3), { values: [], bools: ["print"] });
      const { DATA_DIR } = await import("./config.js");
      const { homedir } = await import("node:os");
      const { serviceCmd } = await import("./service.js");
      // final-security SF4: a service that starts at every logon with a wider bind (or extra allowed hosts) is a lasting
      // exposure an agent's shell must not set up on its own. A loopback-only service stays ungated.
      const { isLoopback } = await import("./config.js");
      if (rest[0] === "install" && !flags.print && (!isLoopback(process.env.MONOMEM_BIND?.trim() || "127.0.0.1") || process.env.MONOMEM_ALLOWED_HOSTS?.trim())) {
        await requireOperator("service install (a background server reachable beyond this computer)");
      }
      process.exitCode = serviceCmd(rest[0], flags.print === true, {
        platform: process.platform,
        node: process.execPath,
        cli: fileURLToPath(import.meta.url),
        home: homedir(),
        dataDir: DATA_DIR,
        uid: process.getuid?.(),
        env: process.env,
      });
      break;
    }
    case "open":
      await (await import("./cli/connect.js")).openCmd(fileURLToPath(import.meta.url));
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
      if (args.includes("--scale")) {
        // Same isolation as the retrieval bench: scale.js moves MONOMEM_HOME to a temp folder before config.js loads.
        const { scaleMain } = await import("./bench/scale.js");
        process.exitCode = await scaleMain(args);
        break;
      }
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
      if (sub && Object.hasOwn(VERB_HINTS, sub.toLowerCase())) console.log(VERB_HINTS[sub.toLowerCase()]);
      else if (sub && sub !== "all" && !sub.startsWith("-") && helpFor(sub)) printCommandHelp(sub);
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
