// REST routes: lists and searches: GET /notes, GET /search, POST /relevant, GET /stats.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { ServerResponse } from "node:http";
import { currentCeiling } from "../actor.js";
import { NoteRecord, clampInt } from "../store.js";
import { auditFailureCount } from "../security.js";
import { timeZone } from "../config.js";
import { readBody } from "../http-common.js";
import { runSearch, runSearchExplained, semanticNotice, parseMode, runRelevantSearch, roundRobin, type ExplainedHit } from "../search-service.js";
import { parseTimePhrase } from "../time-parse.js";
import { listWithDisputes } from "../facts.js";
import { meterStats } from "../meter.js";
import { sendError, sendJson, WriterFilter, writerFilter, supersededFilter, flagParam, intParam, parseJsonBody } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function readRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, annotRead, readable, trustedHint, listReadable } = c;
  const { req, res, url, path, nsCtx, isAdmin, refuseDistrustedOptIn, setReadQuery } = r;
  // GET /notes?namespace=&limit=&offset=&includeArchived=1&archived=1
  if (req.method === "GET" && path === "/notes") {
    const namespace = url.searchParams.get("namespace") ?? undefined;
    let limit: number | undefined;
    let offset: number | undefined;
    try {
      limit = intParam(url, "limit", 1);
      offset = intParam(url, "offset", 0);
    } catch (e) {
      sendError(res, e);
      return true;
    }
    // Retention: archived notes are excluded by default. includeArchived
    // shows everything; archived=1 shows ONLY the archive (the restore
    // view). Both are admin-only since 1.1.0: an agent's "forget" archives,
    // so the archive holds exactly what someone asked to have forgotten.
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const archivedOnly = url.searchParams.get("archived") === "1";
    if ((includeArchived || archivedOnly) && !isAdmin) {
      sendJson(res, 403, { error: "listing archived (forgotten) notes needs an admin key" });
      return true;
    }
    const wf = { ...writerFilter(url), ...supersededFilter(url) };
    if (nsCtx.active) {
      // Untrusted hint intersected with the readable set, like the MCP
      // state_list tool.
      const hint = trustedHint(nsCtx, namespace);
      if (hint) {
        const result = store.list({
          namespace: hint,
          limit,
          offset,
          includeArchived,
          archivedOnly,
          ...wf,
        });
        sendJson(res, 200, { ...listWithDisputes(store, result), searchedNamespaces: [hint] });
        return true;
      }
      sendJson(res, 200, {
        ...listWithDisputes(store, listReadable(
          nsCtx,
          limit,
          offset,
          includeArchived,
          archivedOnly,
          wf
        )),
        searchedNamespaces: readable(nsCtx),
      });
      return true;
    }
    const result = store.list({
      namespace,
      limit,
      offset,
      includeArchived,
      archivedOnly,
      ...wf,
    });
    sendJson(res, 200, {
      ...listWithDisputes(store, result),
      searchedNamespaces: namespace ? [namespace] : [],
    });
    return true;
  }

  // GET /search?q=&namespace=&limit=&mode=keyword|semantic|hybrid&when=
  if (req.method === "GET" && path === "/search") {
    const q = url.searchParams.get("q") ?? "";
    const namespace = url.searchParams.get("namespace") ?? undefined;
    let limit: number | undefined;
    try {
      limit = intParam(url, "limit", 1);
    } catch (e) {
      sendError(res, e);
      return true;
    }
    const modeRaw = (url.searchParams.get("mode") ?? "").trim().toLowerCase();
    if (modeRaw && modeRaw !== "keyword" && modeRaw !== "semantic" && modeRaw !== "hybrid") {
      sendJson(res, 400, { error: "mode must be keyword, semantic or hybrid" });
      return true;
    }
    const semNotice = semanticNotice(modeRaw);
    // C-06: a search that could not read sealed bodies says so (body_search), never an empty-looking answer alone.
    const fb0 = store.bodyIndexFallbacks();
    const sendJsonN = (r: ServerResponse, code: number, body: Record<string, unknown>): void => {
      const bodyNote = store.bodySearchNotice(fb0);
      sendJson(r, code, { ...body, ...(semNotice ? { notice: semNotice } : {}), ...(bodyNote ? { body_search: bodyNote } : {}) });
    };
    const whenRaw = url.searchParams.get("when") ?? undefined;
    // Retrieval visibility: ?explain=1 swaps the plain search for the
    // explained twin and attaches a `breakdown` to each result, so the
    // caller sees the exact base relevance / access boost / staleness
    // factors that produced the ranking. Off by default to keep the
    // common response small and byte-compatible.
    const explainRaw = (url.searchParams.get("explain") ?? "").toLowerCase();
    // A relevance breakdown is computed over the whole corpus (document frequencies include hidden notes), so for a caller
    // with a sensitivity ceiling it would be an oracle for text it cannot see: `explain` is ignored for them.
    const explain = (explainRaw === "1" || explainRaw === "true") && currentCeiling() === undefined;
    // Like the MCP tool, an unrecognized time phrase is ignored rather
    // than an error -- the query still runs unscoped.
    const timePhrase = whenRaw ? parseTimePhrase(whenRaw, { timeZone: timeZone() }) : null;
    if (whenRaw && whenRaw.trim() && !timePhrase) {
      sendJson(res, 400, { error: `unrecognized time phrase "${whenRaw}" (try "yesterday", "last week", "in March")` });
      return true;
    }
    if (!q.trim() && !timePhrase) {
      sendJson(res, 400, { error: "q is required" });
      return true;
    }
    // Shape a hit for the wire: staleness annotation always, breakdown
    // only when explain=1. Shared by all three namespace branches.
    const shapeHit = (n: NoteRecord, breakdown?: unknown): Record<string, unknown> => ({
      ...annotRead(n),
      ...(breakdown !== undefined ? { breakdown } : {}),
    });
    const toResults = (hits: ExplainedHit[]): Record<string, unknown>[] =>
      hits.map((h) => shapeHit(h.note, h.breakdown));
    if (nsCtx.active) {
      // Untrusted hint intersected with the readable set, like the MCP
      // state_search tool: fan out over every readable namespace when
      // the hint is missing or names something unreadable. The
      // per-namespace lists merge round-robin so a later namespace is
      // never starved by an earlier one's hits.
      const hint = trustedHint(nsCtx, namespace);
      const searchOpts = {
        limit,
        mode: parseMode(url.searchParams.get("mode")),
        timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
        ...writerFilter(url),
        ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
      };
      if (hint) {
        if (explain) {
          const hits = await runSearchExplained(store, q, { ...searchOpts, namespace: hint });
          sendJsonN(res, 200, {
            results: toResults(hits),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces: [hint],
          });
          return true;
        }
        const results = await runSearch(store, q, { ...searchOpts, namespace: hint });
        sendJsonN(res, 200, {
          results: results.map((n) => annotRead(n)),
          timeRange: timePhrase ? timePhrase.label : null,
          searchedNamespaces: [hint],
        });
        return true;
      }
      const lim = clampInt(searchOpts.limit, 20, 1, 200);
      if (explain) {
        const perNs: ExplainedHit[][] = [];
        for (const ns of readable(nsCtx)) {
          perNs.push(await runSearchExplained(store, q, { ...searchOpts, namespace: ns }));
        }
        // Interleave the explained lists by note id, preserving each
        // list's internal order, then re-attach the breakdown by id.
        const merged = roundRobin(perNs.map((l) => l.map((h) => h.note)), lim);
        const byId = new Map<number, unknown>();
        for (const l of perNs) for (const h of l) byId.set(h.note.id, h.breakdown);
        sendJsonN(res, 200, {
          results: merged.map((n) => shapeHit(n, byId.get(n.id))),
          timeRange: timePhrase ? timePhrase.label : null,
          searchedNamespaces: readable(nsCtx),
        });
        return true;
      }
      const lists: NoteRecord[][] = [];
      for (const ns of readable(nsCtx)) {
        lists.push(await runSearch(store, q, { ...searchOpts, namespace: ns }));
      }
      sendJsonN(res, 200, {
        results: roundRobin(lists, lim).map((n) => annotRead(n)),
        timeRange: timePhrase ? timePhrase.label : null,
        searchedNamespaces: readable(nsCtx),
      });
      return true;
    }
    const singleOpts = {
      namespace,
      limit,
      mode: parseMode(url.searchParams.get("mode")),
      timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
      ...writerFilter(url),
      ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
    };
    if (explain) {
      const hits = await runSearchExplained(store, q, singleOpts);
      sendJsonN(res, 200, {
        results: toResults(hits),
        timeRange: timePhrase ? timePhrase.label : null,
        searchedNamespaces: namespace ? [namespace] : [],
      });
      return true;
    }
    const results = await runSearch(store, q, singleOpts);
    sendJsonN(res, 200, {
      results: results.map((n) => annotRead(n)),
      timeRange: timePhrase ? timePhrase.label : null,
      searchedNamespaces: namespace ? [namespace] : [],
    });
    return true;
  }

  // POST /relevant { message, limit?, namespace? } -> { keywords, results }
  // Mirrors the state_relevant MCP tool: keyword extraction from a
  // natural-language message, then a permissive (any-single-keyword-hit)
  // search. Namespace gating matches GET /search exactly.
  if (req.method === "POST" && path === "/relevant") {
    const raw = await readBody(req);
    const fb0 = store.bodyIndexFallbacks(); // C-06: see /search
    const withBodyNote = (body: Record<string, unknown>): Record<string, unknown> => {
      const bodyNote = store.bodySearchNotice(fb0);
      return bodyNote ? { ...body, body_search: bodyNote } : body;
    };
    let parsed: { message?: unknown; limit?: unknown; namespace?: unknown; written_by?: unknown; not_written_by?: unknown; include_distrusted?: unknown };
    try {
      parsed = parseJsonBody(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    if (typeof parsed.message !== "string" || !parsed.message.trim()) {
      sendJson(res, 400, { error: "message is required" });
      return true;
    }
    setReadQuery(parsed.message);
    // The MCP schema requires an integer limit; the REST layer used to
    // accept floats (floored) and strings (defaulted). Reject
    // non-integers with a 400 so both surfaces validate identically.
    if (parsed.limit !== undefined && !Number.isInteger(parsed.limit)) {
      sendJson(res, 400, { error: "limit must be an integer" });
      return true;
    }
    // Same default as the MCP tool: a relevance probe returns a handful
    // of notes, not a page.
    const relLimit = typeof parsed.limit === "number" ? parsed.limit : 5;
    // ONE resolved namespace (body wins, then the query string) feeds BOTH the include_distrusted gate and the search, so
    // the gate can never judge one namespace while the search reads another.
    const relNs =
      typeof parsed.namespace === "string" ? parsed.namespace : url.searchParams.get("namespace") ?? undefined;
    // Writer / trust filters: in the JSON body, or (like /search) in the query string.
    const bodyStr = (k: string): string | undefined => {
      const v = (parsed as Record<string, unknown>)[k];
      return typeof v === "string" && v !== "" ? v : undefined;
    };
    const urlWf = writerFilter(url);
    const rwf: WriterFilter = {
      ...urlWf,
      ...(bodyStr("written_by") ? { writtenBy: bodyStr("written_by") } : {}),
      ...(bodyStr("not_written_by") ? { notWrittenBy: bodyStr("not_written_by") } : {}),
      ...(["1", "true", "yes"].includes(String((parsed as Record<string, unknown>).include_distrusted ?? "").toLowerCase()) ? { includeDistrusted: true } : {}),
    };
    if (rwf.includeDistrusted && refuseDistrustedOptIn(relNs)) return true;
    // Results carry the same staleness fields as /search (the
    // vague-message path is the most likely to act on outdated facts).
    const withStaleness = (r: { keywords: string[]; results: NoteRecord[] }) => ({
      keywords: r.keywords,
      results: r.results.map((n) => annotRead(n)),
    });
    if (nsCtx.active) {
      // Untrusted hint intersected with the readable set, like GET
      // /search: fan out over every readable namespace when the hint is
      // missing or names something unreadable. Round-robin merge so a
      // later namespace is never starved; searchedNamespaces echoes the
      // namespaces actually searched.
      const hint = trustedHint(nsCtx, relNs);
      if (hint) {
        const out = await runRelevantSearch(store, parsed.message, {
          namespace: hint,
          limit: relLimit,
          ...rwf,
        });
        sendJson(res, 200, withBodyNote({
          ...withStaleness(out),
          searchedNamespaces: [hint],
        }));
        return true;
      }
      const lists: NoteRecord[][] = [];
      let keywords: string[] = [];
      for (const ns of readable(nsCtx)) {
        const r = await runRelevantSearch(store, parsed.message, {
          namespace: ns,
          limit: relLimit,
          ...rwf,
        });
        keywords = r.keywords; // identical per namespace (from the message)
        lists.push(r.results);
      }
      const lim = clampInt(relLimit, 10, 1, 200);
      sendJson(res, 200, withBodyNote({
        keywords,
        results: roundRobin(lists, lim).map((n) => annotRead(n)),
        searchedNamespaces: readable(nsCtx),
      }));
      return true;
    }
    const out = await runRelevantSearch(store, parsed.message, {
      namespace: relNs,
      limit: relLimit,
      ...rwf,
    });
    sendJson(res, 200, withBodyNote({
      ...withStaleness(out),
      searchedNamespaces: relNs ? [relNs] : [],
    }));
    return true;
  }

  // GET /stats?namespace= -> access-tracking stats, mirroring the
  // memory_stats MCP tool. Read scope; namespace gating matches the
  // tool exactly (readable-set counting under server-side resolution,
  // never the whole store).
  if (req.method === "GET" && path === "/stats") {
    const namespace = url.searchParams.get("namespace") ?? undefined;
    let namespaces: string[] | undefined;
    let searchedNamespaces: string[];
    if (nsCtx.active) {
      const hint = trustedHint(nsCtx, namespace);
      namespaces = hint ? [hint] : readable(nsCtx);
      searchedNamespaces = namespaces;
    } else {
      namespaces = namespace ? [namespace] : undefined;
      searchedNamespaces = namespace ? [namespace] : [];
    }
    sendJson(res, 200, {
      ...store.accessStats(namespaces, { hideDistrusted: !isAdmin }),
      audit_failures: auditFailureCount(),
      ...(currentCeiling() === undefined ? { meter: meterStats(store, namespaces) } : {}), // token totals are not split by label, so a ceilinged caller does not get them
      searchedNamespaces,
    });
    return true;
  }
  return false;
}
