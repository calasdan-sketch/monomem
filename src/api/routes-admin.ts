// REST routes: operator views and switches: sweep, insights, audit, quality, approve-first, access/flood, pinned, touched, rollback, quarantine.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { floodWritesPerHour, coerceNumeric, quarantineCasNote } from "../store.js";
import { DATA_DIR } from "../config.js";
import { readBody } from "../http-common.js";
import { insights, buildDigest, renderDigest } from "../digest.js";
import { readAudit, parseWindow } from "../audit-view.js";
import { maybeEmbed } from "../search-service.js";
import { resolveSince } from "../changes.js";
import { qualityReport } from "../quality.js";
import { rollbackPreview, rollbackConfirm, embedRestored } from "../rollback.js";
import { noteRollbackPreview, noteRollbackConfirm } from "../rollback-note.js";
import { noteTouched, touchedText } from "../blast-radius.js";
import type { Caller } from "../supersede.js";
import { heldEditDiff } from "../line-diff.js";
import { cachedFor, sendError, sendJson, intParam, parseJsonBody } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function adminRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, tokens } = c;
  const { req, res, url, path, principal, scope, nsCtx } = r;
  // Retention: POST /sweep-expired -> archive every note past its TTL.
  // Returns how many were archived. Safe to call on a timer/cron.
  if (req.method === "POST" && path === "/sweep-expired") {
    // A namespace-pinned principal may only retire its OWN namespace's notes.
    const archived = store.sweepExpired(Date.now(), nsCtx.active ? [nsCtx.ownNamespace] : undefined);
    sendJson(res, 200, { archived });
    return true;
  }

  // GET /quality -> the memory quality report (quality.ts). Admin; a namespace-pinned admin sees its own namespace only.
  // GET /insights -> the health score and the last day's digest (the dashboard's top card). Admin, no ceiling.
  if (req.method === "GET" && path === "/insights") {
    if (principal.max_sensitivity !== undefined || nsCtx.active) {
      sendJson(res, 403, { error: "this needs an administrator key with no sensitivity limit and no namespace restriction" });
      return true;
    }
    const open = tokens.filter((t) => t.label !== "primary" && t.scope !== "admin" && t.max_sensitivity === undefined).length;
    // The scan reads every note, so a refresh within a minute reuses the last answer.
    const body = await cachedFor(store, "insights", async () => {
      const ins = await insights(store, open, DATA_DIR, undefined);
      const digest = await buildDigest(store, "24h", {});
      return { health: { score: ins.health.score, deductions: ins.health.deductions, formula: ins.health.formula }, digest, text: renderDigest(digest) };
    });
    sendJson(res, 200, body);
    return true;
  }

  // GET /audit?since=24h&op=&label=&limit= -> who did what (metadata only). Admin, no ceiling.
  if (req.method === "GET" && path === "/audit") {
    if (principal.max_sensitivity !== undefined || nsCtx.active) {
      sendJson(res, 403, { error: "this needs an administrator key with no sensitivity limit and no namespace restriction" });
      return true;
    }
    const w = url.searchParams.get("since") ? parseWindow(url.searchParams.get("since")!) : 86_400_000;
    if (w === null) {
      sendJson(res, 400, { error: 'since must look like 30m, 24h or 7d' });
      return true;
    }
    const r = readAudit({ sinceMs: w, op: url.searchParams.get("op") || undefined, label: url.searchParams.get("label") || undefined, limit: Number(url.searchParams.get("limit")) || 200 });
    sendJson(res, 200, { entries: r.entries, truncated: r.truncated });
    return true;
  }

  if (req.method === "GET" && path === "/quality") {
    const namespace = url.searchParams.get("namespace") || undefined;
    const namespaces = nsCtx.active ? [nsCtx.ownNamespace] : namespace ? [namespace] : undefined;
    sendJson(res, 200, await cachedFor(store, "quality:" + (namespaces ?? []).join(","), () => qualityReport(store, namespaces)));
    return true;
  }

  // GET /approve-first -> { namespaces } with approve-first on; PUT /approve-first { namespace, on } flips it.
  // Admin-only (requiredScope). REST cannot tell an operator from an agent holding an admin token, so this is no
  // stronger than that token: an admin token can already approve held writes itself. No MCP tool reaches it.
  // A namespace-pinned admin sees and sets its own namespace only.
  if (path === "/approve-first" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "GET") {
      const all = store.approveFirstNamespaces();
      sendJson(res, 200, { namespaces: nsCtx.active ? all.filter((n) => n === nsCtx.ownNamespace) : all, all: store.approveFirstAll() });
      return true;
    }
    let body: { namespace?: unknown; on?: unknown; all?: unknown };
    try {
      body = parseJsonBody(await readBody(req)) as { namespace?: unknown; on?: unknown; all?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (body?.all === true) {
      // Store-wide switch: a namespace-pinned token may not touch it.
      if (typeof body.on !== "boolean") {
        sendJson(res, 400, { error: "expected { all: true, on: boolean }" });
      } else if (nsCtx.active) {
        sendJson(res, 403, { error: "this token is limited to one namespace and cannot set approve-first for all" });
      } else {
        store.setApproveFirstAll(body.on);
        sendJson(res, 200, { all: true, approve_first: body.on });
      }
      return true;
    }
    const ns = typeof body?.namespace === "string" ? body.namespace.trim() : "";
    if (!ns || typeof body.on !== "boolean") {
      sendJson(res, 400, { error: "expected { namespace: string, on: boolean }" });
      return true;
    }
    if (nsCtx.active && ns !== nsCtx.ownNamespace) {
      sendJson(res, 403, { error: `this token can only set approve-first on its own namespace ("${nsCtx.ownNamespace}")` });
      return true;
    }
    try {
      store.setApproveFirst(ns, body.on);
      sendJson(res, 200, { namespace: ns, approve_first: body.on });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // GET /access?since=&writer=&limit= -> the read access log; GET /flood -> paused writers; POST /flood/resume
  // { writer } lifts a pause. Admin-only (requiredScope), and refused for a namespace-pinned token: the log and the
  // flood guard are store-wide (one writer's queries cross namespaces). No MCP tool reaches any of them.
  if ((req.method === "GET" && (path === "/access" || path === "/flood")) || (req.method === "POST" && path === "/flood/resume")) {
    if (principal.namespace?.trim()) {
      sendJson(res, 403, { error: "the access log and flood guard are store-wide: use a token that is not pinned to a namespace" });
      return true;
    }
    // The access log keeps a redacted preview of what every app searched for: not for a key that has a sensitivity limit.
    if (principal.max_sensitivity !== undefined) {
      sendJson(res, 403, { error: "the access log shows what every app searched for: use an administrator key with no sensitivity limit" });
      return true;
    }
    try {
      if (path === "/access") {
        const since = url.searchParams.get("since");
        const writer = url.searchParams.get("writer");
        sendJson(res, 200, {
          entries: store.accessLog({
            ...(since ? { since: resolveSince(since) ?? undefined } : {}),
            ...(writer !== null ? { writer } : {}),
            limit: intParam(url, "limit", 1),
          }),
          paused: store.pausedWriters(),
        });
      } else if (path === "/flood") {
        sendJson(res, 200, { paused: store.pausedWriters(), writes_per_hour: floodWritesPerHour() });
      } else {
        let body: { writer?: unknown };
        try {
          body = parseJsonBody(await readBody(req)) as { writer?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        if (typeof body?.writer !== "string" || !body.writer.trim()) {
          sendJson(res, 400, { error: "expected { writer: string }" });
          return true;
        }
        sendJson(res, 200, { writer: body.writer, resumed: store.resumeWriter(body.writer), paused: store.pausedWriters() });
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // GET /pinned -> { notes } pinned; PUT /pinned { id, pinned } pins or unpins. Admin-only, like approve-first: REST cannot tell an
  // operator from an agent holding an admin token, so this is no stronger than that token. Changing a pinned note stays CLI-only
  // (an admin token that unpins a note can then change it: the pin protects against every other caller). No MCP tool reaches it.
  if (path === "/pinned" && (req.method === "GET" || req.method === "PUT")) {
    const own = nsCtx.active ? [nsCtx.ownNamespace] : undefined;
    if (req.method === "GET") {
      sendJson(res, 200, { notes: store.pinnedNotes(own) });
      return true;
    }
    let body: { id?: unknown; pinned?: unknown };
    try {
      body = parseJsonBody(await readBody(req)) as { id?: unknown; pinned?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const id = coerceNumeric(body?.id);
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || typeof body.pinned !== "boolean") {
      sendJson(res, 400, { error: "expected { id: number, pinned: boolean }" });
      return true;
    }
    try {
      // 1.4.0: a note from outside content that no person confirmed is refused (400, the message says what to do).
      if (!store.setPinned(id, body.pinned, own)) {
        sendJson(res, 404, { error: "no note with that number" });
        return true;
      }
    } catch (e) {
      sendError(res, e);
      return true;
    }
    sendJson(res, 200, { id, pinned: body.pinned });
    return true;
  }

  // GET /notes/:id/touched -> who read the note and what was built on it (blast-radius.ts), plus the same text the CLI prints.
  // Admin-only; refused for a namespace-pinned key and a key with a sensitivity limit, like /access (r4 L3): it comes from the
  // store-wide read log, which names readers from every namespace.
  const touched = req.method === "GET" ? /^\/notes\/(\d+)\/touched$/.exec(path) : null;
  if (touched) {
    if (principal.namespace?.trim()) {
      sendJson(res, 403, { error: "what a note touched comes from the store-wide read log: use a key that is not pinned to a namespace" });
      return true;
    }
    if (principal.max_sensitivity !== undefined) {
      sendJson(res, 403, { error: "what a note touched comes from the read log: use an administrator key with no sensitivity limit" });
      return true;
    }
    const own = nsCtx.active ? [nsCtx.ownNamespace] : undefined;
    const note = store.readVisible(Number(touched[1]));
    if (!note || (own && !own.includes(note.namespace))) {
      sendJson(res, 404, { error: `no note ${touched[1]}` });
      return true;
    }
    const t = noteTouched(store, note, { namespaces: own, operator: false });
    sendJson(res, 200, { ...t, text: touchedText(t) });
    return true;
  }

  // POST /rollback/preview { writer, since, include_conflicts? } -> the plan + a one-time code; POST /rollback/confirm { token }.
  // Admin-only (rollback.ts). REST counts as an agent: pinned notes and approve-first namespaces are listed as skipped.
  if (req.method === "POST" && (path === "/rollback/preview" || path === "/rollback/confirm")) {
    const caller: Caller = { scope, ...(nsCtx.active ? { ownNamespace: nsCtx.ownNamespace } : {}) };
    let b: { writer?: unknown; since?: unknown; include_conflicts?: unknown; token?: unknown; note?: unknown; include_likely?: unknown };
    try {
      b = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    try {
      // { note, include_likely? } instead of writer/since: roll back one note and what was built on it (rollback-note.ts).
      if (b.note !== undefined && (b.writer !== undefined || b.since !== undefined)) {
        sendJson(res, 400, { error: "pass note, or writer and since, not both" });
      } else if (b.note !== undefined && path === "/rollback/preview") {
        sendJson(res, 200, noteRollbackPreview(store, caller, { note: b.note, include_likely: b.include_likely, include_conflicts: b.include_conflicts }));
      } else if (b.note !== undefined) {
        const out = noteRollbackConfirm(store, caller, { token: b.token });
        await embedRestored(store, out);
        sendJson(res, 200, out);
      } else if (path === "/rollback/preview") {
        sendJson(res, 200, rollbackPreview(store, caller, { writer: b.writer, since: b.since, include_conflicts: b.include_conflicts }));
      } else {
        const out = rollbackConfirm(store, caller, { token: b.token });
        await embedRestored(store, out);
        sendJson(res, 200, out);
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // GET /quarantine -> the held writes with their reasons, for the dashboard's Held view (admin; a namespace-pinned admin sees its own).
  if (req.method === "GET" && path === "/quarantine") {
    const namespace = url.searchParams.get("namespace") || undefined;
    const namespaces = nsCtx.active ? [nsCtx.ownNamespace] : namespace ? [namespace] : undefined;
    sendJson(res, 200, { quarantine: store.listQuarantine({ namespaces, limit: 200 }) });
    return true;
  }

  // GET /quarantine/:id/context -> other notes in the namespace saved since the write was held, same topic (admin).
  const qCtxMatch = /^\/quarantine\/(\d+)\/context$/.exec(path);
  if (req.method === "GET" && qCtxMatch) {
    const id = Number(qCtxMatch[1]);
    const entry = store.getQuarantine(id);
    // Uniform "not found" for another namespace's entry: no existence oracle.
    const ctx = entry && !(nsCtx.active && entry.namespace !== nsCtx.ownNamespace) ? store.quarantineContext(id) : null;
    if (!ctx) {
      sendJson(res, 404, { error: `no quarantined write with id ${id}` });
      return true;
    }
    const diff = heldEditDiff(store, entry!);
    sendJson(res, 200, { ...ctx, ...(diff.length ? { diff } : {}), note: quarantineCasNote(ctx.op) });
    return true;
  }

  // POST /quarantine/:id/approve | keep-history | reject -> the memory_quarantine tool's actions, for the dashboard.
  const qMatch = /^\/quarantine\/(\d+)\/(approve|keep-history|reject)$/.exec(path);
  if (req.method === "POST" && qMatch) {
    const id = Number(qMatch[1]);
    const entry = store.getQuarantine(id);
    // Uniform "not found" for another namespace's entry: no existence oracle.
    if (!entry || (nsCtx.active && entry.namespace !== nsCtx.ownNamespace)) {
      sendJson(res, 404, { error: `no quarantined write with id ${id}` });
      return true;
    }
    try {
      if (qMatch[2] === "reject") {
        store.rejectQuarantine(id);
        sendJson(res, 200, { rejected: id });
      } else if (qMatch[2] === "keep-history") {
        let b: { by?: unknown } = {};
        try {
          b = parseJsonBody(await readBody(req)) as { by?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        const by = b.by === undefined ? undefined : typeof b.by === "number" && Number.isSafeInteger(b.by) && b.by > 0 ? b.by : typeof b.by === "string" && /^[1-9][0-9]{0,14}$/.test(b.by) ? Number(b.by) : null;
        if (by === null) {
          sendJson(res, 400, { error: "by must be a note id (a positive whole number)" });
          return true;
        }
        const kept = store.keepQuarantineAsHistory(id, by);
        await maybeEmbed(store, kept.note);
        // 1.5.0 (S-01): ids only, as over MCP: approving must not echo the flagged text back.
        sendJson(res, 200, { kept_as_history: id, note_id: kept.note.id, superseded_by: kept.superseded_by });
      } else {
        const note = store.approveQuarantine(id);
        await maybeEmbed(store, note);
        sendJson(res, 200, { approved: id, note_id: note.id });
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  return false;
}
