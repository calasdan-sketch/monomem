// Final panel round 2, security SF-1: ownKeyring() trusts trust_attesters rows labelled "retired key of this server" (pinned to
// this server's id) for audit verify and verify-receipt. An admin token could add its own key under that label and sign
// receipts the server never gave. The label is reserved: only key rotation writes it.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Store, RETIRED_OWN_KEY_LABEL } from "../src/store.js";
import { ValidationError } from "../src/store.js";

const pubKey = (): string => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
};

test("an admin cannot add a key under the reserved retired-own-key label, in any case", () => {
  const s = new Store(":memory:");
  try {
    const sid = s.serverId();
    for (const label of [RETIRED_OWN_KEY_LABEL, "Retired Key Of This Server", `  ${RETIRED_OWN_KEY_LABEL}  `]) {
      assert.throws(() => s.attesterAdd({ public_key: pubKey(), server_id: sid, label }), ValidationError, label);
    }
    assert.deepEqual(Object.keys(s.ownKeyring()).filter((k) => k !== s.identity().key_id), [], "no forged key in the own keyring");
    const ok = s.attesterAdd({ public_key: pubKey(), server_id: sid, label: "my old laptop" });
    assert.equal(ok.label, "my old laptop", "other labels still work");
    assert.ok(!(ok.key_id in s.ownKeyring()), "and do not enter the own keyring");
  } finally {
    s.close();
  }
});
