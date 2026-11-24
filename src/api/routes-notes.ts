// REST routes: one note: POST /notes, GET/PUT/DELETE /notes/:id, confirm, flag, archive, restore, /supersede/*, history.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { NoteInput, NotePatch, NoteRecord, StaleWriteError, ValidationError, validateForgetAfter, coerceNumeric } from "../store.js";
import { RECEIPT_CHECK } from "../store/write-receipt.js";
import { checkFilesInput } from "../code-anchor.js";
import { readBody } from "../http-common.js";
import { maybeEmbed } from "../search-service.js";
import { annotateStaleness } from "../staleness.js";
import { supersedePreview, supersedeConfirm, supersedeUndo, noteHistory, restoreVersion, purgeNoteHistory, type Caller } from "../supersede.js";
import { withFacts, factFeedback } from "../facts.js";
import { assertPlainWriteTags, assertReviewedTag } from "../reserved-tags.js";
import { prepareNoteUpdate, overwriteNotice, staleDetail } from "../note-update.js";
import { currentWriter } from "../actor.js";
import { UNTRUSTED_BANNER } from "../security.js";
import { ReadTaint, unconfirmedIdsIn } from "../taint.js";
import type { LintFinding } from "../lint.js";
import { POST_NOTE_FIELDS, PUT_NOTE_FIELDS, PUT_READ_ONLY_FIELDS, unknownNoteFields, sendError, sendJson, flagParam, parseJsonBody } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function noteRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, annotRead, dashboardSessions, denyUnreadable, denyUnwritable } = c;
  const { req, res, url, path, principal, scope, actorRef, nsCtx, isAdmin } = r;
  // POST /notes
  if (req.method === "POST" && path === "/notes") {
    const raw = await readBody(req);
    let parsed: NoteInput;
    try {
      parsed = parseJsonBody(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const badPost = unknownNoteFields(parsed, POST_NOTE_FIELDS);
    if (badPost) {
      sendJson(res, 400, { error: badPost });
      return true;
    }
    if (!parsed.title || typeof parsed.title !== "string") {
      sendJson(res, 400, { error: "title is required" });
      return true;
    }
    // A backdate rewrites history: only an admin key (restores use POST /import, also admin) may set it.
    if (parsed.created_at !== undefined && !isAdmin) {
      sendJson(res, 400, { error: "created_at needs the 'admin' scope; leave it out and the note is dated now" });
      return true;
    }
    if (parsed.outside !== undefined && typeof parsed.outside !== "boolean") {
      sendJson(res, 400, { error: "outside must be true or false" });
      return true;
    }
    if (parsed.forget_after !== undefined) parsed.forget_after = coerceNumeric(parsed.forget_after) as number;
    if (parsed.confidence !== undefined) parsed.confidence = coerceNumeric(parsed.confidence) as number;
    try {
      // When namespace resolution is active the client-supplied namespace
      // is untrusted: writes always land in the server-resolved namespace.
      if (nsCtx.active) parsed.namespace = nsCtx.ownNamespace;
      assertPlainWriteTags(parsed.tags);
      assertReviewedTag(parsed.tags, undefined, isAdmin);
      const { facts } = parsed as { facts?: unknown };
      delete (parsed as { facts?: unknown }).facts;
      parsed.tags = withFacts(parsed.tags, facts);
      const { client_key: clientKey } = parsed as { client_key?: unknown };
      delete (parsed as { client_key?: unknown }).client_key;
      if (clientKey !== undefined && typeof clientKey !== "string") {
        sendJson(res, 400, { error: "client_key must be a string" });
        return true;
      }
      // R2-03: the files the note is about, anchored in git (same rules as state_write).
      const anchorFiles = checkFilesInput((parsed as { files?: unknown }).files);
      delete (parsed as { files?: unknown }).files;
      const warnings: LintFinding[] = [];
      store.takeWriteReceipt(); // drop a decision left by an earlier call
      const once = store.createOnce(parsed, clientKey, { lintWarnings: warnings, ...(anchorFiles ? { files: anchorFiles } : {}) });
      const receipt = store.takeWriteReceipt(); // R2-06, read before any await
      // R2-04: a retry with a known key wrote nothing; 200 with the note the first write made.
      if (once.deduplicated) {
        // final-security SF6: another writer may have changed the note since. Like MCP: no body; and an unconfirmed note
        // marks this token as a read would (creating routes are otherwise exempt from read-taint).
        const reads = actorRef?.taintedReads;
        if (reads instanceof ReadTaint) for (const id of unconfirmedIdsIn(once.note)) reads.add(id);
        const { body: _body, ...note } = once.note;
        sendJson(res, 200, { note, deduplicated: true });
        return true;
      }
      const note = once.note;
      await maybeEmbed(store, note);
      const sim = store.similarNote(note.id);
      sendJson(res, 201, { note, ...(receipt ? { receipt, receipt_check: RECEIPT_CHECK } : {}), ...(sim ? { similar_note: { id: sim.id, title: sim.title, hint: `looks similar to #${sim.id} - consider updating it (PUT /notes/${sim.id}) if this is the same thing` } } : {}), ...(warnings.length ? { warnings } : {}), ...(facts === undefined ? {} : factFeedback(store, note)) });
    } catch (e) {
      sendError(res, e, store.refusedWriteReceipt(e));
    }
    return true;
  }

  // GET /notes/:id
  const idMatch = /^\/notes\/(\d+)$/.exec(path);
  if (req.method === "GET" && idMatch) {
    const id = Number(idMatch[1]);
    // BLOCKER 4: gate before tracking. The probe is an untracked read
    // (no writes, no neighbor work); only an authorized read bumps the
    // access counters, so a denied cross-namespace read can't pollute
    // importance weighting or search ranking. Without namespace
    // resolution there is no cross-namespace boundary, so the probe is
    // just a 404 check (denyUnreadable's canRead gate would 404 every
    // read when nsCtx.ownNamespace is "").
    const probe = store.read(id); // gate-ok: access probe: denyUnreadable/readVisible decide before anything is returned
    // A note whose writer an admin distrusts reads as "not found" unless
    // the caller opts in with ?include_distrusted=1 (admin only; then it is marked).
    const wantDistrusted = flagParam(url, "include_distrusted") && (!nsCtx.active || probe?.namespace === nsCtx.ownNamespace);
    if (nsCtx.active) {
      if (!denyUnreadable(nsCtx, res, probe)) return true;
    } else if (!probe) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    // Authorized: the ONE gated read, with tracking so the returned
    // counters include this read. ?neighbors=true attaches up to 10
    // same-namespace similar notes with similarity scores (and their
    // staleness fields), mirroring the MCP state_read neighbors:true option.
    const withNeighbors = url.searchParams.get("neighbors") === "true";
    const note = store.readVisible(id, { hideArchived: true, trackAccess: true, withNeighbors, includeDistrusted: wantDistrusted });
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    // Round edge scores to 3 decimals for readability (stored raw in
    // SQLite), mirroring the MCP state_read tool. Neighbor entries
    // already carry their staleness fields (annotated in Store.read).
    const base = annotRead(note);
    const outNote = note.neighbors
      ? {
          ...base,
          neighbors: note.neighbors.map((n) => ({
            ...n,
            score: Math.round(n.score * 1000) / 1000,
          })),
        }
      : base;
    sendJson(res, 200, { note: outNote });
    return true;
  }

  // PUT /notes/:id
  if (req.method === "PUT" && idMatch) {
    const id = Number(idMatch[1]);
    const raw = await readBody(req);
    let parsed: NotePatch;
    try {
      parsed = parseJsonBody(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const badPut = unknownNoteFields(parsed, PUT_NOTE_FIELDS, PUT_READ_ONLY_FIELDS);
    if (!badPut && parsed && typeof parsed === "object") for (const k of PUT_READ_ONLY_FIELDS) delete (parsed as Record<string, unknown>)[k];
    if (badPut) {
      sendJson(res, 400, { error: badPut });
      return true;
    }
    if (parsed && parsed.outside !== undefined && typeof parsed.outside !== "boolean") {
      sendJson(res, 400, { error: "outside must be true or false" });
      return true;
    }
    if (parsed && parsed.forget_after !== undefined) parsed.forget_after = coerceNumeric(parsed.forget_after) as number;
    if (parsed && parsed.confidence !== undefined && parsed.confidence !== null) parsed.confidence = coerceNumeric(parsed.confidence) as number;
    // Compare-and-swap, as in the MCP tool state_write: `if_rev` is the revision the caller last read; the edit is
    // refused (409) when the note has moved on, instead of silently replacing a newer write.
    let ifRev: number | undefined;
    if (parsed && typeof parsed === "object" && "if_rev" in parsed) {
      const raw = coerceNumeric((parsed as { if_rev?: unknown }).if_rev);
      delete (parsed as { if_rev?: unknown }).if_rev;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
          sendJson(res, 400, { error: "if_rev must be a whole number (the rev you last read)" });
          return true;
        }
        ifRev = raw;
      }
    }
    try {
      // `facts` as in the MCP update: they replace the note's fact tags and keep its other tags.
      const putFacts = (parsed as { facts?: unknown }).facts;
      if (putFacts !== undefined) delete (parsed as { facts?: unknown }).facts;
      // The same checks as MCP state_write (note-update.ts): a hidden, forgotten, missing or (for a pinned token) other
      // namespace's note is 404 -- grants are read-only -- before any tag rule can answer.
      const check = prepareNoteUpdate(store, { admin: isAdmin, mayReview: isAdmin, ...(nsCtx.active ? { ownNs: nsCtx.ownNamespace } : {}) }, id, parsed.tags, putFacts);
      if (!check.ok) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      // The client-supplied namespace is dropped for a pinned token (the note keeps its existing namespace).
      if (nsCtx.active) delete parsed.namespace;
      if (check.tags !== undefined) parsed.tags = check.tags;
      const warnings: LintFinding[] = [];
      store.takeWriteReceipt(); // drop a decision left by an earlier call
      const { unchanged, ...note } = store.update(id, parsed, { lintWarnings: warnings, ...(ifRev !== undefined ? { ifRev } : {}) }) ?? ({} as NoteRecord);
      const receipt = store.takeWriteReceipt(); // R2-06, read before any await
      if (!note.id) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      // r2-improvement #3, as MCP state_write: replacing another writer's text without if_rev is said out loud.
      const overwrite = !unchanged && ifRev === undefined ? overwriteNotice(check.target, note as NoteRecord, currentWriter()) : null;
      if (!unchanged) await maybeEmbed(store, note);
      sendJson(res, 200, { note, ...(unchanged ? { unchanged: true } : {}), ...(overwrite ?? {}), ...(receipt ? { receipt, receipt_check: RECEIPT_CHECK } : {}), ...(warnings.length ? { warnings } : {}), ...(putFacts === undefined ? {} : factFeedback(store, note)) });
    } catch (e) {
      const receipt = store.refusedWriteReceipt(e, id);
      // As MCP state_write: a stale if_rev names who changed the note, how, the current rev and a short diff. The diff is
      // note text, so the reply carries the untrusted-content notice.
      const d = e instanceof StaleWriteError && ifRev !== undefined ? staleDetail(store, id, ifRev) : null;
      if (d) sendJson(res, 409, { error: d.message, stale: d.stale, security_notice: UNTRUSTED_BANNER.trim(), ...(receipt ? { receipt, receipt_check: RECEIPT_CHECK } : {}) });
      else sendError(res, e, receipt);
    }
    return true;
  }

  // POST /notes/:id/confirm { source? } -> 1.4.0 confirm. An admin token (the dashboard) confirms as kind `admin`; any
  // other token as a corroboration that counts only by Store.confirm's rules. 200 either way: `counted` says which.
  const confirmMatch = /^\/notes\/(\d+)\/confirm$/.exec(path);
  if (req.method === "POST" && confirmMatch) {
    const id = Number(confirmMatch[1]);
    let body: { source?: unknown };
    try {
      body = parseJsonBody(await readBody(req)) as { source?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (body.source !== undefined && typeof body.source !== "string") {
      sendJson(res, 400, { error: "source must be text" });
      return true;
    }
    try {
      const probe = store.read(id); // gate-ok: namespace check; confirm() re-reads through readVisible
      if (nsCtx.active && !denyUnreadable(nsCtx, res, probe)) return true;
      const ds = req.headers["x-monomem-dashboard"];
      const sess = typeof ds === "string" ? dashboardSessions.get(ds) : undefined;
      if (sess && sess.exp <= Date.now()) dashboardSessions.delete(ds as string);
      const dashboard = isAdmin && sess !== undefined && sess.exp > Date.now() && sess.label === principal.label;
      const r = store.confirm(id, { source: body.source, admin: isAdmin, dashboard });
      if (!r) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      // No title in the reply: to the caller (an agent's key, or the dashboard that already shows it) it is outside text.
      const { title: _title, ...reply } = r;
      sendJson(res, 200, reply);
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // POST /notes/:id/flag { reason } -> 1.5.0 (R2-02) "this looks wrong". The note does not change. Same rules as the
  // memory_flag tool: own namespace only, a hidden note is 404 like a missing one.
  const flagMatch = /^\/notes\/(\d+)\/flag$/.exec(path);
  if (req.method === "POST" && flagMatch) {
    const id = Number(flagMatch[1]);
    let body: { reason?: unknown };
    try {
      body = parseJsonBody(await readBody(req)) as { reason?: unknown };
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const bad = unknownNoteFields(body, ["reason"]);
    if (bad) {
      sendJson(res, 400, { error: bad });
      return true;
    }
    try {
      if (nsCtx.active && !denyUnwritable(nsCtx, res, store.read(id))) return true; // gate-ok: namespace probe; flagNote re-reads through readVisible
      const r = store.flagNote(id, body.reason);
      if (!r) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      sendJson(res, 200, { flagged: true, id: r.note_id, rev: r.rev });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }

  // DELETE /notes/:id
  if (req.method === "DELETE" && idMatch) {
    const id = Number(idMatch[1]);
    if (nsCtx.active) {
      // Same own-namespace rule as the MCP state_delete tool: a read
      // grant never confers delete access.
      if (!denyUnwritable(nsCtx, res, store.read(id))) return true; // gate-ok: archive/restore: denyUnwritable probe, hidden note is 404
    }
    let removed: boolean;
    try {
      removed = store.delete(id); // a pinned note is refused (400): REST counts as an agent
    } catch (e) {
      sendError(res, e);
      return true;
    }
    if (!removed) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    sendJson(res, 200, { deleted: id });
    return true;
  }

  // Retention: POST /notes/:id/archive -> soft-archive a note. It drops
  // out of list/search/recall but stays on disk and is restorable. This is
  // the reversible alternative to DELETE for "forget this".
  const archMatch = /^\/notes\/(\d+)\/archive$/.exec(path);
  if (req.method === "POST" && archMatch) {
    const id = Number(archMatch[1]);
    const note = store.readVisible(id, { includeDistrusted: isAdmin });
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (nsCtx.active && !denyUnwritable(nsCtx, res, note)) return true;
    let archived;
    try {
      archived = store.archive(id); // pinned / approve-first / paused refusals: a clear 4xx, not a 500
    } catch (e) {
      sendError(res, e);
      return true;
    }
    sendJson(res, 200, { archived: id, note: annotateStaleness(archived!) });
    return true;
  }

  // Retention: POST /notes/:id/restore -> bring an archived note back.
  const restoreMatch = /^\/notes\/(\d+)\/restore$/.exec(path);
  if (req.method === "POST" && restoreMatch) {
    const id = Number(restoreMatch[1]);
    const note = store.readVisible(id, { includeDistrusted: isAdmin });
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (nsCtx.active && !denyUnwritable(nsCtx, res, note)) return true;
    // Optional body { forget_after } gives the restored note a fresh TTL;
    // without it the old (possibly already expired) deadline is cleared,
    // so the next sweep does not instantly re-archive the note.
    let ttl: number | undefined;
    const rawBody = await readBody(req);
    if (rawBody.trim()) {
      try {
        const b = JSON.parse(rawBody) as { forget_after?: unknown };
        const fa = coerceNumeric(b.forget_after);
        validateForgetAfter(fa);
        if (typeof fa === "number") ttl = fa;
      } catch (e) {
        sendError(res, e instanceof SyntaxError ? new ValidationError("invalid JSON body") : e);
        return true;
      }
    }
    let restored;
    try {
      restored = store.restore(id, ttl === undefined ? {} : { forget_after: ttl });
    } catch (e) {
      sendError(res, e);
      return true;
    }
    await maybeEmbed(store, restored!); // archive dropped the vector
    sendJson(res, 200, { restored: id, note: annotateStaleness(restored!) });
    return true;
  }

  // --- Replacing a memory (1.6.0): two steps, never silent, never destructive ---
  // POST /supersede/preview   { old_ids: [..], new_note: {title, body?, tags?, confidence?} | new_id }  -> writes NOTHING
  // POST /supersede/confirm   { token, new_note?, acknowledge_risk? }   the only call that changes anything
  // POST /supersede/undo      { id }                                   bring a replaced note back (recorded)
  // GET  /notes/:id/history   earlier versions (admin)        POST /notes/:id/history/restore { version, if_rev? } (admin)
  // DELETE /notes/:id/history forget the earlier versions (admin)
  if (path.startsWith("/supersede/") && req.method === "POST") {
    const step = path.slice("/supersede/".length);
    if (step !== "preview" && step !== "confirm" && step !== "undo") {
      sendJson(res, 404, { error: "no such route" });
      return true;
    }
    const raw = await readBody(req);
    let b: Record<string, unknown>;
    try {
      const v = parseJsonBody(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      b = v as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
      return true;
    }
    const caller: Caller = { scope, ...(nsCtx.active ? { ownNamespace: nsCtx.ownNamespace } : {}) };
    try {
      if (step === "preview") {
        const out = supersedePreview(
          store,
          caller,
          { old_ids: b.old_ids, new_note: b.new_note as never, new_id: b.new_id },
          b.gui === true ? "Press Confirm to go ahead." : "To go ahead, send POST /supersede/confirm with this code: {token}"
        );
        // The dashboard asks in plain words: the extra line for a red-flag replacement must not talk about request fields either.
        if (b.gui === true) out.warning = out.warning.replace(/\n\(You must also say[^)]*\)/, "\n(Confirming also accepts the red flag above.)");
        sendJson(res, 200, out);
      } else if (step === "confirm") {
        const out = supersedeConfirm(store, caller, { token: b.token, new_note: b.new_note as never, acknowledge_risk: b.acknowledge_risk });
        await maybeEmbed(store, out.replacement);
        sendJson(res, 200, out);
      } else {
        sendJson(res, 200, supersedeUndo(store, caller, coerceNumeric(b.id)));
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  const histMatch = /^\/notes\/(\d+)\/history(\/restore)?$/.exec(path);
  if (histMatch) {
    const hid = Number(histMatch[1]);
    const caller: Caller = { scope, ...(nsCtx.active ? { ownNamespace: nsCtx.ownNamespace } : {}) };
    try {
      if (req.method === "GET" && !histMatch[2]) {
        sendJson(res, 200, noteHistory(store, caller, hid, { includeDistrusted: flagParam(url, "include_distrusted") }));
      } else if (req.method === "POST" && histMatch[2]) {
        const raw = await readBody(req);
        let b: { version?: unknown; if_rev?: unknown };
        try {
          b = parseJsonBody(raw);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        const ifRev = b.if_rev === undefined || b.if_rev === null ? undefined : coerceNumeric(b.if_rev);
        if (ifRev !== undefined && (typeof ifRev !== "number" || !Number.isInteger(ifRev) || ifRev < 1)) {
          sendJson(res, 400, { error: "if_rev must be a whole number (the rev you last read)" });
          return true;
        }
        const out = restoreVersion(store, caller, hid, coerceNumeric(b.version), ifRev !== undefined ? { ifRev: ifRev as number } : {});
        await maybeEmbed(store, out.note);
        sendJson(res, 200, out);
      } else if (req.method === "DELETE" && !histMatch[2]) {
        sendJson(res, 200, purgeNoteHistory(store, caller, hid));
      } else {
        sendJson(res, 404, { error: "no such route" });
      }
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  return false;
}
