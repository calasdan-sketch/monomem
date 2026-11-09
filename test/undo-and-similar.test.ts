import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { supersedePreview, supersedeConfirm, supersedeUndo, type Caller } from "../src/supersede.js";

const caller = { scope: "admin" as const, writer: "you" } as Caller;

test("a near-duplicate write gets a gentle hint naming the similar note, never one above the ceiling", async () => {
  const s = new Store(":memory:");
  const body = "The staging database runs on postgres 16 behind pgbouncer on port 6432 for the checkout service";
  const first = s.create({ title: "Staging database setup", body });
  const tok = "t".repeat(40), lim = "l".repeat(40);
  const server = createApiServer(s, [
    { token: tok, scope: "admin", label: "op" },
    { token: lim, scope: "write", label: "limited", max_sensitivity: "internal" },
  ]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (t: string, b: object): Promise<any> => (await fetch(base + "/notes", { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
  const dup = await post(tok, { title: "Staging database setup notes", body: body + " as well" });
  assert.equal(dup.similar_note?.id, first.id, JSON.stringify(dup).slice(0, 300));
  assert.match(dup.similar_note.hint, /looks similar to #\d+ - consider updating it/);
  const other = await post(tok, { title: "Lunch order", body: "sandwich with extra pickles" });
  assert.equal(other.similar_note, undefined, "unrelated notes get no hint");
  // A private look-alike is never named to a limited caller.
  const secret = actorStore.run({ label: "op", authed: true }, () => s.create({ title: "Payroll database setup", body: "payroll ledger runs on oracle 19 with rac nodes and data guard standby replication", sensitivity: "private" }));
  const probe = await post(lim, { title: "Payroll database setup copy", body: "payroll ledger runs on oracle 19 with rac nodes and data guard standby replication extra" });
  assert.equal(probe.similar_note, undefined);
  assert.ok(secret.id > 0);
  await new Promise<void>((r) => server.close(() => r()));
  s.close();
});

test("supersede undo says plainly that the replacement is still live, with the one-line fix", () => {
  const s = new Store(":memory:");
  const old = s.create({ title: "Deploy target is heroku", body: "heroku" });
  const nn = { title: "Deploy target is fly", body: "fly.io" };
  const prev = supersedePreview(s, caller, { old_ids: [old.id], new_note: nn }, "");
  const done = supersedeConfirm(s, caller, { token: prev.token, new_note: nn, acknowledge_risk: prev.requires_acknowledgement });
  const newId = done.replacement.id;
  const out = supersedeUndo(s, caller, old.id);
  assert.equal(out.replacement_still_live, newId);
  assert.match(out.message, new RegExp(`#${newId} is still live, so both are live now`));
  assert.match(out.message, new RegExp(`monomem forget ${newId}`));
  s.close();
});
