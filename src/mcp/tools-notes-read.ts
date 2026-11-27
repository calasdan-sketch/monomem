// MCP tools: Reading notes: state_read, state_search, state_relevant, state_list, and state_delete.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { currentCeiling } from "../actor.js";
import { listWithComputer } from "../sync/marks.js";
import { z } from "zod";
import { clampInt, type NoteRecord } from "../store.js";
import { listWithDisputes } from "../facts.js";
import { audit } from "../security.js";
import { runSearch, runSearchExplained, semanticNotice, parseMode, runRelevantSearch, roundRobin, SEARCH_MODES, type ExplainedHit } from "../search-service.js";
import { parseTimePhrase } from "../time-parse.js";
import { timeZone } from "../config.js";
import { withWhenBase, textResult, zInt, READ_MAX_CHARS, MULTI_READ_MAX, CUT_NOTE, untrustedResultCut, untrustedResult, INCLUDE_DISTRUSTED_SHAPE, WRITER_FILTER_SHAPE, SUPERSEDED_SHAPE, supersededArg, writerFilterArgs, errorResult, errorFor } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerNotesReadTools(c: McpCtx): void {
  const { server, store, conn, withWhen, denyIfUnder, nsActive, ownNs, readable, trustedHint, searchReadable, relevantReadable, listReadable, archivedMessage, readOne } = c;
  server.registerTool(
    "state_read",
    {
      title: "Read shared state",
      description:
        `Open one note from memory by its id. Pass \`neighbors: true\` to also get up to 10 similar notes. A body longer than max_chars (default ${READ_MAX_CHARS}) comes in parts: body_truncated, body_chars and next_offset say where to continue (pass it as offset).`,
      inputSchema: {
        id: zInt().optional().describe("Id of the note to read."),
        ids: z.array(zInt()).optional().describe(`Several ids at once (up to ${MULTI_READ_MAX}): returns notes, missing (and ignored_ids past ${MULTI_READ_MAX}); max_chars is shared by all bodies. One id reads like id.`),
        offset: zInt(0).optional().describe("Start the body at this character (from next_offset). Default 0."),
        max_chars: zInt(1).optional().describe(`Most body characters to return (default ${READ_MAX_CHARS}).`),
        neighbors: z
          .boolean()
          .optional()
          .describe(
            "Attach up to 10 similar-note neighbors (same namespace) with similarity scores. Default false."
          ),
        ...INCLUDE_DISTRUSTED_SHAPE,
      },
    },
    async ({ id: oneId, ids, offset, max_chars, neighbors, include_distrusted }) => {
      try {
        // Uniform scope gate on the read tools too (defense-in-depth: the
        // scope floor is "read" today, but the check must not silently rot
        // if a narrower floor is ever introduced).
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const max = clampInt(max_chars, READ_MAX_CHARS, 1, 1_000_000);
        if (oneId === undefined && ids !== undefined && ids.length > 1) {
          // Several ids: each through the same gated path, one max_chars budget shared by all bodies.
          const uniq = [...new Set(ids)]; // a repeated id is read (and counted as an access) once
          const take = uniq.slice(0, MULTI_READ_MAX);
          const notes: Record<string, unknown>[] = [];
          const missing: number[] = [];
          const archived: number[] = [];
          const spent: number[] = [];
          let left = max;
          for (const one of take) {
            // Budget gone: do not read (or count an access for) a note whose body would come back empty.
            if (left <= 0) {
              spent.push(one);
              continue;
            }
            const r = readOne(one, 0, left, neighbors === true, include_distrusted === true);
            if ("error" in r) {
              (r.archived ? archived : missing).push(one);
              continue;
            }
            notes.push(r.note);
            left = Math.max(0, left - (typeof r.note.body === "string" ? r.note.body.length : 0));
          }
          const ignored = uniq.slice(MULTI_READ_MAX);
          return untrustedResult({
            notes,
            missing,
            ...(spent.length ? { not_read_budget_spent: spent, budget_hint: "max_chars was used up; read these in another call" } : {}),
            ...(archived.length ? { archived, archived_hint: "archived (hidden, not erased); a person can restore one with `monomem restore <id>`; write a new note only if the user wants a fresh one" } : {}),
            ...(ignored.length ? { ignored_ids: ignored, hint: `at most ${MULTI_READ_MAX} ids per call; read the rest in another call` } : {}),
          });
        }
        const id = oneId ?? ids?.[0];
        if (id === undefined) return errorResult("id is required");
        const r = readOne(id, Math.max(0, offset ?? 0), max, neighbors === true, include_distrusted === true);
        return "error" in r ? errorResult(r.error) : untrustedResult({ note: r.note });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_search",
    {
      title: "Search shared state",
      description:
        "Search notes in the shared state store by title/body/tags. Keyword (full-text) by default; set mode to 'semantic' or 'hybrid' for meaning-based search when embeddings are enabled (falls back to keyword otherwise). Set mode to 'relevant' and pass a natural conversational message as `query` to extract keywords from it and return notes matching ANY of them (default limit 5; returns the extracted keywords too). Always reflects the latest writes. " + CUT_NOTE +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are searched."
          : ""),
      inputSchema: {
        query: z.string().describe("Search text."),
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict search to this namespace. Ignored unless this server may read it."
              : "Restrict search to this namespace."
          ),
        limit: zInt().optional().describe("Max results: default 20, min 1, max 200 (a larger value is lowered to 200 and the response says limit_capped: 200). When the results fill the limit the response has more: true (there may be more matches)."),
        mode: z
          .enum([...SEARCH_MODES, "relevant"])
          .optional()
          .describe(
            "keyword = full-text (default when embeddings off); semantic = meaning only; hybrid = fuse both. Falls back to keyword if embeddings are unavailable. relevant = treat `query` as a conversational message: extract its keywords and match notes on ANY one of them (what state_relevant does; `when`, `explain` and `include_superseded` do not apply)."
          ),
        when: z
          .string()
          .optional()
          .describe(
            "Natural-language time filter, e.g. 'yesterday evening'. Scopes results to that time range (interpreted in MONOMEM_TIMEZONE). Unrecognized values are ignored -- the query still runs unscoped."
          ),
        explain: z
          .boolean()
          .optional()
          .describe(
            "Attach a `breakdown` to each result: the base relevance, access boost and staleness factors that produced its rank. Default false."
          ),
        as_of: z
          .string()
          .optional()
          .describe(
            "Admin only. Read-only time travel: search memory as it stood at this time (ISO date/time or an age like 7d, 2h), rebuilt from note history. Keyword match on the old text only; notes whose old text is no longer kept are counted, not shown. Cannot be combined with mode, when, explain, written_by, not_written_by or include_superseded."
          ),
        ...WRITER_FILTER_SHAPE,
        ...SUPERSEDED_SHAPE,
      },
    },
    async ({ query, namespace, limit, mode, when, explain, as_of, written_by, not_written_by, include_distrusted, include_superseded }) => {
      try {
        if (as_of !== undefined) {
          if (mode !== undefined || when !== undefined || explain !== undefined || written_by || not_written_by || include_superseded !== undefined) {
            return errorResult("as_of cannot be combined with mode, when, explain, written_by, not_written_by or include_superseded");
          }
          // Admin only, like note history: a past version can hold text that was taken out on purpose, and a
          // forgotten note comes back in a past view.
          const denied = denyIfUnder("admin");
          if (denied) return errorResult(denied);
          if (limit !== undefined && limit < 1) return errorResult("limit must be an integer >= 1");
          const { parseAsOf, asOfView, asOfSearch, asOfFields } = await import("../asof.js");
          let at: Date;
          try {
            at = parseAsOf(as_of);
          } catch (e) {
            return errorResult((e as Error).message);
          }
          // Same namespace gating as the live search: the hint is untrusted when namespaces are enforced.
          const hint = nsActive ? trustedHint(namespace) : namespace;
          const spaces = nsActive ? (hint ? [hint] : readable()) : hint ? [hint] : undefined;
          const view = asOfView(store, at, { ...(spaces ? { namespaces: spaces } : {}), ...(include_distrusted === true ? { includeDistrusted: true } : {}) });
          const hits = asOfSearch(view, query, clampInt(limit, 20, 1, 200));
          return untrustedResultCut({
            as_of: at.toISOString(),
            note: "Reconstructed from note history; hard-deleted notes cannot be shown.",
            not_kept: view.notKept,
            archived_then: view.archivedThen,
            results: hits.map((h) => asOfFields(h, withWhenBase)),
            searchedNamespaces: spaces ?? [],
          }, query);
        }
        if (mode === "relevant") {
          if (when !== undefined || explain !== undefined || include_superseded !== undefined) {
            return errorResult("when, explain and include_superseded do not apply to mode 'relevant'");
          }
          return await relevantTool({ message: query, limit, namespace, written_by, not_written_by, include_distrusted, cut: true });
        }
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        // A time phrase the parser doesn't recognize is ignored, never an
        // error: the query still runs, just unscoped.
        const timePhrase = when ? parseTimePhrase(when, { timeZone: timeZone() }) : null;
        // Same validation as REST GET /search: a bad limit or an unrecognized
        // time phrase is a clear error, not a silently different query.
        if (limit !== undefined && limit < 1) return errorResult("limit must be an integer >= 1");
        if (when && when.trim() && !timePhrase) {
          return errorResult(`unrecognized time phrase "${when}" (try "yesterday", "last week", "in March")`);
        }
        const timeRange = timePhrase
          ? { start: timePhrase.start, end: timePhrase.end }
          : undefined;
        const resolvedMode = mode ?? parseMode(undefined);
        const semNotice = semanticNotice(mode);
        const effLimit = clampInt(limit, 20, 1, 200);
        const untrustedResultN = (p: Record<string, unknown>) => {
          const n = Array.isArray(p.results) ? p.results.length : 0;
          const q = { ...p, ...(limit !== undefined && limit > 200 ? { limit_capped: 200 } : {}), ...(n >= effLimit ? { more: true } : {}) };
          return untrustedResultCut(semNotice ? { ...q, notice: semNotice } : q, query);
        };
        const wf = { ...writerFilterArgs(written_by, not_written_by, include_distrusted), ...supersededArg(include_superseded) };
        if (explain === true && currentCeiling() === undefined) {
          // Explained twin of the branches below: same namespace gating, the
          // per-namespace lists merge round-robin, each hit keeps its breakdown.
          const hint = nsActive ? trustedHint(namespace) : namespace;
          const spaces: Array<string | undefined> = nsActive ? (hint ? [hint] : readable()) : [namespace];
          const perNs: ExplainedHit[][] = [];
          for (const ns of spaces) {
            perNs.push(await runSearchExplained(store, query, { namespace: ns, limit, mode: resolvedMode, timeRange, ...wf }));
          }
          const byId = new Map<number, unknown>();
          for (const l of perNs) for (const h of l) byId.set(h.note.id, h.breakdown);
          const merged =
            perNs.length === 1
              ? perNs[0].map((h) => h.note)
              : roundRobin(perNs.map((l) => l.map((h) => h.note)), clampInt(limit, 20, 1, 200));
          return untrustedResultN({
            results: merged.map((n) => ({ ...withWhen(n), breakdown: byId.get(n.id) })),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces: nsActive ? spaces : namespace ? [namespace] : [],
          });
        }
        if (nsActive) {
          // The model-supplied namespace is an UNTRUSTED HINT: intersect it
          // with the readable set. A hint naming an unreadable namespace is
          // ignored (readable namespaces are searched instead); the
          // server-resolved namespace is authoritative.
          const hint = trustedHint(namespace);
          // Surface how the `when` phrase was interpreted (null when the
          // query ran unscoped): the caller otherwise can't tell what the
          // time filter meant. Each hit carries its staleness fields
          // (stale/ageDays, plus staleWarning when stale).
          // searchedNamespaces echoes which namespaces were actually
          // searched, so a prompt-injected unreadable hint can't make the
          // model misattribute readable-namespace results to it.
          if (hint) {
            const results = await runSearch(store, query, {
              namespace: hint,
              limit,
              mode: resolvedMode,
              timeRange,
              ...wf,
            });
            return untrustedResultN({
              results: results.map((n) => withWhen(n)),
              timeRange: timePhrase ? timePhrase.label : null,
              searchedNamespaces: [hint],
            });
          }
          const { results, searchedNamespaces } = await searchReadable(query, {
            limit,
            mode: resolvedMode,
            timeRange,
            ...wf,
          });
          return untrustedResultN({
            results: results.map((n) => withWhen(n)),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces,
          });
        }
        const results = await runSearch(store, query, {
          namespace,
          limit,
          mode: resolvedMode,
          timeRange,
          ...wf,
        });
        return untrustedResultN({
          results: results.map((n) => withWhen(n)),
          timeRange: timePhrase ? timePhrase.label : null,
          searchedNamespaces: namespace ? [namespace] : [],
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_relevant",
    {
      title: "Find memories relevant to a message",
      annotations: { readOnlyHint: true },
      description:
        "Given a natural conversational message, extract keywords from it and return notes matching any of them. Permissive on purpose: a note qualifies on a single keyword hit (OR), unlike state_search's AND conjunction -- use this for vague messages where you don't know the exact wording. Returns the extracted keywords alongside the results for transparency." +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are searched."
          : ""),
      inputSchema: {
        message: z
          .string()
          .describe("Natural conversational text to find relevant memories for."),
        limit: z.number().int().optional().describe("Max results (default 5, max 200)."),
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict search to this namespace. Ignored unless this server may read it."
              : "Restrict search to this namespace."
          ),
        ...WRITER_FILTER_SHAPE,
      },
    },
    relevantTool
  );

  // state_relevant's handler, also state_search's mode "relevant" (a declaration, so state_search above can call it).
  async function relevantTool({
    message,
    limit,
    namespace,
    written_by,
    not_written_by,
    include_distrusted,
    cut = false,
  }: {
    message: string;
    limit?: number;
    namespace?: string;
    written_by?: string;
    not_written_by?: string;
    include_distrusted?: boolean;
    /** Cut long bodies (state_search mode "relevant"); state_relevant keeps them whole as before. */
    cut?: boolean;
  }) {
    const out$ = cut ? (p: Record<string, unknown>) => untrustedResultCut(p, message) : untrustedResult;
    try {
      const denied = denyIfUnder("read");
      if (denied) return errorResult(denied);
      if (limit !== undefined && limit < 1) return errorResult("limit must be an integer >= 1");
      if (!message || !message.trim()) {
        return errorResult("message is required");
      }
      // The tool's own default (5) overrides the service-level default
      // (10): a relevance probe returns a handful of notes, not a page.
      const effLimit = limit ?? 5;
      // Attach the staleness fields (stale/ageDays, plus staleWarning when
      // stale): the vague-message path is the one most likely to act on
      // outdated facts, so it gets the same staleness contract as search.
      const withStaleness = (r: { keywords: string[]; results: NoteRecord[] }) => ({
        keywords: r.keywords,
        results: r.results.map((n) => withWhen(n)),
      });
      if (nsActive) {
        // Same gating as state_search: the model-supplied namespace is an
        // UNTRUSTED HINT, intersected with the readable set. A hint naming
        // an unreadable namespace is ignored (readable namespaces are
        // searched instead). searchedNamespaces echoes which namespaces
        // were actually searched.
        const hint = trustedHint(namespace);
        if (hint) {
          const out = await runRelevantSearch(store, message, {
            namespace: hint,
            limit: effLimit,
            ...writerFilterArgs(written_by, not_written_by, include_distrusted),
          });
          return out$({ ...withStaleness(out), searchedNamespaces: [hint] });
        }
        const out = await relevantReadable(message, { limit: effLimit, ...writerFilterArgs(written_by, not_written_by, include_distrusted) });
        return out$({
          ...withStaleness(out),
          searchedNamespaces: out.searchedNamespaces,
        });
      }
      const out = await runRelevantSearch(store, message, { namespace, limit: effLimit, ...writerFilterArgs(written_by, not_written_by, include_distrusted) });
      return out$({
        ...withStaleness(out),
        searchedNamespaces: namespace ? [namespace] : [],
      });
    } catch (e) {
      return errorFor(e);
    }
  }

  server.registerTool(
    "state_list",
    {
      title: "List shared state",
      description:
        "List the notes in memory, newest first. Optionally only one namespace (a named space). " + CUT_NOTE +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are listed."
          : ""),
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict listing to this namespace. Ignored unless this server may read it."
              : "Restrict listing to this namespace."
          ),
        limit: zInt().optional().describe("Max results (default 50, max 500)."),
        offset: zInt().optional().describe("Pagination offset."),
        ...WRITER_FILTER_SHAPE,
        ...SUPERSEDED_SHAPE,
      },
    },
    async ({ namespace, limit, offset, written_by, not_written_by, include_distrusted, include_superseded }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const wf = { ...writerFilterArgs(written_by, not_written_by, include_distrusted), ...supersededArg(include_superseded) };
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like search.
          const hint = trustedHint(namespace);
          if (hint) {
            return untrustedResultCut({
              ...listWithComputer(store, listWithDisputes(store, store.list({ namespace: hint, limit, offset, ...wf }))),
              searchedNamespaces: [hint],
            });
          }
          return untrustedResultCut({
            ...listWithComputer(store, listWithDisputes(store, listReadable(limit, offset, wf))),
            searchedNamespaces: readable(),
          });
        }
        const result = store.list({ namespace, limit, offset, ...wf });
        return untrustedResultCut({
          ...listWithComputer(store, listWithDisputes(store, result)),
          searchedNamespaces: namespace ? [namespace] : [],
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_delete",
    {
      title: "Forget a note (archive)",
      annotations: { destructiveHint: true },
      description:
        "Forget a note by id: it is archived, so it no longer appears in search, lists or recall. " +
        "It is NOT erased: a person can bring it back with `monomem restore <id>` or the dashboard, " +
        "and only a person can delete it permanently (dashboard or `monomem delete <id>`). " +
        "Tell the user this when they ask you to forget something sensitive.",
      inputSchema: {
        id: zInt().describe("Id of the note to delete."),
      },
    },
    async ({ id }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        if (nsActive) {
          // Deletes (like updates) require the server's own namespace: a
          // read grant never confers delete access. Missing and foreign
          // notes report the same "no note" to avoid an existence oracle.
          const note = store.read(id); // gate-ok: admin delete: namespace check only
          if (!note || note.namespace !== ownNs) {
            return errorResult(`no note with id ${id}`);
          }
        }
        // An agent never erases: archive keeps the row so a mistaken or injected "forget" can be undone.
        const before = store.read(id); // gate-ok: admin forget: existence + archived check only, nothing returned
        if (!before) return errorResult(`no note with id ${id}`);
        if (before.archived_at) return errorResult(before.superseded_by == null ? archivedMessage(id, "already ") : `note ${id} is already archived`);
        if (!store.readVisible(id)) return errorResult(`no note with id ${id}`); // a distrusted writer's note reads as missing here too
        store.archive(id);
        audit({ op: "note.archive", id, namespace: before.namespace, label: conn.label, kind: "note", detail: "state_delete" });
        return textResult({
          archived: id,
          message:
            "Archived: hidden from search, lists and recall, not erased. Restore with `monomem restore " + id +
            "` or the dashboard; a permanent delete is done by a person in the dashboard or with `monomem delete " + id + "`.",
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
