// Round 4 docs findings (r4-honesty, r4-competition, r4-architecture, r4-release-gate): each doc line a seat found false
// or missing, pinned so it cannot drift back. Text checks only; the numbers they quote were measured by the seats.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";

const read = (p: string): string => readFileSync(join(PROJECT_ROOT, p), "utf8");
/** The [1.6.0] section of the CHANGELOG only. */
const changelog160 = (): string => {
  const c = read("CHANGELOG.md");
  const start = c.indexOf("## [1.6.0]");
  return c.slice(start, c.indexOf("\n## [", start + 5));
};

describe("OAuth is described as it ships (off by default, a preview), never as missing", () => {
  test("SECURITY.md has an OAuth section and no longer says there is no OAuth", () => {
    const sec = read("SECURITY.md");
    assert.doesNotMatch(sec, /there is no OAuth/i);
    const oauth = sec.slice(sec.search(/^#+ .*OAuth/m));
    assert.ok(sec.search(/^#+ .*OAuth/m) > 0, "an OAuth heading");
    for (const want of [/off by default/i, /pairing code/i, /never admin|never more|cannot delete/i, /MCP port/i, /one dedicated security review/i, /no outside review/i, /Tailscale Funnel/i, /docs\/oauth\.md/]) {
      assert.match(oauth.slice(0, 3000), want);
    }
  });

  test("SECURITY.md names the action guard, writer probation, known hosts, claim checks and NODE_OPTIONS", () => {
    const sec = read("SECURITY.md");
    assert.match(sec, /action guard[\s\S]{0,400}speed bump, not a sandbox/i);
    assert.match(sec, /probation/i);
    assert.match(sec, /known hosts/i);
    assert.match(sec, /claim checks?[\s\S]{0,600}git/i);
    assert.match(sec, /NODE_OPTIONS/);
  });

  test("SECURITY.md never calls an old OneMemory release 'OneMemory 1.6.0'", () => {
    assert.doesNotMatch(read("SECURITY.md"), /OneMemory 1\.6\.0/);
  });

  test("README, comparison and INFRA say claude.ai/ChatGPT can connect over OAuth (off by default, preview)", () => {
    for (const f of ["README.md", "docs/comparison.md", "INFRA.md"]) {
      const t = read(f);
      assert.doesNotMatch(t, /OAuth sign-in Monomem does not have|which Monomem does not have\s+yet|cannot connect yet/i, f);
      assert.match(t, /OAuth[^.]*off by default|off by default[^.]*OAuth/i, f);
      assert.match(t, /preview/i, f);
      assert.match(t, /oauth\.md/, f);
    }
  });
});

describe("comparison.md cells match their sources (re-read 2026-11-17)", () => {
  const c = () => read("docs/comparison.md");
  test("claude-mem names the originating agent ([via cursor], 15.19) and its app count is its README's", () => {
    const row = c().split("\n").find((l) => l.startsWith("| **claude-mem**"))!;
    assert.match(row, /\[via cursor\]/);
    assert.match(c(), /claude-mem[^.\n]*15/);
  });
  test("the Codex row quotes the 0.165.0 release line", () => {
    assert.match(c(), /Enabled memory v2 by default for fresh profiles/);
  });
  test("the Notion row claims only what its cited help page says", () => {
    const row = c().split("\n").find((l) => l.startsWith("| **Notion"))!;
    assert.doesNotMatch(row, /write-ups|launched 2026-11-04/i);
    assert.match(row, /Memories database/);
  });
  test("an ai-memory row, dated and sourced, with what it does not document", () => {
    const row = c().split("\n").find((l) => /^\| \*\*ai-memory\*\*/.test(l));
    assert.ok(row, "ai-memory row");
    assert.match(row!, /Ed25519|signed/i);
    assert.match(row!, /pending|approv/i);
    assert.match(row!, /PreToolUse/);
    assert.match(row!, /Rust/);
    assert.match(row!, /not documented/i);
    assert.match(c(), /alphaonedev\/ai-memory-mcp/);
  });
  test("agentmemory's count is what its README names, and 'behind' is the tunnel and the preview", () => {
    assert.doesNotMatch(c(), /about\s+thirty/);
    assert.match(c(), /agentmemory[^.]*26/);
    const behind = c().slice(c().indexOf("## Where Monomem is behind"));
    assert.match(behind, /HTTPS|tunnel/i);
    assert.match(behind, /preview/i);
  });
  test("never 'only' or 'first' about Monomem", () => {
    assert.doesNotMatch(c(), /\b(the )?only (tool|one|memory)\b|\bfirst to\b|\bbest\b|#1/i);
  });
});

describe("footprint.md lists every file and timer 1.6.0 adds", () => {
  test("data-folder files, app files, hooks and timers", () => {
    const f = read("docs/footprint.md");
    for (const want of ["oauth.json", "claude-import-state.json", "old-names-seen.json", "app-detect.json", "~/.cursor/hooks.json",
      "prepare-commit-msg", "mcp_config.json", "~/.kiro/settings/mcp.json", "cline_mcp_settings.json", "~/.copilot/mcp-config.json",
      "~/.gemini/config/mcp_config.json", "~/.qwen/settings.json", "opencode.json", "kilo.jsonc"]) {
      assert.ok(f.includes(want), `footprint.md should list ${want}`);
    }
    assert.doesNotMatch(f, /runs on the server thread, so a very large store pauses/);
    assert.match(f, /worker thread/);
    assert.match(f, /Claude Code memory refresh|Claude Code refresh/i);
    assert.match(f, /app check/i);
  });
});

describe("CHANGELOG [1.6.0]", () => {
  test("backup pause figure names its store; grade line is exact; a 'Not in 1.6.0' block; OAuth before downgrading", () => {
    const c = changelog160();
    assert.match(c, /324-351 ms/);
    assert.match(c, /"N held, N blocked, N stored with a warning"|8 held, 12 blocked, 4 stored with a warning/);
    assert.doesNotMatch(c, /"N blocked, M stored with a warning"/);
    const not = c.slice(c.indexOf("### Not in 1.6.0"));
    assert.ok(c.includes("### Not in 1.6.0"));
    for (const want of [/held-back-note/i, /sync between computers|P2P|peer/i, /Lighthouse/, /screen[- ]reader/i, /unseen/i, /start with my computer/i, /rec\(\)/, /side[- ]table helper/i, /Supermemory/, /Client ID Metadata|CIMD/, /mcp_tool/]) {
      assert.match(not, want);
    }
    assert.match(c, /monomem oauth off[^.]*before|before[^.]*monomem oauth off/i);
  });
});

describe("upgrading.md, trust.md, scorecard", () => {
  test("upgrading.md: OAuth off before going back, branch scope, reads, probation", () => {
    const u = read("docs/upgrading.md");
    assert.match(u, /monomem oauth off/);
    assert.match(u, /branch/i);
    assert.match(u, /no reads are recorded|records no reads|nothing is recorded/i);
    assert.match(u, /probation/i);
  });
  test("trust.md: export, sync and held-write approval drop evidence; facts-need-evidence is a nudge", () => {
    const t = read("docs/trust.md");
    assert.match(t, /evidence is not exported|export[^.]*drop[^.]*evidence|evidence[^.]*not[^.]*(exported|synced)/i);
    assert.match(t, /held[^.]*(drops|loses)[^.]*evidence|evidence[^.]*held write/i);
    assert.match(t, /nudge, not a check/i);
  });
  test("security-scorecard false-positive row is the 1.6.0 re-run", () => {
    const s = read("docs/security-scorecard.md");
    const row = s.split("\n").find((l) => l.startsWith("| Monomem CHANGELOG + docs"))!;
    assert.match(row, /1,637/);
    assert.match(row, /\b13\b/);
  });
  test("README's demo recording is labelled as older than the redesign, or gone", () => {
    const r = read("README.md");
    assert.ok(!r.includes("monomem-demo.gif") || /before the (dashboard )?redesign|older (recording|screenshot)/i.test(r));
  });
});
