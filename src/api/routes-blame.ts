// REST routes: GET /blame?q=<claim> and GET /ask?q=<question>[&since=&writer=&limit=] (blame.ts). Read-only. They search through the
// same read policy as GET /search (the caller's namespaces and sensitivity ceiling, the distrust list). Replaced notes and held-edit
// counts are an administrator's view: include_superseded=1 and the held count need an admin key; a distrusted writer's notes are never shown here.
import { askTimeline, blame, sinceIso, type SearchScope } from "../blame.js";
import { sendError, sendJson, flagParam, intParam } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function blameRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { req, res, url, path, nsCtx, isAdmin } = r;
  if (req.method !== "GET" || (path !== "/blame" && path !== "/ask")) return false;
  try {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return sendJson(res, 400, { error: "q is required" }), true;
    if (flagParam(url, "include_superseded") && !isAdmin) return sendJson(res, 403, { error: "include_superseded needs an admin key" }), true;
    const hint = url.searchParams.get("namespace") ?? undefined;
    const trusted = nsCtx.active ? c.trustedHint(nsCtx, hint) : hint;
    const namespaces = nsCtx.active ? (trusted ? [trusted] : c.readable(nsCtx)) : trusted ? [trusted] : undefined;
    const scope: SearchScope = { namespaces, includeSuperseded: flagParam(url, "include_superseded"), includeDistrusted: false, showHeld: isAdmin };
    const limit = intParam(url, "limit", 1);
    if (path === "/blame") return sendJson(res, 200, await blame(c.store, q, scope, limit)), true;
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw ? sinceIso(sinceRaw) : null;
    if (sinceRaw && !since) return sendJson(res, 400, { error: "since must be a window like 7d or 24h, or a date" }), true;
    return sendJson(res, 200, await askTimeline(c.store, q, scope, { since: since ?? undefined, writer: url.searchParams.get("writer") ?? undefined, limit })), true;
  } catch (e) {
    sendError(res, e);
    return true;
  }
}
