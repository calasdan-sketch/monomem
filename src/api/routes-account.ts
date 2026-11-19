// REST routes: who am I, server status, and the app keys: GET /whoami, GET /status, /tokens.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { sha256Hex } from "../config.js";
import { readBody, healthBody } from "../http-common.js";
import { TokenAdminError, addApp, removeApp, listApps, describeAccess, connectionSnippet } from "../tokens-admin.js";
import { lastUsed, sendJson } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function accountRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, tokens } = c;
  const { req, res, path, principal, nsCtx } = r;
  // GET /whoami -> who this token is and what it can see (the dashboard's signed-in banner; a quick connection test).
  if (req.method === "GET" && path === "/whoami") {
    lastUsed.set(principal.label, new Date().toISOString());
    const view = { scope: principal.scope, namespace: principal.namespace ?? null, max_sensitivity: principal.max_sensitivity ?? null };
    sendJson(res, 200, { label: principal.label || "(unnamed)", ...view, can_see: describeAccess(view) });
    return true;
  }
  lastUsed.set(principal.label, new Date().toISOString());

  // GET /status (admin) -> this server's build and the state of its in-memory body index (C-06): what /health leaves out
  // for unauthenticated callers. `monomem doctor` reads it from a server it has verified (local-server.ts).
  if (req.method === "GET" && path === "/status") {
    sendJson(res, 200, { ...healthBody(true), body_index: store.bodyIndexInfo() });
    return true;
  }

  // Apps that may connect (admin only, and only an administrator with no ceiling and no namespace pin: it would otherwise
  // be a way to hand out wider access than it has itself). Secrets are never returned except the new one, once.
  if (path === "/tokens" || path.startsWith("/tokens/")) {
    if (principal.max_sensitivity !== undefined || nsCtx.active) {
      sendJson(res, 403, { error: "managing apps needs an administrator token that has no sensitivity limit and no namespace pin" });
      return true;
    }
    try {
      if (req.method === "GET" && path === "/tokens") {
        sendJson(res, 200, { apps: listApps().map((a) => ({ ...a, last_used: lastUsed.get(a.label) ?? null })) });
        return true;
      }
      if (req.method === "POST" && path === "/tokens") {
        let b: { label?: unknown; scope?: unknown; namespace?: unknown; max?: unknown; max_sensitivity?: unknown; admin?: unknown; no_limit?: unknown };
        try {
          b = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        const TOKEN_FIELDS = ["label", "scope", "namespace", "max", "max_sensitivity", "admin", "no_limit"];
        const unknownField = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b).find((k) => !TOKEN_FIELDS.includes(k)) : undefined;
        if (unknownField !== undefined || b === null || typeof b !== "object" || Array.isArray(b)) {
          sendJson(res, 400, { error: unknownField !== undefined ? `unknown field "${unknownField.slice(0, 40)}"; valid fields: ${TOKEN_FIELDS.join(", ")}` : `body must be a JSON object; valid fields: ${TOKEN_FIELDS.join(", ")}` });
          return true;
        }
        if (typeof b.max === "string" && typeof b.max_sensitivity === "string" && b.max !== b.max_sensitivity) {
          sendJson(res, 400, { error: "send max_sensitivity or max, not two different values" });
          return true;
        }
        // An admin key or a key with no sensitivity limit is as strong as the main key: only the main key may make one here.
        if ((b.admin === true || b.no_limit === true) && principal.label !== "primary") {
          sendJson(res, 403, { error: "only the main (primary) token can make an administrator app or an app with no sensitivity limit over REST; use: monomem keys add <name> --admin / --no-limit" });
          return true;
        }
        const made = addApp({
          label: String(b.label ?? ""),
          ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
          ...(typeof b.namespace === "string" ? { namespace: b.namespace } : {}),
          ...(typeof b.max_sensitivity === "string" ? { max: b.max_sensitivity } : typeof b.max === "string" ? { max: b.max } : {}),
          admin: b.admin === true,
          // Only reachable here: this branch already requires a caller with no limit and no namespace pin.
          noLimit: b.no_limit === true,
          by: principal.label || "(unnamed)",
        });
        // Take effect now, not at the next 2-second check (only this change is applied, nothing else is re-read).
        tokens.push({ token_sha256: sha256Hex(made.token), scope: made.app.scope, label: made.app.label, ...(made.app.namespace ? { namespace: made.app.namespace } : {}), ...(made.app.max_sensitivity ? { max_sensitivity: made.app.max_sensitivity } : {}) });
        sendJson(res, 201, { token: made.token, app: made.app, access: describeAccess(made.app), ceiling_was_default: made.ceilingWasDefault, snippet: connectionSnippet(made.token) });
        return true;
      }
      const del = /^\/tokens\/(.+)$/.exec(path);
      if (req.method === "DELETE" && del) {
        let label: string;
        try {
          label = decodeURIComponent(del[1]);
        } catch {
          sendJson(res, 400, { error: "that app name is not valid (bad % escape)" });
          return true;
        }
        if (label.toLowerCase() === "primary") {
          sendJson(res, 400, { error: "the main token cannot be removed here; it is set outside Monomem (MONOMEM_TOKEN or the token file)" });
          return true;
        }
        if (!removeApp(label, principal.label || "(unnamed)")) {
          sendJson(res, 404, { error: `no app called "${label}" in tokens.json (apps set in the environment cannot be removed here)` });
          return true;
        }
        for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].label.toLowerCase() === label.trim().toLowerCase() && tokens[i].label !== "primary") tokens.splice(i, 1);
        sendJson(res, 200, { removed: label });
        return true;
      }
    } catch (e) {
      if (e instanceof TokenAdminError) {
        sendJson(res, 400, { error: e.message });
        return true;
      }
      throw e;
    }
    sendJson(res, 404, { error: "no such route" });
    return true;
  }
  return false;
}
