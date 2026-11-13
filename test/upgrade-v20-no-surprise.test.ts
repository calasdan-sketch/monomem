// 1.4.0 non-negotiable: upgrading a v19 store hides nothing. Notes that existed before the upgrade (grandfathered) are not
// unconfirmed, not held out of session start, not refused for pinning, and add no count line, even 1.3.5 stamped summaries.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, needsHumanConfirm } from "../src/store.js";
import { injectContext } from "../src/context-inject.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { setProcessWriter } from "../src/actor.js";
import { downgradeTo } from "./legacy-db.js";

const noGit = { branch: "", diffFiles: [] };
afterEach(() => setProcessWriter(""));

function quietOpen(path: string): Store {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    return new Store(path);
  } finally {
    console.error = quiet;
  }
}

describe("upgrade-v20-no-surprise", () => {
  test("a v19 store with stamped summaries and an open browsing session: nothing held, nothing refused after the upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v20-ns-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      // A 1.3.5 session that read the web and has not ended (outside_at did not exist then).
      recordEvent(s0, normalizeHookInput("post-tool", { session_id: "old", cwd: "C:/w", tool_name: "WebFetch", tool_response: "page" }), "default");
      s0.captureDb().prepare("UPDATE sessions SET outside_at = NULL").run();
      setProcessWriter("stdio");
      const plain = s0.create({ title: "deploy guide", body: "run the pipeline" });
      setProcessWriter("");
      const sum = s0.create({ title: "web summary", body: "notes from a page", tags: ["summary", "obs.type:session", "obs.origin:tool:WebFetch"] }, { kind: "summary", sessionId: "old" });
      s0.close();
      downgradeTo(path, 19);
      const s = quietOpen(path);
      try {
        for (const id of [plain.id, sum.id]) {
          const n = s.read(id)!;
          assert.ok(n.grandfathered_at, `#${id} grandfathered`);
          assert.equal(n.unconfirmed, undefined, `#${id} not unconfirmed`);
          assert.ok(!needsHumanConfirm(n), `#${id} promotable as before`);
        }
        assert.equal(s.unconfirmedCount(), 0);
        const ctx = await injectContext(s, { signals: noGit });
        assert.ok(!/wait for confirmation|waits for confirmation/.test(ctx), "no count line");
        assert.match(ctx, /deploy guide/);
        assert.match(ctx, /Latest session summary/, "the stamped summary keeps its 1.3.5 title-only treatment");
        // An admin (REST, dashboard) may still pin the old stamped summary, as in 1.3.5.
        assert.ok(s.setPinned(sum.id, true));
        // The pre-upgrade session carries no outside_at, so new writes are not marked by it either.
        setProcessWriter("stdio");
        assert.equal(s.create({ title: "after upgrade" }).unconfirmed, undefined);
      } finally {
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a grandfathered note edited with new outside content loses the exemption (the new text was never checked)", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const n = s.create({ title: "old fact", body: "a" });
    s.captureDb().prepare("UPDATE notes SET grandfathered_at = '2026-01-01T00:00:00.000Z'").run();
    const plainEdit = s.update(n.id, { body: "b" })!;
    assert.ok(plainEdit.grandfathered_at, "an ordinary edit keeps it");
    const e = s.update(n.id, { body: "c from a page", outside: true })!;
    assert.equal(e.grandfathered_at, undefined);
    assert.equal(e.unconfirmed, true);
    s.close();
  });
});
