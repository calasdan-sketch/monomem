// REST routes: automatic memory and the change feed: /index, /timeline, /get, /sessions, /files/timeline, /capture, /rebuild-edges, /changes.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { currentCeiling, currentWriter } from "../actor.js";
import { RebuildBusyError, resolveEdgeThreshold, REBUILD_CONFIRM_NOTE_COUNT, DEFAULT_NAMESPACE } from "../store.js";
import { tokenKey, audit } from "../security.js";
import { tokenId } from "../config.js";
import { readBody } from "../http-common.js";
import { waitForChanges, parseWait, WaitBusyError } from "../change-wait.js";
import { memoryIndex, memoryTimeline, memoryGet, sessionList, sessionGet, fileTimeline, type ReadScope } from "../progressive.js";
import { HOOK_EVENTS, type HookEvent, isOwnTool, recordEvent, cleanField } from "../capture.js";
import { distillSession } from "../extract.js";
import { sendError, sendJson, ackModeParam, feedWriterFilter, flagParam, waitScopeKey, intParam } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function sessionRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, readable, trustedHint } = c;
  const { req, res, url, path, principal, nsCtx, setReadQuery } = r;
  // ---- Automatic memory (progressive.ts; the MCP tools memory_index / memory_timeline / memory_get / session_list) ----
  // Reads: GET /index, GET /timeline, POST /get (read scope despite the POST: the ids are a body), GET /sessions,
  // GET /sessions/:id, GET /files/timeline?path=. Write: POST /capture (a hook that could not open the local database).
  const capRead = (): ReadScope => {
    const hint = url.searchParams.get("namespace") ?? undefined;
    return {
      namespaces: nsCtx.active ? (trustedHint(nsCtx, hint) ? [hint!] : readable(nsCtx)) : hint ? [hint] : undefined,
      ...(flagParam(url, "include_distrusted") ? { includeDistrusted: true } : {}),
    };
  };
  const sessMatch = /^\/sessions\/([^/]+)$/.exec(path);
  if (
    (req.method === "GET" && path === "/index") ||
    (req.method === "GET" && path === "/timeline") ||
    (req.method === "GET" && path === "/sessions") ||
    (req.method === "GET" && path === "/files/timeline") ||
    (req.method === "GET" && sessMatch) ||
    (req.method === "POST" && path === "/get")
  ) {
    try {
      const q = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
      if (path === "/index") {
        sendJson(res, 200, memoryIndex(store, capRead(), { query: q("q") ?? q("query"), kind: q("kind"), obs_type: q("obs_type"), file: q("file"), session: q("session"), since: q("since"), limit: intParam(url, "limit", 1) }));
      } else if (path === "/timeline") {
        sendJson(res, 200, memoryTimeline(store, capRead(), { anchor: intParam(url, "anchor", 1), query: q("q") ?? q("query"), file: q("file"), session: q("session"), before: intParam(url, "before", 1), after: intParam(url, "after", 1) }));
      } else if (path === "/get") {
        let body: { ids?: unknown };
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        setReadQuery({ ids: body.ids });
        sendJson(res, 200, memoryGet(store, capRead(), body.ids));
      } else if (path === "/sessions") {
        sendJson(res, 200, sessionList(store, capRead(), intParam(url, "limit", 1)));
      } else if (path === "/files/timeline") {
        sendJson(res, 200, fileTimeline(store, capRead(), q("path") ?? "", intParam(url, "limit", 1)));
      } else {
        const one = sessionGet(store, capRead(), decodeURIComponent(sessMatch![1]));
        if (one) sendJson(res, 200, one);
        else sendJson(res, 404, { error: "no such session" });
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // POST /capture: one hook event, from a capture hook that could not use the local database (MONOMEM_HOOK_URL).
  // The event is redacted AGAIN here (never trust the sender to have done it), lands in the token's own namespace
  // when namespaces are resolved, and cannot be appended to another namespace's session.
  if (req.method === "POST" && path === "/capture") {
    let b: Record<string, unknown>;
    try {
      b = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) b = {};
    const ev = typeof b.event === "string" && (HOOK_EVENTS as readonly string[]).includes(b.event) ? (b.event as HookEvent) : null;
    if (!ev || typeof b.session_id !== "string" || !b.session_id.trim()) {
      sendJson(res, 400, { error: `event (one of ${HOOK_EVENTS.join(", ")}) and session_id are required` });
      return true;
    }
    const s = (k: string, max: number): string => (typeof b[k] === "string" ? (b[k] as string) : "").slice(0, max);
    const capNs = nsCtx.active ? nsCtx.ownNamespace : s("namespace", 200).trim() || DEFAULT_NAMESPACE;
    try {
      const owner = store.captureDb().prepare("SELECT namespace, writer FROM sessions WHERE id = ?").get(b.session_id) as { namespace: string; writer: string | null } | undefined;
      if (owner && owner.namespace !== capNs) {
        sendJson(res, 409, { error: "that session belongs to another namespace" });
        return true;
      }
      // A session is one writer's: another key adding events (or ending it, which writes its summary) is refused.
      if (owner && owner.writer && owner.writer !== currentWriter()) {
        sendJson(res, 409, { error: "that session belongs to another writer" });
        return true;
      }
      const tool = s("tool", 200);
      if (tool && isOwnTool(tool)) {
        sendJson(res, 202, { stored: false });
        return true;
      }
      const input = s("input", 64 * 1024);
      const output = s("output", 64 * 1024);
      recordEvent(store, { session_id: b.session_id.slice(0, 200), cwd: s("cwd", 1000), event: ev, tool, input: cleanField(input), output: cleanField(output), ok: b.ok !== false, bytes: input.length + output.length, at: new Date().toISOString() }, capNs);
      if (ev === "stop" || ev === "session-end") distillSession(store, b.session_id.slice(0, 200));
      sendJson(res, 202, { stored: true });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // POST /rebuild-edges { threshold?, namespace?, confirm? } -> { created, removed }
  // Mirrors the memory_rebuild_edges MCP tool: recalculates the note
  // similarity graph from scratch. Admin scope; under server-side
  // namespace resolution the rebuild is confined to the server's own
  // namespace (writes stay local, like memory_consolidate). Runs the
  // cooperative chunked rebuild, so it yields to the event loop and
  // commits per chunk instead of freezing the server in one giant
  // transaction; an interrupted run resumes from its _meta marker.
  // Same confirmation gate as the MCP tool: above
  // REBUILD_CONFIRM_NOTE_COUNT notes in scope it answers 409 with the
  // workload unless the body carries confirm: true. One rebuild at a
  // time: a concurrent request gets 409.
  if (req.method === "POST" && path === "/rebuild-edges") {
    // The rebuild scores every note in scope and reports edge counts, so it cannot be limited to the notes a ceiling allows.
    if (currentCeiling() !== undefined) {
      sendJson(res, 403, { error: "rebuilding the similarity graph covers every note; it needs a token with no sensitivity ceiling" });
      return true;
    }
    const raw = await readBody(req);
    let parsed: { threshold?: unknown; namespace?: unknown; confirm?: unknown };
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const threshold =
      parsed.threshold === undefined ? undefined : Number(parsed.threshold);
    const relNs =
      typeof parsed.namespace === "string" ? parsed.namespace : undefined;
    try {
      // resolveEdgeThreshold throws ValidationError on out-of-range
      // input -> 400 via sendError, never a 500.
      resolveEdgeThreshold(threshold);
      const scopeNs = nsCtx.active ? nsCtx.ownNamespace : relNs;
      const plan = store.rebuildPlan(scopeNs ? { namespace: scopeNs } : {});
      const notes = plan.reduce((s, g) => s + g.notes, 0);
      const pairs = plan.reduce((s, g) => s + g.pairs, 0);
      if (notes > REBUILD_CONFIRM_NOTE_COUNT && parsed.confirm !== true) {
        sendJson(res, 409, {
          error:
            `refusing: rebuilding edges would score ~${pairs.toLocaleString("en-US")} pairs ` +
            `across ${notes.toLocaleString("en-US")} notes (over the ` +
            `${REBUILD_CONFIRM_NOTE_COUNT}-note confirmation threshold); ` +
            "re-send with confirm: true to proceed",
          notes,
          pairs,
        });
        return true;
      }
      const result = await store.rebuildEdgesCooperative({
        threshold,
        namespace: scopeNs,
      });
      sendJson(res, 200, {
        ...result,
        namespace: scopeNs ?? null,
      });
    } catch (e) {
      if (e instanceof RebuildBusyError) {
        sendJson(res, 409, { error: e.message });
        return true;
      }
      sendError(res, e);
    }
    return true;
  }

  // GET /changes?since=<ISO|24h|last>&cursor=&namespace=&source=&limit=&consumer=
  // Change feed, mirroring the memory_since MCP tool (read scope;
  // namespace gating identical to /stats).
  if (req.method === "GET" && path === "/changes") {
    const namespace = url.searchParams.get("namespace") ?? undefined;
    let namespaces: string[] | undefined;
    if (nsCtx.active) {
      const hint = trustedHint(nsCtx, namespace);
      namespaces = hint ? [hint] : readable(nsCtx);
    } else {
      namespaces = namespace ? [namespace] : undefined;
    }
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
      sendJson(res, 400, { error: "limit must be an integer" });
      return true;
    }
    // &wait=<seconds> (0-55): long-poll -- hold the request until the
    // feed has something new for this token's scope (see change-wait.ts).
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once("close", onClose);
    try {
      const out = await waitForChanges(
        store,
        {
          since: url.searchParams.get("since") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          namespaces,
          source: url.searchParams.get("source") ?? undefined,
          ...feedWriterFilter(url),
          limit: limitRaw !== null ? Number(limitRaw) : undefined,
          consumer: url.searchParams.get("consumer") ?? undefined,
          ackMode: ackModeParam(url),
          ackToken: url.searchParams.get("ack_token") ?? undefined,
          excludeSelf: flagParam(url, "exclude_self"),
        },
        {
          // `wait` and `wait_seconds` are the same thing (MCP spells it wait_seconds).
          waitSeconds: parseWait(url.searchParams.get("wait") ?? url.searchParams.get("wait_seconds")),
          signal: abort.signal,
          key: tokenKey(tokenId(principal)),
          scopeKey: waitScopeKey(namespaces),
        }
      );
      if (url.searchParams.get("ack_token")) audit({ op: "changes.ack", label: principal.label, kind: "changes", detail: `consumer=${out.consumer ?? ""}` });
      sendJson(res, 200, { ...out, searchedNamespaces: namespaces ?? [] });
    } catch (e) {
      if (e instanceof WaitBusyError) sendJson(res, 429, { error: e.message });
      else sendError(res, e);
    } finally {
      res.off("close", onClose);
    }
    return true;
  }
  return false;
}
