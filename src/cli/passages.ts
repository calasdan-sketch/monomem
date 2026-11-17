// `monomem settings set passage-pooling on|off` (passage_pooling also works): opt-in passage pooling for keyword search (store/passages.ts).
// On builds the passage index now (so the first search does not wait) and says what it cost; off removes it.
import type { Store } from "../store.js";
import { PASSAGE_SETTING, dropPassages, passageCount, syncPassages } from "../store/passages.js";

/** The line `monomem settings` shows. */
export function passagePoolingLine(store: Store): string {
  const on = store.getMeta(PASSAGE_SETTING) === "on";
  const sealed = on && store.sealsWrites() ? " (not used: this store is encrypted)" : "";
  return `passage-pooling: ${on ? "on" : "off"}${on ? "" : " (default)"}${sealed}`;
}

/** Apply `set passage-pooling <value>`. Returns the message to print, or throws on a bad value. */
export function setPassagePooling(store: Store, value: string): string {
  if (value !== "on" && value !== "off") throw new Error("passage-pooling must be on or off");
  if (value === "off") {
    store.setMeta(PASSAGE_SETTING, "off");
    dropPassages(store);
    return "Passage pooling is off. Search ranks whole notes again. The space the passage index used is reused by new notes (the file shrinks only after a VACUUM).";
  }
  if (store.sealsWrites()) {
    throw new Error("passage pooling is not available on an encrypted store: its index would put the words of sealed bodies on disk");
  }
  store.setMeta(PASSAGE_SETTING, "on");
  const t0 = performance.now();
  syncPassages(store);
  const n = passageCount(store);
  return `Passage pooling is on: ${n.toLocaleString("en-US")} passages indexed in ${((performance.now() - t0) / 1000).toFixed(1)} s. ` +
    "Keyword search now also ranks long notes by their best passage. It makes the database bigger; see docs/BENCHMARK.md (passage pooling) for what it measured.";
}
