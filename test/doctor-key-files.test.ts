// 1.5.0 R1-09: doctor names the app config files that hold an app key (an Authorization header), so the disclosure in SECURITY.md is checkable on this machine.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appKeyFiles } from "../src/setup.js";

test("appKeyFiles lists only the existing app configs that hold an Authorization header", () => {
  const home = mkdtempSync(join(tmpdir(), "mm-keyfiles-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { url: "http://x", headers: { Authorization: "Bearer k" } } } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { monomem: { command: "node", args: ["cli.js"] } } })); // keyless stdio
  const found = appKeyFiles({ home, platform: "linux", env: {}, cwd: join(home, "proj") } as any);
  assert.deepEqual(found.map((f) => f.split(String.fromCharCode(92)).join("/").replace(home.split(String.fromCharCode(92)).join("/"), "~")), ["~/.cursor/mcp.json"]);
});
