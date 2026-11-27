// detail="index" for memory_search / memory_list: one short line per note so an agent can scan 20 hits cheaply, then
// call memory_read with the ids it wants. Builds on the compact reply (it reads the same fields); it adds no new data.

/** Title and writer characters an index line keeps. */
const TITLE_CHARS = 60;
const WRITER_CHARS = 18;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}~` : s);

/** "2026-11-25, today" -> "today"; "2026-11-20, 5 days ago" -> "5 days ago"; anything else is kept (clipped). */
function age(when: unknown): string {
  if (typeof when !== "string") return "";
  const i = when.indexOf(", ");
  return clip(i >= 0 ? when.slice(i + 2) : when, 14);
}

/** id|title|writer|age|flags, `|` inside a title is replaced so the line always splits into 5 parts. */
export function indexLine(n: Record<string, unknown>): string {
  const flags = [n.stale === true ? "stale" : "", n.status === "superseded" ? "replaced" : ""].filter(Boolean).join(",");
  const title = clip(String(n.title ?? n.body ?? "").replace(/[|\r\n]+/g, " ").trim(), TITLE_CHARS);
  return [n.id, title, clip(String(n.written_by ?? "").replace(/[|\r\n]+/g, " "), WRITER_CHARS), age(n.when), flags].join("|");
}

/**
 * A search/list payload as an index: `results` (memory_list: `notes`) become `index` lines (best match first, so the position is the score).
 * Other fields (more, notice, ...) stay. A payload with neither array is returned unchanged.
 */
export function toIndex(p: Record<string, unknown>): Record<string, unknown> {
  const key = Array.isArray(p.results) ? "results" : Array.isArray(p.notes) ? "notes" : "";
  if (!key) return p;
  const { [key]: list, ...rest } = p;
  const lines = (list as Array<Record<string, unknown>>).map(indexLine);
  return { index: "id|title|writer|age|flags (best first). memory_read ids for the full text.", hits: lines, ...rest };
}
