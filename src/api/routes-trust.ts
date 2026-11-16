// REST routes: the trust policy: /trust, /trust/distrust, /trust/attesters, /trust/revoked.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { readBody } from "../http-common.js";
import { sendError, sendJson } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function trustRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store } = c;
  const { req, res, url, path, nsCtx } = r;
  // --- Trust policy (admin scope; see docs/trust.md) ---
  // GET    /trust                      identity, distrusted writers, trusted attesters, recent log
  // POST   /trust/distrust             { namespace, writer }   distrust a writer label or writer_id
  // DELETE /trust/distrust             ?namespace=&writer=     (or the same JSON body)
  // POST   /trust/attesters            { public_key, server_id?, label? }
  // DELETE /trust/attesters/:key_id
  // POST   /trust/revoked              { key_id, reason? }     stop believing anything a key signed (a leaked key)
  // DELETE /trust/revoked/:key_id
  // A token pinned to a namespace can only manage that namespace's rules (never "*"),
  // and cannot change the server-wide attester list.
  if (path === "/trust" || path.startsWith("/trust/")) {
    try {
      const pinned = nsCtx.active;
      const body = async (): Promise<Record<string, unknown> | null> => {
        const raw = await readBody(req);
        try {
          const v = JSON.parse(raw || "{}");
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          /* fall through */
        }
        sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
        return null;
      };
      const ruleScope = (ns: unknown): string | null => {
        const v = typeof ns === "string" ? ns.trim() : "";
        if (pinned) {
          if (v && v !== nsCtx.ownNamespace) {
            sendJson(res, 403, { error: "this token is pinned to its own namespace" });
            return null;
          }
          return nsCtx.ownNamespace;
        }
        return v;
      };
      if (req.method === "GET" && path === "/trust") {
        // Read-only: the key is reported only if one already exists (a listing never creates it).
        const view = store.trustView(pinned ? nsCtx.ownNamespace : undefined);
        sendJson(res, 200, { ...store.peekIdentity(), distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log });
        return true;
      }
      if (path === "/trust/distrust" && (req.method === "POST" || req.method === "DELETE")) {
        const b = req.method === "POST" ? await body() : ((await body()) ?? null);
        if (!b) return true;
        const ns = ruleScope(url.searchParams.get("namespace") ?? b.namespace);
        if (ns === null) return true;
        const writer = url.searchParams.get("writer") ?? b.writer;
        if (req.method === "POST") {
          const added = store.distrustAdd(ns, writer as string);
          sendJson(res, 200, { distrust: added, matched_notes: store.distrustMatchCount(added.namespace, added.writer), rules: store.trustView(pinned ? nsCtx.ownNamespace : undefined).distrust });
        } else {
          const removed = store.distrustRemove(ns, writer as string);
          sendJson(res, 200, { removed, rules: store.trustView(pinned ? nsCtx.ownNamespace : undefined).distrust });
        }
        return true;
      }
      if (path === "/trust/attesters" && req.method === "POST") {
        if (pinned) {
          sendJson(res, 403, { error: "the attester list is server-wide: use an admin token that is not pinned to a namespace" });
          return true;
        }
        const b = await body();
        if (!b) return true;
        const added = store.attesterAdd({
          public_key: b.public_key as string,
          server_id: typeof b.server_id === "string" ? b.server_id : undefined,
          label: typeof b.label === "string" ? b.label : undefined,
          any_server: b.any_server === true,
          not_after: typeof b.not_after === "string" ? b.not_after : undefined,
        });
        sendJson(res, 200, { attester: added, attesters: store.attesterList() });
        return true;
      }
      const attDel = /^\/trust\/attesters\/([0-9a-fA-F]{16})$/.exec(path);
      if (attDel && req.method === "DELETE") {
        if (pinned) {
          sendJson(res, 403, { error: "the attester list is server-wide: use an admin token that is not pinned to a namespace" });
          return true;
        }
        sendJson(res, 200, { removed: store.attesterRemove(attDel[1]), attesters: store.attesterList() });
        return true;
      }
      if (path === "/trust/revoked" && req.method === "POST") {
        if (pinned) {
          sendJson(res, 403, { error: "the revocation list is server-wide: use an admin token that is not pinned to a namespace" });
          return true;
        }
        const b = await body();
        if (!b) return true;
        const r = store.attesterRevoke(typeof b.key_id === "string" ? b.key_id : "", typeof b.reason === "string" ? b.reason : "");
        sendJson(res, 200, { revoked: r, revocations: store.revocationList() });
        return true;
      }
      const revDel = /^\/trust\/revoked\/([0-9a-fA-F]{16})$/.exec(path);
      if (revDel && req.method === "DELETE") {
        if (pinned) {
          sendJson(res, 403, { error: "the revocation list is server-wide: use an admin token that is not pinned to a namespace" });
          return true;
        }
        sendJson(res, 200, { removed: store.attesterUnrevoke(revDel[1]), revocations: store.revocationList() });
        return true;
      }
      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  return false;
}
