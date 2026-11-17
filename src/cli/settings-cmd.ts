// `monomem settings`: settings kept in the store (re-confirmation, passage pooling, writer probation, evidence rules).
import { requireOperator } from "../operator-gate.js";

export async function configCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem settings [get | set confirm-days <n> | set confirm-mode off|label|enforce | set passage_pooling on|off | set probation-notes|probation-hours <n> | set facts-need-evidence on|off | known-hosts [add|remove <host>]]";
  const [verb = "get", key, value, ...extra] = args;
  const trustKeys = (await import("../cli/trust-settings.js")).TRUST_SETTING_KEYS;
  if (extra.length || (verb !== "get" && verb !== "set") || (verb === "get" && key !== undefined) || (verb === "set" && (value === undefined || (key !== "confirm-days" && key !== "confirm-mode" && key !== "passage_pooling" && !trustKeys.includes(key))))) {
    console.error(usage);
    process.exit(1);
  }
  const { DB_PATH } = await import("../config.js");
  const { Store, ValidationError } = await import("../store.js");
  const store = new Store(DB_PATH);
  const ts = await import("../cli/trust-settings.js");
  try {
    const show = (): void => {
      const c = store.confirmSettings();
      console.log(`confirm-mode: ${c.mode}${c.set_at ? ` (since ${c.set_at.slice(0, 16).replace("T", " ")})` : " (default)"}`);
      console.log(`confirm-days: ${c.days}`);
      console.log(pp.passagePoolingLine(store));
      ts.showTrustSettings(store);
    };
    const pp = await import("../cli/passages.js");
    if (verb === "get") return show();
    if (key === "passage_pooling") {
      try {
        return console.log(pp.setPassagePooling(store, value));
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    const before = store.confirmSettings();
    const RANK: Record<string, number> = { off: 0, label: 1, enforce: 2 };
    try {
      if (trustKeys.includes(key)) await ts.setTrustSetting(store, key, value);
      else if (key === "confirm-mode") {
        if (!(value in RANK)) throw new ValidationError("confirm-mode must be one of: off, label, enforce");
        if (RANK[value] < RANK[before.mode]) await requireOperator(`lower re-confirmation expiry from ${before.mode} to ${value}`);
        store.setConfirmSettings({ mode: value as "off" | "label" | "enforce" });
      } else {
        const days = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
        if (days > before.days && before.mode !== "off") await requireOperator(`lengthen re-confirmation from ${before.days} to ${value} days`);
        // Under enforce, shortening the period takes notes out of session start; the store restarts the clock, and a person decides.
        if (days < before.days && before.mode === "enforce") await requireOperator(`shorten re-confirmation under enforce from ${before.days} to ${value} days`);
        store.setConfirmSettings({ days });
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
    show();
  } finally {
    store.close();
  }
}
