# SignPath Foundation (free code signing for open-source) - application DRAFT

STATUS: drafted, NOT submitted. Needs Dan's decision and his own account details. Nothing here has been sent.
Check the current rules before applying: https://signpath.org/ (the open-source / SignPath Foundation page). The terms below are
from memory of how the programme worked and are unverified; confirm each one.

## What the programme offers (unverified)
Free Authenticode signing for qualifying open-source projects, under the SignPath Foundation certificate (so the publisher shown is
"SignPath Foundation", not Calas Automations). Signing runs from CI (GitHub Actions) through the SignPath connector; the signed
file comes back into the workflow.

## Likely requirements to confirm before sending
- OSI-approved licence, no commercial dual licensing: MIT, fits.
- Public repository, built from source in CI: yes (bundle.yml).
- Released, maintained project that does nothing malicious; a "what it does / privacy" statement is expected.
- The signed file must be built by an automated pipeline from the repo (no manual uploads): bundle.yml does this on a tag.
- Named roles (author, reviewer, approver). One person can hold all three in a one-person project; they may ask about it.
- A "Code signing policy" section on the project page saying who may request signing (README).

## Draft application text
Project name: Monomem
Repository: https://github.com/calasdan-sketch/monomem
Licence: MIT
Description: Monomem is shared local memory for AI coding agents. It runs on the user's computer, keeps notes in a local SQLite
file, and gives them to apps (Claude Code, Cursor and others) over MCP. It makes no outgoing network calls by default and has two
runtime npm dependencies.
Why signing: the standalone Windows download is a zip with a launcher and a bundled Node. Unsigned programs trigger SmartScreen
warnings, and Windows 11 Smart App Control blocks them outright. Users of a security tool should not be asked to click through warnings.
What would be signed: the Windows executable built by .github/workflows/bundle.yml. Node's own node.exe keeps its OpenJS signature.
Build: GitHub-hosted runners, actions pinned by SHA, SHA256SUMS, GitHub build attestations, npm provenance and an SBOM per release.
Maintainer: Calas Automations Inc. (single maintainer; author, reviewer and approver are the same person).

## Work needed in the repo if accepted (NOT done)
1. Something signable. Today the Windows download is a `.cmd` launcher plus signed Node, and a `.cmd` cannot be Authenticode-signed.
   The single-file build (job `sea` in bundle.yml) exists but is unsigned, and the header of bundle.yml lists three code changes
   it needs before it can ship.
2. A signing step in bundle.yml using the SignPath GitHub connector, pinned by SHA, in its own least-privilege job.
3. The "Code signing policy" text in the README.

## Other zero-budget options
- Do nothing for Windows and keep the npm install path as the "no warning" route (the current state, documented in docs/verify.md).
- Azure Trusted Signing (Microsoft) is cheap but not free, with identity checks and regional limits: check it covers Canada.
- Mac: notarization needs the paid Apple Developer Program; there is no free route.
