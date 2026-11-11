// The model an app reports at session start is kept on the session, cleaned, and never wiped by a later start
// that omits it (Claude Code leaves `model` out after /clear). It is labelled "reported, not verified" wherever shown.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";

const modelOf = (s: Store, id: string): string | null =>
  (s.captureDb().prepare("SELECT model FROM sessions WHERE id = ?").get(id) as { model: string | null }).model;

test("session-start model is stored, kept when omitted later, and cleaned", () => {
  const s = new Store(":memory:");
  try {
    recordEvent(s, normalizeHookInput("session-start", { session_id: "s1", source: "startup", model: "claude-opus-5" }), "default");
    assert.equal(modelOf(s, "s1"), "claude-opus-5");

    recordEvent(s, normalizeHookInput("session-start", { session_id: "s1", source: "clear" }), "default");
    assert.equal(modelOf(s, "s1"), "claude-opus-5", "a start without a model must not wipe it");

    recordEvent(s, normalizeHookInput("session-start", { session_id: "s2", model: "evil\nline\u001b[31m" + "x".repeat(500) }), "default");
    const m = modelOf(s, "s2")!;
    assert.ok(!/[\u0000-\u001f]/.test(m), "no control characters");
    assert.ok(m.length <= 100, "capped at 100");

    recordEvent(s, normalizeHookInput("user-prompt", { session_id: "s3", prompt: "hi", model: "ignored" }), "default");
    assert.equal(modelOf(s, "s3"), null, "only session-start may set it");
  } finally {
    s.close();
  }
});
