// redact.ts: <private> stripping and secret redaction for everything the capture hooks record.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripPrivate, redactSecrets, redact } from "../src/redact.js";
import { scanForSecrets } from "../src/security.js";

describe("stripPrivate", () => {
  test("drops a block, keeps the rest", () => {
    assert.equal(stripPrivate("a <private>secret</private> b"), "a  b");
    assert.equal(stripPrivate("a <PRIVATE note='x'>s</Private> b"), "a  b");
  });
  test("nested blocks go as one", () => {
    assert.equal(stripPrivate("x<private>1<private>2</private>3</private>y"), "xy");
  });
  test("an unclosed block drops everything after it", () => {
    assert.equal(stripPrivate("keep <private>the rest is hidden"), "keep ");
    assert.equal(stripPrivate("a <private>b <private>c</private> d"), "a ");
  });
  test("a stray close tag is dropped alone; text without tags is untouched", () => {
    assert.equal(stripPrivate("a </private> b"), "a  b");
    assert.equal(stripPrivate("privately nothing here"), "privately nothing here");
    assert.equal(stripPrivate(""), "");
  });
});

describe("redactSecrets", () => {
  const samples: Array<[string, string]> = [
    ["AWS access key", "key AKIAIOSFODNN7EXAMPLE here"],
    ["GitHub token", "token ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 end"],
    ["Stripe key", "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"],
    ["OpenAI/Anthropic key", "export K=sk-ant-api03-" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh"],
  ];
  for (const [label, text] of samples) {
    test(`replaces a ${label}`, () => {
      const r = redactSecrets(text);
      assert.ok(r.labels.includes(label), JSON.stringify(r));
      assert.match(r.text, new RegExp(`\\[REDACTED:${label.replace("/", "\\/")}\\]`));
      assert.equal(scanForSecrets(r.text), null, "nothing the linter would refuse is left");
    });
  }
  test("a whole PEM private key block goes", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`before\n${pem}\nafter`);
    assert.equal(r.text, "before\n[REDACTED:private key block]\nafter");
  });
  test("every occurrence is replaced, ordinary text is untouched", () => {
    const r = redactSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLF");
    assert.equal(r.text, "[REDACTED:AWS access key] and [REDACTED:AWS access key]");
    const plain = "npm test passed in src/store.ts at commit 3f2a9c1e";
    assert.deepEqual(redactSecrets(plain), { text: plain, labels: [] });
  });
  test("redact strips private blocks first", () => {
    const r = redact("<private>AKIAIOSFODNN7EXAMPLE</private>ok");
    assert.deepEqual(r, { text: "ok", labels: [] });
  });
});

describe("redactSecrets: passwords with no key shape (capture is never reviewed)", () => {
  const cases: [string, string][] = [
    ["mysql --password=Winter2026x -u root", "Winter2026x"],
    ["export DB_PASS=hunter22", "hunter22"],
    ["psql postgres://app:S3cretPw@db.local/prod", "S3cretPw"],
    ["curl -u admin:pa55word https://x.test", "pa55word"],
    ['curl -H "Authorization: Bearer abc123def456ghi789jkl0" https://x', "abc123def456ghi789jkl0"],
    ["my db password is Winter2026!", "Winter2026!"],
    ["api_key: q8RtYv2w", "q8RtYv2w"],
    ["PGPASSWORD=abc12345 psql", "abc12345"],
    ['dbPassword: "abc123x"', "abc123x"],
    ["clientSecret=Zz9secretValue", "Zz9secretValue"],
    ["redis-cli -u redis://:pass123x@cache:6379", "pass123x"],
    ["mysql://u:p@ss9word@db/x", "p@ss9word"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ];
  for (const [input, secret] of cases) {
    test(`removes the secret from: ${input.replace(secret, "<secret>")}`, () => {
      const out = redactSecrets(input);
      assert.ok(!out.text.includes(secret), out.text);
      assert.ok(out.labels.length > 0);
    });
  }
  test("leaves ordinary text and placeholders alone", () => {
    for (const s of ["password reset flow works", "set PASSWORD=$DB_PASSWORD in .env", "token: <your-token>", "git push origin main"]) {
      assert.equal(redactSecrets(s).text, s);
    }
  });
});

describe("redactSecrets: ordinary code and prose stay readable", () => {
  for (const s of [
    "const token = getToken(ctx)",
    "apiKey: options.apiKey,",
    "credentials: 'include'",
    "max_token=4096 foo",
    "grep 'token: string' src",
    "Add basic configuration for the server",
    "the password is required",
  ]) {
    test(`unchanged: ${s}`, () => assert.equal(redactSecrets(s).text, s));
  }
});

// A bare random token in tool output (cat .token, a printed key) has no prefix, no name= and, as hex, no mixed case,
// so neither the patterns nor the entropy heuristic saw it: it was stored raw in capture_events.
describe("redactSecrets: bare random tokens (capture only)", () => {
  const HEX32 = "9f86d081884c7d659a2feaa0c55ad015";
  const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const B64URL = "Xk9_pQ2-vR7mLz4TbW1yNc8hJd3sFq6uGe0aKo5iVtQ"; // 43 chars: a 32-byte key, base64url
  const B64URL_SHORT_RUNS = "aB3dE5fG7hJ9kL-mN2pQ4rS6tU8vW_xY1zA3bC5dE7fG"; // no separator-free run of 24+
  for (const [name, tok] of [["32 hex", HEX32], ["32 HEX", HEX32.toUpperCase()], ["64 hex", HEX64], ["base64url", B64URL], ["base64url with short runs", B64URL_SHORT_RUNS]] as const) {
    test(`redacts a bare ${name} token`, () => {
      for (const s of [tok, `key: ${tok}\n`, `"${tok}"`, `token=${tok}`]) {
        const r = redactSecrets(s);
        assert.ok(!r.text.includes(tok), `${name} left in ${JSON.stringify(r.text)}`);
      }
    });
  }
  test("the capture hook stores no bare key from a tool's output", async () => {
    const { normalizeHookInput } = await import("../src/capture.js");
    const ev = normalizeHookInput("post-tool", { session_id: "s", cwd: "/w", tool_name: "Bash", tool_input: { command: "cat ~/.monomem/.token" }, tool_response: { stdout: HEX32 + "\n" } });
    assert.ok(!ev.output.includes(HEX32), ev.output);
  });
  for (const s of [
    "commit 3f2a9c1e5b7d8f0a1c2e4b6d8f0a2c4e6b8d0f1a", // a git commit SHA: exactly 40 hex
    "HEAD is now at 3f2a9c1e5b7d8f0a1c2e4b6d8f0a2c4e6b8d0f1a fix: x",
    "abc1234 short sha, 9f86d081884c7d659a2feaa0c55ad01 (31 hex)",
    "550e8400-e29b-41d4-a716-446655440000", // a UUID
    "image@sha256:" + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // a content digest
    "12345678901234567890123456789012345", // digits only: a number
    "getUserProfileSettingsForCurrentAccountId", // an identifier
    "My_Project_v2_Final_Build_Release_2024_Draft", // words joined with _
    "test-Monomem-Setup-Legacy-Home-Keeps-Notes-2026",
    "C:/Users/someone/AppData/Local/Temp/monomem-test-home-AbC123/state.db",
  ]) {
    test(`unchanged: ${s}`, () => assert.equal(redactSecrets(s).text, s));
  }
});
