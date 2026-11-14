// Claims the project makes in public, checked against what the code does.
//
// Why this file exists. Three releases in a row shipped a false or crashing
// claim about the same thing (the Node floor), and a single audit found six
// more false statements at once: SECURITY.md denied the product's own version
// history, the README said exports cannot contain deleted text (they can), the
// published recall figure understated the product, "2.0.0 never reached npm"
// was false, a shipped skill called four tools a default install does not
// register, and the architecture doc miscounted the tools.
//
// None of those were hard to catch. They survived because nothing mechanical
// ever looked. The suite only ever compared the author's beliefs against a
// constant the author also wrote, so it agreed with itself and went green.
//
// The rule this file enforces: a number, version or capability statement in a
// shipped file must be derived from the code, not asserted beside it. A claim
// that cannot name its check does not ship.

import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_NODE_TEXT } from "../src/setup.js";
import { DEFAULT_TOOLS } from "../src/mcp-server-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { engines: { node: string }; version: string };

/** Files a user actually reads, and which have each carried a false claim. */
const PUBLIC_DOCS = ["README.md", "SECURITY.md", "INSTALL.md", "INFRA.md", "CONTRIBUTING.md", "SKILL.md"];

describe("the Node floor is stated identically everywhere", () => {
  test("engines matches the gate the code enforces", () => {
    assert.equal(pkg.engines.node, `>=${MIN_NODE_TEXT}`, "package.json engines and MIN_NODE_TEXT must agree");
  });

  test("no shipped doc names a Node floor other than the real one", () => {
    // Any "Node ... <major>.<minor>" that looks like a requirement. Historical
    // prose ("added in 22.5.0", "unflagged in 22.13.0") is legitimate, so this
    // checks the *requirement* phrasings only.
    const floor = MIN_NODE_TEXT.split(".").slice(0, 2).join("."); // "22.16"
    const bad: string[] = [];
    for (const f of PUBLIC_DOCS) {
      if (!existsSync(join(ROOT, f))) continue;
      const text = read(f);
      for (const m of text.matchAll(/(?:>=\s*|Node\.js\s+|Node\s+)(\d+\.\d+)(?:\.\d+)?\s*(?:\+|or newer|or later)/gi)) {
        const v = m[1];
        if (v !== floor && !v.startsWith("24")) bad.push(`${f}: "${m[0].trim()}"`);
      }
    }
    assert.deepEqual(bad, [], `these state a Node requirement that is not ${floor}:\n  ${bad.join("\n  ")}`);
  });
});

describe("tool-surface claims match the registered tools", () => {
  const core = read("src/mcp-server-core.ts");
  const registered = [...core.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);

  test("the docs' tool count is the real tool count", () => {
    assert.ok(registered.length >= 20, "sanity: the regex should find the tools");
    const words: Record<number, string> = { 28: "twenty-eight", 30: "thirty", 32: "thirty-two", 33: "thirty-three", 34: "thirty-four", 35: "thirty-five", 36: "thirty-six" };
    const arch = read("docs/architecture.md");
    const claimed = Object.entries(words).find(([, w]) => arch.includes(`with ${w} tools`));
    assert.ok(claimed, "docs/architecture.md should state the tool count in words");
    assert.equal(
      Number(claimed[0]),
      registered.length,
      `docs/architecture.md says ${claimed[1]} tools; ${registered.length} are registered`,
    );
  });

  test("every default tool is actually registered", () => {
    for (const t of DEFAULT_TOOLS) {
      assert.ok(registered.includes(t), `${t} is in DEFAULT_TOOLS but never registered`);
    }
  });

  test("docs that name the default count agree with DEFAULT_TOOLS", () => {
    const words: Record<number, string> = { 9: "nine", 10: "ten", 11: "eleven", 12: "twelve" };
    const word = words[DEFAULT_TOOLS.length];
    assert.ok(word, `add ${DEFAULT_TOOLS.length} to the number words above`);
    for (const f of ["README.md", "docs/configuration.md"]) {
      const text = read(f).toLowerCase();
      const other = Object.entries(words).filter(([n]) => Number(n) !== DEFAULT_TOOLS.length);
      for (const [n, w] of other) {
        assert.ok(
          !text.includes(`${w} of these are registered`) && !text.includes(`is the ${w} an assistant needs`),
          `${f} says "${w}" (${n}) default tools; there are ${DEFAULT_TOOLS.length}`,
        );
      }
    }
  });
});

describe("shipped skills only promise tools the reader can actually call", () => {
  // A skill that instructs a non-default tool must say so, or an agent loads it
  // on a plain install and calls a tool that does not exist.
  const skills = ["SKILL.md", "skills/monomem-mem/SKILL.md"];
  const core = read("src/mcp-server-core.ts");
  const registered = new Set([...core.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));

  for (const f of skills) {
    test(`${f} declares the MONOMEM_TOOLS requirement if it uses a non-default tool`, () => {
      const text = read(f);
      const used = [...text.matchAll(/\b(memory_[a-z_]+|task_[a-z_]+|session_[a-z_]+|runner_status|trust_policy)\b/g)].map((m) => m[1]);
      const nonDefault = [...new Set(used)].filter((t) => registered.has(t) && !DEFAULT_TOOLS.includes(t));
      if (nonDefault.length === 0) return;
      assert.match(
        text,
        /MONOMEM_TOOLS/,
        `${f} mentions non-default tools (${nonDefault.slice(0, 5).join(", ")}) but never tells the reader they need MONOMEM_TOOLS`,
      );
    });
  }
});

describe("the package ships what the docs point at", () => {
  test("no shipped markdown links a relative path that is not in the tarball", () => {
    // package-contents.test.ts owns the full check; this guards the specific
    // regression where an honesty caption linked a file npm users cannot open.
    const readme = read("README.md");
    const rel = [...readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]);
    const files = (JSON.parse(read("package.json")) as { files: string[] }).files;
    const shippedDocs = files.some((f) => f === "docs/*.md");
    for (const r of rel) {
      if (!r.startsWith("docs/")) continue;
      if (r.endsWith(".md") && shippedDocs) continue;
      assert.fail(`README links ${r}, which is not in package.json "files" — it 404s on npm. Use an absolute URL.`);
    }
  });
});
