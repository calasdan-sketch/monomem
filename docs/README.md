# Monomem guides

Pick by what you want to do. Everything here is also linked from the main [README](../README.md).

## Do this

| I want to... | Read |
|---|---|
| connect my apps in a minute | [INSTALL.md](../INSTALL.md), then [live-claude-code.md](./live-claude-code.md) if something goes wrong |
| let my coding agent install Monomem, or fix what `monomem check` warns about | [install-with-your-agent.md](./install-with-your-agent.md) |
| see which apps setup connects, where each keeps its settings, and what happens when I install one later | [apps.md](./apps.md) |
| back up my notes, or restore a backup | [backups.md](./backups.md) |
| give an app its own key and a limit on what it can see | [give-an-app-limited-access.md](./give-an-app-limited-access.md) |
| mark a note `private` so only some apps see it | [sensitivity-labels.md](./sensitivity-labels.md) |
| keep one app inside one folder of notes | [token-namespaces.md](./token-namespaces.md) |
| reach Monomem from my phone or the web | [INFRA.md](../INFRA.md) |
| connect claude.ai or ChatGPT over the internet (off by default) | [oauth.md](./oauth.md) |
| have Claude Code recall notes at the start of a session | [sessionstart-hook.md](./sessionstart-hook.md) |
| bring in Claude Code's own memory, Codex memories, a Notion export or another memory tool (held until I confirm) | [switching.md](./switching.md) |
| move notes in or out, or keep them in git | [file-sync.md](./file-sync.md), [switching.md](./switching.md) |
| replace a wrong note, or undo an edit | [replacing-memories.md](./replacing-memories.md) |
| see what a bad note touched, and undo it with what was built on it | [what-a-note-touched.md](./what-a-note-touched.md) |
| encrypt the notes or let old ones expire | [encryption-retention.md](./encryption-retention.md) |
| check my memory's health, find personal data, scrub old deletions, import rules files, read the audit log | [checkups.md](./checkups.md) |
| show it off in 90 seconds | [demo-script.md](./demo-script.md) |
| upgrade, or remove Monomem completely | [upgrading.md](./upgrading.md), [footprint.md](./footprint.md) |

## Understand this

| I want to know... | Read |
|---|---|
| everything Monomem does, in detail | [features.md](./features.md) |
| what it does not do, every limit we know of | [known-limits.md](./known-limits.md) |
| how it compares with other memory tools | [comparison.md](./comparison.md) |
| how the pieces fit together | [architecture.md](./architecture.md) |
| who wrote a note, and what can be trusted | [provenance.md](./provenance.md), [trust.md](./trust.md) |
| how a note checks itself against the code (claims, line citations) | [claim-checks.md](./claim-checks.md) |
| ask me before a push or an unknown web request once a session read outside content (opt-in) | [action-guard.md](./action-guard.md) |
| new writers on probation, and notes that cite what was observed | [trust.md](./trust.md#new-writers-16) |
| how notes are found | [search.md](./search.md) |
| what the safety scan catches | [memory-linter.md](./memory-linter.md) |
| what changed while I was away | [change-feed.md](./change-feed.md) |
| which git commits used a note, and how notes stay on their branch | [commits-and-branches.md](./commits-and-branches.md) |
| what is measured, and what is not | [BENCHMARK.md](./BENCHMARK.md) |
| whether to switch on passage pooling (off by default) | [BENCHMARK.md](./BENCHMARK.md#passage-pooling-opt-in-measured-2026-11-17) |
| what it costs in tokens and disk | [footprint.md](./footprint.md) |
| what it does not protect against | [SECURITY.md](../SECURITY.md) |
| how it maps to OWASP ASI06, and what published attacks get through | [security-scorecard.md](./security-scorecard.md) |

## Look this up

| I need... | Read |
|---|---|
| every setting (environment variables) | [configuration.md](./configuration.md) |
| every MCP tool, its token cost, and every command | [tools.md](./tools.md) |
| the task board, claims and handoffs | [tasks.md](./tasks.md) |
| the release notes | [CHANGELOG.md](../CHANGELOG.md) |
| how an agent should use the memory | [SKILL.md](../SKILL.md) |
