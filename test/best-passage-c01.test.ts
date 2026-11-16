import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// C-01: a long search hit shows the ~600-char window with the most query hits, not the first 600 characters.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { createMcpServer, LIST_BODY_CHARS } from "../src/mcp-server-core.js";
import { bestPassage } from "../src/search-service.js";

const FILLER = "lorem ipsum dolor sit amet ".repeat(200); // 5,400 chars with no query word
const LONG = `Intro paragraph about nothing. ${FILLER}The wireguard tunnel uses port 51820 and the wireguard keys live in the vault. ${FILLER}`;

describe("bestPassage", () => {
  test("picks the window holding the query words, keeps the length, reports where it starts", () => {
    const p = bestPassage(LONG, "wireguard keys", LIST_BODY_CHARS);
    assert.equal(p.text.length, LIST_BODY_CHARS);
    assert.ok(p.start > 0);
    assert.equal(p.text, LONG.slice(p.start, p.start + LIST_BODY_CHARS));
    assert.match(p.text, /wireguard tunnel uses port 51820 and the wireguard keys live/);
  });
  test("no query word in the body (or a short body): the start, as before", () => {
    assert.equal(bestPassage(LONG, "kubernetes", 600).start, 0);
    assert.equal(bestPassage("short body", "short", 600).text, "short body");
  });
  test("matches at a word start only, accents folded (like the index)", () => {
    const body = `${FILLER}xresume here ${FILLER}Résumé sent ${FILLER}`;
    const p = bestPassage(body, "resume", 600);
    assert.match(p.text, /Résumé sent/);
  });
  test("a window equal to the opening one keeps the opening (no needless jump)", () => {
    const body = `wireguard first ${FILLER}wireguard again ${FILLER}`;
    assert.equal(bestPassage(body, "wireguard", 600).start, 0);
  });
});

async function client(store: Store): Promise<Client> {
  const server = createMcpServer(store, "admin", {} as never, { label: "t", authed: true });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "t", version: "1" });
  await Promise.all([cl.connect(c), server.connect(s)]);
  return cl;
}
const json = (r: unknown) => {
  const t = (r as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};

describe("state_search returns the best passage", () => {
  test("plain store: keyword and relevant mode both show the matching window and body_offset", async () => {
    const store = new Store(":memory:");
    const cl = await client(store);
    try {
      store.create({ title: "Network notes", body: LONG });
      for (const args of [{ query: "wireguard keys" }, { query: "where are the wireguard keys kept?", mode: "relevant" }]) {
        const hit = json(await cl.callTool({ name: "state_search", arguments: args })).results[0];
        assert.equal(hit.body_truncated, true);
        assert.equal(hit.body.length, LIST_BODY_CHARS);
        assert.match(hit.body, /wireguard keys live in the vault/, JSON.stringify(args));
        assert.equal(hit.body_offset, LONG.indexOf(hit.body));
      }
      // state_list has no query: still the first 600 characters, no offset.
      const listed = json(await cl.callTool({ name: "state_list", arguments: {} })).notes[0];
      assert.equal(listed.body, LONG.slice(0, LIST_BODY_CHARS));
      assert.equal(listed.body_offset, undefined);
    } finally {
      await cl.close();
      store.close();
    }
  });

  test("encrypted store: the window comes from the decrypted body; another note's text never appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-c01-"));
    try {
      ensureKey(dir);
      const store = new Store(join(dir, "state.db"));
      const cl = await client(store);
      try {
        store.create({ title: "wireguard setup", body: LONG });
        store.create({ title: "other", body: `${FILLER} wireguard keys SECRET-OTHER-NOTE ${FILLER}`, sensitivity: "private" } as never);
        const res = json(await cl.callTool({ name: "state_search", arguments: { query: "wireguard" } })).results as Array<{ title: string; body: string }>;
        const hit = res.find((r) => r.title === "wireguard setup")!;
        assert.match(hit.body, /wireguard tunnel uses port 51820/);
        assert.doesNotMatch(hit.body, /SECRET-OTHER-NOTE/);
      } finally {
        await cl.close();
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
