// How many tools an assistant is shown.
//
// Every registered tool's name, description and schema is sent to the model on
// every turn, so an unused tool is a cost paid continuously. Registering all 32
// meant the first measurable effect of installing Monomem was a bigger
// context bill, and it handed the model a 32-item menu to pick the wrong thing
// from. Several hosts also cap how many tools they accept.
//
// It also meant a plain memory install advertised a command-task queue and a
// runner status tool -- command execution -- when the runner itself is not even
// shipped in the package.

import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer, enabledToolNames, DEFAULT_TOOLS } from "../src/mcp-server-core.js";

/**
 * Tool names a real client is shown, with MONOMEM_TOOLS set to `setting`
 * (undefined = unset, i.e. a plain install). The suite as a whole runs with
 * MONOMEM_TOOLS=all so it can exercise the operator tools, so this file must
 * set the variable itself rather than inherit it.
 */
async function toolNames(store: Store, setting?: string): Promise<string[]> {
  const prior = process.env.MONOMEM_TOOLS;
  if (setting === undefined) delete process.env.MONOMEM_TOOLS;
  else process.env.MONOMEM_TOOLS = setting;
  try {
    const server = createMcpServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    } finally {
      await client.close();
    }
  } finally {
    if (prior === undefined) delete process.env.MONOMEM_TOOLS;
    else process.env.MONOMEM_TOOLS = prior;
  }
}

describe("which tools are chosen", () => {
  test("unset means the core set", () => {
    assert.deepEqual([...enabledToolNames({})!].sort(), [...DEFAULT_TOOLS].sort());
  });

  test('"all" means no filtering at all', () => {
    assert.equal(enabledToolNames({ MONOMEM_TOOLS: "all" }), null);
  });

  test("a comma list is added to the core set, never replaces it", () => {
    const got = enabledToolNames({ MONOMEM_TOOLS: "memory_usage,memory_sessions" })!;
    assert.ok(got.has("memory_usage"));
    assert.ok(got.has("memory_sessions"));
    for (const core of DEFAULT_TOOLS) {
      assert.ok(got.has(core), `${core} must survive: a typo must not leave a server that cannot read or write`);
    }
  });

  test("a nonsense value still leaves a working server", () => {
    const got = enabledToolNames({ MONOMEM_TOOLS: "   " })!;
    assert.ok(got.has("memory_save") && got.has("memory_search"));
  });
});

describe("the default tool surface", () => {
  test("a default server exposes the core set and nothing else", async () => {
    const store = new Store(":memory:");
    try {
      assert.deepEqual(await toolNames(store), [...DEFAULT_TOOLS].sort());
    } finally {
      store.close();
    }
  });

  test("a default server advertises no command execution", async () => {
    const store = new Store(":memory:");
    try {
      const names = await toolNames(store);
      for (const n of ["memory_tasks", "task_put", "task_get", "task_claim", "task_approve", "task_list", "runner_status"]) {
        assert.equal(names.includes(n), false, `${n} queues or reports shell commands and must not be in a memory install's default surface`);
      }
    } finally {
      store.close();
    }
  });

  test("memory still works with only the default tools: write, find, read, forget", async () => {
    const store = new Store(":memory:");
    try {
      const names = await toolNames(store);
      for (const n of ["memory_save", "memory_search", "memory_read", "memory_archive", "memory_catch_up"]) {
        assert.ok(names.includes(n), `${n} is needed for memory to function`);
      }
    } finally {
      store.close();
    }
  });

  test("the safe correction path survives, so an agent need not delete to fix", async () => {
    const store = new Store(":memory:");
    try {
      const names = await toolNames(store);
      assert.ok(names.includes("memory_replace"), "preview, confirm and undo live in one tool");
    } finally {
      store.close();
    }
  });

  test("the default set is a real reduction, not a rename", () => {
    assert.ok(DEFAULT_TOOLS.length <= 12, `expected a small default set, got ${DEFAULT_TOOLS.length}`);
  });
});

describe("the full surface is still reachable", () => {
  test("MONOMEM_TOOLS=all brings the operator tools back", async () => {
    const store = new Store(":memory:");
    try {
      const names = await toolNames(store, "all");
      assert.ok(names.length > DEFAULT_TOOLS.length, "all means more than core");
      for (const n of ["memory_usage", "memory_history", "memory_trust", "memory_tidy"]) {
        assert.ok(names.includes(n), `${n} must still be available to an operator`);
      }
    } finally {
      store.close();
    }
  });
});
