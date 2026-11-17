// Subagent memory (r2-competition #2), off by default (MONOMEM_SUBAGENT_MEMORY=on), same family as MONOMEM_PROMPT_RECALL.
//   SubagentStart: a short pack (at most PACK_LINES index lines, ranked like session start, so this project comes first),
//                  leaving out notes the main session was already shown; once per subagent type per session.
//   SubagentStop:  one compact observation: what the subagent reported and the files it read, linked (derived_from) to the
//                  notes in its pack, stamped like a session summary when the session read outside content.
// Both fail open: any problem means no pack / no note, never a blocked agent.
import type { Store } from "../store.js";
import { DEFAULT_NAMESPACE } from "../store.js";
import { indexLine, rankContext, openToolName } from "../context-inject.js";
import { noticeRows, noticesMark, noticesSaid, receiptShown } from "../receipts.js";
import { cleanField } from "../capture.js";
import { CAPTURE_SOURCE, originTags } from "../extract.js";

export const PACK_LINES = 10;

export { subagentMemoryOn } from "./switches.js";

const one = (s: string, max: number): string => {
  const c = (s || "").replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
};
/** The subagent type as a short plain key ("Explore", "general-purpose"); "agent" when none was given. */
export const agentKind = (v: unknown): string => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 40) : "") || "agent";

/** The SubagentStart pack text ("" = nothing to give, or already given to this type in this session). */
export async function subagentPack(store: Store, sessionId: string, type: string, opts: { namespace?: string; cwd?: string }): Promise<string> {
  const said = noticesSaid(store, sessionId);
  if (said.has(`0:subagent:${type}`)) return "";
  const shown = receiptShown(store, sessionId);
  const { ranked } = await rankContext(store, { namespace: opts.namespace, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const pack = ranked.filter((n) => !shown.has(n.id)).slice(0, PACK_LINES);
  if (!pack.length) return "";
  // Recorded first (once per type, and which notes it was given, for the SubagentStop link); unrecorded = not given.
  if (!noticesMark(store, sessionId, [{ id: 0, kind: `subagent:${type}` }, ...pack.map((n) => ({ id: n.id, kind: `pack:${type}` }))])) return "";
  store.logAccess({ tool: "hook:subagent-pack", namespaces: opts.namespace !== undefined ? [opts.namespace] : [], results: pack.length });
  return [`Memory for this task (most relevant first; open with ${openToolName()}):`, ...pack.map((n) => indexLine(n))].join("\n");
}

/** SubagentStop: the trail note. Returns its id, or null when there was nothing to record. */
export function subagentTrail(store: Store, sessionId: string, type: string, message: string, namespace?: string): number | null {
  const db = store.captureDb();
  const start = noticeRows(store, sessionId, `subagent:${type}`).find((r) => r.id === 0);
  const events = db
    .prepare("SELECT seq, event, tool, input, input_enc, output, output_enc FROM capture_events WHERE session_id = ? AND at >= ? ORDER BY seq LIMIT 2000")
    .all(sessionId, start?.at ?? new Date(Date.now() - 30 * 60_000).toISOString()) as Array<{ seq: number; event: string; tool: string; input: string; input_enc: string | null; output: string; output_enc: string | null }>;
  const files = [
    ...new Set(
      events
        .filter((e) => e.tool === "Read" && !e.input_enc)
        .map((e) => /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(e.input)?.[1] ?? "")
        .filter(Boolean)
    ),
  ].slice(0, 10);
  const said = one(cleanField(message), 600);
  if (!said && !files.length) return null;
  const packIds = noticeRows(store, sessionId, `pack:${type}`).map((r) => r.id);
  const derived = packIds.filter((id) => store.readVisible(id) !== null); // gate-ok: only links to notes this reader can see
  // Outside content the subagent read stamps the note, as it stamps a session summary (extract.ts originTags).
  const origin = originTags(events.map((e) => ({ event: e.event, tool: e.tool, output: e.output || e.output_enc ? "x" : "" })));
  const firstLine = said.split(/(?<=[.!?])\s/)[0] ?? "";
  let title = one(`Subagent ${type}: ${firstLine || "finished"}`, 120);
  let body = [said, files.length ? `Files read: ${files.join(", ")}` : ""].filter(Boolean).join("\n");
  if (store.sealsWrites()) {
    body = `${title}\n${body}`;
    title = "Subagent (sealed)";
  }
  const note = store.create(
    {
      namespace: namespace ?? DEFAULT_NAMESPACE,
      title,
      body,
      tags: ["observation", "obs.type:discovery", "subagent", ...origin],
      source: CAPTURE_SOURCE,
      ...(derived.length ? { derived_from: derived } : {}),
    },
    { kind: "observation", sessionId, obsType: "discovery", skipEdges: true }
  );
  return note.id;
}
