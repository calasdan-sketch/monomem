// REST routes: GET /digest (what changed since I last looked, by whom, what conflicts) and GET /notes/:id/readers (who read a note, when).
// /digest answers like the other read routes (readable namespaces, readVisible per note); /notes/:id/readers is admin-only and
// refused for a pinned or sensitivity-limited key, like /notes/:id/touched: the read log names readers from every namespace.
import { currentWriter } from "../actor.js";
import { buildHandoffDigest } from "../handoff-digest.js";
import { readersOf } from "../store/readers.js";
import { blameRoutes } from "./routes-blame.js";
import { sendError, sendJson, flagParam } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function digestRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, readable, trustedHint } = c;
  const { req, res, url, path, principal, scope, nsCtx } = r;
  if (req.method !== "GET") return false;
  if (await blameRoutes(c, r)) return true;
  try {
    if (path === "/digest") {
      const hint = url.searchParams.get("namespace") ?? undefined;
      const t = nsCtx.active ? trustedHint(nsCtx, hint) : hint;
      const namespaces = nsCtx.active ? (t ? [t] : readable(nsCtx)) : t ? [t] : undefined;
      const self = flagParam(url, "include_own") ? undefined : currentWriter();
      sendJson(res, 200, buildHandoffDigest(store, { since: url.searchParams.get("since") ?? undefined, namespaces, self, includeHeld: scope === "admin" }));
      return true;
    }
    const m = /^\/notes\/(\d+)\/readers$/.exec(path);
    if (!m) return false;
    if (principal.namespace?.trim() || principal.max_sensitivity !== undefined) {
      sendJson(res, 403, { error: "who read a note comes from the store-wide read log: use an administrator key with no namespace pin and no sensitivity limit" });
      return true;
    }
    const note = store.readVisible(Number(m[1]));
    if (!note) {
      sendJson(res, 404, { error: `no note ${m[1]}` });
      return true;
    }
    sendJson(res, 200, { id: note.id, namespace: note.namespace, last_changed_at: note.updated_at, ...readersOf(store.captureDb(), note.id), not_recorded: "Only apps and agents are recorded (not the owner's own shell), and only inside the access-log window." });
    return true;
  } catch (e) {
    sendError(res, e);
    return true;
  }
}
