// REST routes: GET /export and POST /import.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { type ImportReport, attestationsToShow, EXPORT_PAGE_SIZE, type ImportNote } from "../store.js";
import { audit } from "../security.js";
import { ImportShape, importWarnings } from "../import-report.js";
import { readBody, IMPORT_BODY_BYTES } from "../http-common.js";
import { maybeEmbed } from "../search-service.js";
import { IMPORT_EDGE_DEFER_THRESHOLD, sendError, sendJson } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function backupRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, readable } = c;
  const { req, res, url, path, principal, nsCtx } = r;
  // GET /export -> all notes, for backup / migration. Exempt from the
  // response-size cap: a backup must dump the whole store, not a truncated
  // slice (there are no narrowing params on /export).
  //
  // STREAMED, not materialized: exportAll() would hold every row, every
  // decoded record, AND the full JSON string in memory at once (~3x the
  // backup size). With months of notes that is a real spike on a small
  // box. Instead we page through the store with exportBatch (keyset
  // pagination on the primary key) and write each page as it is built,
  // so peak memory is one page regardless of store size. The response
  // BODY is byte-identical to the old non-streaming form: {"notes":[...]}.
  if (req.method === "GET" && path === "/export") {
    if (res.writableEnded || res.headersSent) return true;
    // ?skipUnreadable=1: a row whose body cannot be decrypted is written
    // as a body-less {"unreadable":true} entry instead of aborting the
    // backup. Default is fail-loud: the stream is cut so the client sees
    // an error, never a valid-looking but incomplete backup.
    const skipUnreadable = ["1", "true"].includes((url.searchParams.get("skipUnreadable") ?? "").toLowerCase());
    // Namespace filtering happens IN SQL (unreadable namespaces are never
    // selected, so a tampered row elsewhere cannot block this backup).
    const exportNs = nsCtx.active ? readable(nsCtx) : undefined;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // No Content-Length: the length is not known up front when streaming.
      // Node falls back to chunked transfer-encoding, which every HTTP/1.1
      // client handles.
    });
    // Attestations are OPT-IN (?attest=1): the default body is byte-identical to
    // every release before 1.4.0, `{"notes":[...]}`, so scripts and older importers
    // keep working. With ?attest=1 the envelope gains an `export` header (this
    // server, its public key) and every note a detached signed attestation. If the
    // signing key cannot be created (read-only data dir) the export is still
    // written, just without them -- a backup must not fail over a signature.
    let attest = ["1", "true", "yes"].includes((url.searchParams.get("attest") ?? "").toLowerCase());
    let header = "";
    if (attest) {
      try {
        header = `"export":${JSON.stringify(store.exportHeader())},`;
      } catch (e) {
        attest = false;
        console.error("[monomem] export without attestations:", (e as Error).message);
      }
    }
    res.write(`{${header}"notes":[`);
    let afterId = 0;
    let exported = 0;
    let first = true;
    try {
      for (;;) {
        const page = store.exportBatch(afterId, EXPORT_PAGE_SIZE, { namespaces: exportNs, skipUnreadable, attest, history: url.searchParams.get("history") !== "0" }); // gate-ok: GET /export is admin-only (a full backup)
        if (page.length === 0) break;
        afterId = page[page.length - 1].id;
        exported += page.length;
        for (const note of page) {
          const chunk = (first ? "" : ",") + JSON.stringify(note);
          first = false;
          // Backpressure: if the socket buffer is full, wait for drain
          // rather than queueing the whole backup in the process.
          if (!res.write(chunk)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
        // A short page means we reached the end of the table.
        if (page.length < EXPORT_PAGE_SIZE) break;
        // Yield to the event loop between pages so a very large export
        // cannot starve concurrent API/MCP traffic on this process.
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (e) {
      // Headers are already sent, so a status code is impossible: log the
      // cause and destroy the socket so the client sees a failed download.
      console.error("[monomem] export aborted:", (e as Error).message);
      res.destroy(e as Error);
      return true;
    }
    res.end("]}");
    store.logAccess({ tool: "GET /export", namespaces: exportNs, results: exported });
    audit({ op: "export", label: principal.label || "(unnamed)", kind: "export", detail: `rest notes=${exported}${attest ? " attest" : ""}${skipUnreadable ? " skipUnreadable" : ""}${url.searchParams.get("history") === "0" ? " no-history" : ""}${exportNs ? ` namespaces=${exportNs.length}` : ""}` });
    return true;
  }

  // POST /import -> restore/seed from a backup: { notes: [...] }
  if (req.method === "POST" && path === "/import") {
    // Restore gets its OWN, much larger body cap: /export is exempt from
    // the response cap so a backup can dump the whole store, so /import
    // must be able to accept one back. The default 1MB request cap made a
    // ~2000-note backup un-restorable (413). Still bounded + admin-only.
    const raw = await readBody(req, IMPORT_BODY_BYTES);
    // ImportNote (not NoteInput): a real backup carries updated_at AND rev
    // per note -- both are restore-fidelity fields the store honors.
    let parsed: { notes?: ImportNote[]; dedupe?: unknown };
    try {
      const v = JSON.parse(raw || "{}") as unknown;
      // Both shapes restore: {"notes":[...]} (every release; an attested export adds an `export` header) and a bare [...].
      parsed = Array.isArray(v) ? { notes: v as ImportNote[] } : (v as { notes?: ImportNote[]; dedupe?: unknown });
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (!parsed || !Array.isArray(parsed.notes)) {
      sendJson(res, 400, { error: "expected { notes: [...] } (or a bare array of notes)" });
      return true;
    }
    try {
      // When namespace resolution is active the client-supplied namespace
      // is untrusted: imported notes are forced into the server's own
      // namespace so a backup can't plant notes into another namespace
      // (memory poisoning).
      const notes = nsCtx.active
        ? parsed.notes.map((n) => ({ ...n, namespace: nsCtx.ownNamespace }))
        : parsed.notes;
      const report: ImportReport = { quarantined: [], rejected: [] };
      // Above the threshold, DEFER the similarity-graph rebuild: linking
      // is O(n^2) and measured at 88-97% of a bulk restore's runtime
      // (8000 notes: 3.6s of inserts vs 34.9s of linking). Landing the
      // notes in seconds and rebuilding the graph afterwards with
      // `monomem rebuild-edges` beats blocking the restore for minutes
      // on an optional ranking aid. Below the threshold, link inline so
      // the common small import behaves exactly as before.
      const deferEdges = notes.length > IMPORT_EDGE_DEFER_THRESHOLD;
      // dedupe: skip notes already present with the same
      // namespace/title/created_at/body, so re-running a restore is
      // idempotent. ON by default since 2.1.0 -- importing twice used to
      // double every memory, with no undo. Opt out with `{"dedupe": false}`
      // or ?dedupe=0 when duplicate rows are genuinely wanted.
      const dedupeParam = (url.searchParams.get("dedupe") ?? "").toLowerCase();
      const dedupe =
        parsed.dedupe === false || ["0", "false"].includes(dedupeParam)
          ? false
          : true;
      // require_attestation (body flag or ?require_attestation=1): reject notes without an attestation that verifies.
      const requireAttestation =
        (parsed as { require_attestation?: unknown }).require_attestation === true ||
        ["1", "true"].includes((url.searchParams.get("require_attestation") ?? "").toLowerCase());
      const shape = new ImportShape();
      for (const n of notes) shape.observe(n);
      const created = await store.importNotes(notes, { report, deferEdges, dedupe, ...(requireAttestation ? { requireAttestation: true } : {}) });
      const warnings = importWarnings(shape, report);
      // Best-effort: index the restored notes for semantic/hybrid search
      // (no-op when embeddings are off). Without this, re-imported notes
      // would be invisible to semantic search until a manual `reindex`.
      for (const note of created) await maybeEmbed(store, note);
      // `imported` keeps its 1.0 meaning; the linter's outcomes are
      // additive fields, present only when non-empty.
      sendJson(res, 200, {
        imported: created.length,
        ...(deferEdges
          ? {
              similarityGraph: "deferred",
              note: `search by meaning is not set up for these ${created.length} notes: run \`monomem tidy edges\` (normal search still works)`,
            }
          : {}),
        ...(report.skipped ? { skipped: report.skipped } : {}),
        // Plain-language warnings: notes with no `body` (the field the text must be in), and trust marks removed from a file that is not signed.
        ...(warnings.length ? { warnings, ...(shape.empty ? { empty_body: shape.empty } : {}), ...(report.trustStripped ? { trust_marks_removed: report.trustStripped } : {}) } : {}),
        ...(attestationsToShow(report.attestations) ? { attestations: report.attestations } : {}),
        ...(report.quarantined.length ? { quarantined: report.quarantined } : {}),
        ...(report.rejected.length ? { rejected: report.rejected } : {}),
      });
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  return false;
}
