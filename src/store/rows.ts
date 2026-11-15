// Pure row helpers shared by store.ts and the src/store/* modules (1.5.0 store split). Imports no project module,
// so every user stays out of import cycles.

/** A hooked session with no event for this long no longer counts as open (same as extract.ts STALE_SESSION_MS). */
export const SESSION_IDLE_MS = 30 * 60_000;

export function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  // Store as a JSON array so tags can contain commas/spaces; dedupe + trim.
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

export function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    } catch {
      /* fall through to legacy comma parse */
    }
  }
  return raw.split(",").map((t) => t.trim()).filter(Boolean); // legacy rows
}
