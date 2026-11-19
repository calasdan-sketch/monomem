// The dashboard's Review tab shows the same items as `monomem review` (r2-improvement #4): unconfirmed outside content and
// notes past re-confirmation, flagged notes, notes about code that changed, plus facts two writers disagree on. It used to
// page through every note (1.35 MB at 3,075 notes) and list each agent note "to accept"; that queue is gone.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";

const as = <T>(label: string, f: () => T): T => actorStore.run({ label, authed: true }, f);
const ADMIN = "a".repeat(40);
const settle = () => new Promise((r) => setTimeout(r, 30));

/** The page script in a stub browser whose fetch goes to a real server. */
function page(base: string, calls: string[]) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, hidden: false, addEventListener() {}, focus() {}, appendChild() {}, getAttribute: () => null, setAttribute() {}, removeAttribute() {} });
    return els.get(id);
  };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    // The key appears only after the script has loaded, so its own start-up load does not race the view under test.
    sessionStorage: { getItem: (k: string) => (k === "om_tok" && ctx.ready ? ADMIN : ""), setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent, Promise,
    fetch: (path: string, o: any = {}) => (calls.push(`${o.method ?? "GET"} ${path}`), fetch(base + path, o)),
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  ctx.ready = true;
  return { ctx, el };
}

async function withServer(fn: (base: string, s: Store) => Promise<void>): Promise<void> {
  const s = new Store(":memory:");
  const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, s);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  }
}

describe("dashboard Review = monomem review", () => {
  test("the page has a Review tab and valid script", () => {
    assert.match(DASHBOARD_HTML, /id="tab_review" data-do="loadReview">Review/);
    assert.doesNotThrow(() => new vm.Script(DASHBOARD_JS));
    assert.ok(!/reviewQueue|acceptNote/.test(DASHBOARD_JS), "the every-agent-note queue is gone");
  });

  test("the page says Monomem, not an old name", () => {
    assert.ok(!/onememory|claude-bridge/i.test(DASHBOARD_HTML));
    assert.equal((DASHBOARD_HTML.match(/<span>Monomem<\/span>|<h1>Monomem<\/h1>/g) || []).length, 2, "header and sign-in");
  });

  test("200 ordinary agent notes, 1 from outside and 1 flagged: Review lists 2, the same ids as store lists, without paging /notes", async () => {
    await withServer(async (base, s) => {
      for (let i = 0; i < 200; i++) as("claude-code", () => s.create({ title: `ordinary ${i}`, body: "x" }));
      const outside = as("research-bot", () => s.create({ title: "Acme pricing <b>", body: "acme costs 40", source: "https://vendor.example", outside: true }));
      const flagged = as("claude-code", () => s.create({ title: "Deploy with npm", body: "npm run deploy" }));
      as("stdio:codex", () => s.flagNote(flagged.id, "we deploy with pnpm now"));
      const cli = [...s.reviewList(), ...s.flaggedList(), ...s.codeChangedList()].map((x) => x.id).sort((a, b) => a - b);
      assert.deepEqual(cli, [outside.id, flagged.id].sort((a, b) => a - b));

      const calls: string[] = [];
      const p = page(base, calls);
      p.ctx.loadReview();
      for (let i = 0; i < 20 && !p.el("list").innerHTML; i++) await settle();
      const html = p.el("list").innerHTML as string;
      assert.match(p.el("count").textContent, /^2 notes wait/);
      assert.match(html, /aria-label='confirm note #\d+' data-do='reviewConfirm' data-args='\[\d+\]'>Confirm: I checked it</);
      assert.match(html, /we deploy with pnpm now/);
      assert.match(html, /Acme pricing &lt;b&gt;/, "titles are escaped");
      assert.ok(!html.includes("ordinary 1"), "ordinary agent notes are not listed");
      assert.ok(!calls.some((c) => c.startsWith("GET /notes")), "no paging through every note");
    });
  });

  test("Confirm releases the note; Keep needs a person session and says how to get one", async () => {
    await withServer(async (base, s) => {
      const outside = as("research-bot", () => s.create({ title: "Acme pricing", body: "40", source: "https://vendor.example", outside: true }));
      const flagged = as("claude-code", () => s.create({ title: "Deploy", body: "npm" }));
      as("stdio:codex", () => s.flagNote(flagged.id, "wrong"));
      const calls: string[] = [];
      const p = page(base, calls);
      p.ctx.reviewConfirm(outside.id);
      for (let i = 0; i < 20 && !calls.some((c) => c.startsWith("GET /ui/review")); i++) await settle();
      assert.ok(calls.includes(`POST /notes/${outside.id}/confirm`));
      const keep = await fetch(`${base}/ui/review/${flagged.id}/keep`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.equal(keep.status, 403);
      assert.match(((await keep.json()) as { error: string }).error, /monomem open/);
      assert.equal(s.flaggedList().length, 1, "the key alone did not clear the flag");
    });
  });
});
