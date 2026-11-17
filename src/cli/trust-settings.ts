// `monomem settings` keys for PLAN D trust (1.6): probation-notes, probation-hours, facts-need-evidence. Kept out of cli.ts
// (file-size ratchet). Loosening a rule (fewer notes, fewer hours, evidence off) needs a person at the terminal.

import { requireOperator } from "../operator-gate.js";
import type { Store } from "../store.js";
import { ValidationError } from "../errors.js";
import { probationSettings, setProbationSettings } from "../store/probation.js";
import { factsNeedEvidence, setFactsNeedEvidence } from "../store/evidence.js";

export const TRUST_SETTING_KEYS = ["probation-notes", "probation-hours", "facts-need-evidence"];

export function showTrustSettings(store: Store): void {
  const p = probationSettings(store);
  console.log(`probation-notes: ${p.notes}${p.notes === 0 ? " (writer probation off)" : ""}`);
  console.log(`probation-hours: ${p.hours}`);
  console.log(`facts-need-evidence: ${factsNeedEvidence(store) ? "on" : "off"}`);
}

export async function setTrustSetting(store: Store, key: string, value: string): Promise<void> {
  if (key === "facts-need-evidence") {
    if (value !== "on" && value !== "off") throw new ValidationError("facts-need-evidence must be on or off");
    if (value === "off" && factsNeedEvidence(store)) await requireOperator("turn facts-need-evidence off");
    return setFactsNeedEvidence(store, value === "on");
  }
  const n = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  const before = probationSettings(store);
  if (key === "probation-notes") {
    if (n < before.notes) await requireOperator(`lower probation-notes from ${before.notes} to ${value}`);
    setProbationSettings(store, { notes: n });
  } else {
    if (n < before.hours) await requireOperator(`lower probation-hours from ${before.hours} to ${value}`);
    setProbationSettings(store, { hours: n });
  }
}
