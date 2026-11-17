// MCP tools: Operator views and upkeep: memory_stats, memory_receipt, memory_why, consolidation, memory_rebuild_edges, memory_since.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { currentCeiling } from "../actor.js";
import { z } from "zod";
import { clampInt, REBUILD_CONFIRM_NOTE_COUNT, CHANGES_MAX_LIMIT, type NoteRecord } from "../store.js";
import { waitForChanges, parseWait, WAIT_MAX_SECONDS, WAIT_RECOMMENDED_SECONDS } from "../change-wait.js";
import { scopeAllows, audit } from "../security.js";
import { maybeEmbed } from "../search-service.js";
import { meterStats } from "../meter.js";
import { receiptList, receiptGet } from "../receipts.js";
import { noteWhy } from "../why.js";
import { noteTouched } from "../blast-radius.js";
import { findCandidatesGuarded, resolveConsolidationNotes, consolidateNotes, buildConsolidationPreview, clampThreshold } from "../consolidate.js";
import { textResult, untrustedResult, WRITER_FILTER_SHAPE, NOTE_WRITER_SHAPE, writerFilterArgs, noteWriterArgs, errorResult, errorFor } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerAdminTools(c: McpCtx): void {
  const { server, store, scope, conn, denyIfUnder, nsActive, ownNs, readable, trustedHint, ownConsumer } = c;
  server.registerTool(
    "memory_stats",
    {
      title: "Memory access statistics",
      annotations: { readOnlyHint: true },
      description:
        "Read-only access-tracking stats for the shared state store: total notes, total reads, the most-read notes, how many notes were never read (dead-memory candidates for future cleanup), and how many notes are stale (older than the configured staleness thresholds). `meter`: what Monomem costs (estimated tokens injected at session start and the full note text they stood in for, local-model tokens, capture events, database size), aggregate numbers only." +
        (nsActive
          ? " SERVER-RESOLVED NAMESPACE: stats are scoped to the namespaces this server may read."
          : ""),
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict stats to this namespace. Ignored unless this server may read it."
              : "Restrict stats to this namespace."
          ),
      },
    },
    async ({ namespace }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        // Namespace-scoped: with server-side resolution, stats count only the
        // readable namespaces (own + grants), never the whole store. Without
        // resolution, an explicit namespace restricts; otherwise the whole
        // store is counted (legacy behavior).
        let namespaces: string[] | undefined;
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
        } else if (namespace) {
          namespaces = [namespace];
        }
        // mostAccessed carries note titles -- attacker-writable content
        // returned pre-prompt -- so the untrusted-data banner applies, like
        // every other tool that echoes stored note content.
        return untrustedResult({ ...store.accessStats(namespaces, { hideDistrusted: !scopeAllows(scope, "admin") }), ...(currentCeiling() === undefined ? { meter: meterStats(store, namespaces) } : {}) });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  // Opt-in (MONOMEM_TOOLS=memory_receipt), not in DEFAULT_TOOLS: the default surface stays ten tools.
  server.registerTool(
    "memory_receipt",
    {
      title: "Memory receipt",
      annotations: { readOnlyHint: true },
      description:
        "Read-only: which memories a session start showed the agent and why (note id, rank, why-tag, approximate tokens). With session_id: that session, with note titles looked up now (a note deleted since is marked). Without: the most recent sessions. Receipts store ids and tags only, never note text." +
        (nsActive ? " Scoped to the namespaces this server may read." : ""),
      inputSchema: {
        session_id: z.string().max(200).optional().describe("The session to show; omit to list recent sessions."),
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: restrict to this namespace. Ignored unless this server may read it." : "Restrict to this namespace."),
      },
    },
    async ({ session_id, namespace }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        let namespaces: string[] | undefined;
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
        } else if (namespace) {
          namespaces = [namespace];
        }
        if (!session_id) return untrustedResult({ sessions: receiptList(store, namespaces) });
        const r = receiptGet(store, session_id, namespaces);
        return r ? untrustedResult(r) : errorResult(`no receipt for session ${session_id}`);
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  // Opt-in (MONOMEM_TOOLS=memory_why), not in DEFAULT_TOOLS, like memory_receipt. Titles only, never the body.
  server.registerTool(
    "memory_why",
    {
      title: "Why a memory is what it is",
      annotations: { readOnlyHint: true },
      description:
        "Read-only: the story of one note in time order: who wrote it (server-stamped or a config label), its versions, what replaced it or it replaced, held edits, pin, which session starts were shown it and why, and its status. Titles only, never note text. A note from a distrusted writer reads as missing. Ends with what is NOT recorded (for example who read it)." +
        (nsActive ? " Scoped to the namespaces this server may read." : ""),
      inputSchema: {
        id: z.number().int().describe("The note id."),
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: restrict to this namespace. Ignored unless this server may read it." : "Restrict to this namespace."),
        touched: z.boolean().optional().describe("Admin: instead, who read it and what was built on it afterwards (proven vs likely)."),
      },
    },
    async ({ id, namespace, touched }) => {
      try {
        const denied = denyIfUnder(touched === true ? "admin" : "read");
        if (denied) return errorResult(denied);
        // r4 L3: who read a note comes from the store-wide read log; an app key confined to namespaces does not get it (as REST).
        if (touched === true && nsActive && conn.authed === true) return errorResult("touched comes from the store-wide read log: use a key that is not pinned to a namespace");
        let namespaces: string[] | undefined;
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
        } else if (namespace) {
          namespaces = [namespace];
        }
        const note = store.readVisible(id);
        if (!note || (namespaces && !namespaces.includes(note.namespace))) return errorResult(`no note ${id}`);
        if (touched === true) return untrustedResult(noteTouched(store, note, { namespaces, operator: false }));
        return untrustedResult(noteWhy(store, note, { namespaces }));
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_consolidation_candidates",
    {
      title: "Find duplicate note candidates",
      annotations: { readOnlyHint: true },
      description:
        "Find near-duplicate notes (cosine similarity over title + body) that are candidates for consolidation. Same-namespace only; never suggests cross-namespace merges. Read-only, but requires the admin scope: the scan is O(n^2) CPU, so it runs one at a time under a time budget (narrow it with `namespace` on large stores).",
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe("Restrict the scan to this namespace."),
        threshold: z
          .number()
          .optional()
          .describe(
            "Similarity threshold 0.5..1.0 (default 0.95). Out-of-range values are clamped, not rejected."
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max candidate pairs to return (default 50, max 200)."),
      },
    },
    async ({ namespace, threshold, limit }, extra) => {
      try {
        // Admin, not read: one call costs up to MAX_CANDIDATE_NOTES^2 pair
        // scores, so a read token must not be able to burn the server's CPU.
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        // When server-side namespace resolution is active, the model-supplied
        // namespace is an untrusted hint: intersect with the readable set.
        let notes: NoteRecord[];
        if (nsActive) {
          const hint = trustedHint(namespace);
          const allowed = hint ? [hint] : readable();
          const allowedSet = new Set(allowed);
          notes = store.exportAll({ live: true }).filter((n) => allowedSet.has(n.namespace)); // gate-ok: consolidation candidates (admin): filtered with filterVisible
        } else {
          notes = store
            .exportAll({ live: true }) // gate-ok: consolidation candidates (admin): filtered with filterVisible
            .filter((n) => !namespace || n.namespace === namespace);
        }
        // Titles of distrusted writers' notes are not shown to the agent.
        notes = store.filterVisible(notes);
        // Guarded cooperative scan: yields to the event loop so a large
        // sweep doesn't stall concurrent traffic, runs one at a time under
        // a deadline, and stops if the client goes away (the SDK aborts
        // extra.signal on cancellation and on transport close).
        const pairs = await findCandidatesGuarded(notes, {
          threshold: clampThreshold(threshold, 0.95),
          limit: clampInt(limit, 50, 1, 200),
          signal: extra.signal,
        });
        const byId = new Map(notes.map((n) => [n.id, n]));
        return untrustedResult({
          candidates: pairs.map((c) => ({
            idA: c.idA,
            idB: c.idB,
            score: Math.round(c.score * 1000) / 1000,
            titleA: byId.get(c.idA)?.title ?? "",
            titleB: byId.get(c.idB)?.title ?? "",
          })),
          count: pairs.length,
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_consolidate",
    {
      title: "Consolidate duplicate notes",
      annotations: { destructiveHint: true },
      description:
        "Merge 2+ duplicate notes into one: longest title wins (or merged_title), bodies are deduplicated and joined, tags are unioned. Deletes the source notes unless keep_sources is true, so this requires the admin scope (same policy as state_delete). Pass dry_run: true to preview the merge without writing anything.",
      inputSchema: {
        ids: z
          .array(z.number().int())
          .min(2)
          .describe("Ids of the notes to merge (2 or more, all in one namespace)."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview the merge without writing anything (default false)."),
        merged_title: z
          .string()
          .optional()
          .describe("Title for the merged note. Defaults to the longest source title."),
        keep_sources: z
          .boolean()
          .optional()
          .describe("Keep the source notes after merging (default false: they are deleted)."),
      },
    },
    async ({ ids, dry_run, merged_title, keep_sources }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        // S-LOW-2: when server-side resolution is active, every invalid id
        // -- missing, foreign-namespace, or mixed with own-namespace ids --
        // collapses to the same uniform "no note" error. The old code
        // resolved first and then gated, producing three distinguishable
        // errors ("no note with id 99999" vs "cannot consolidate notes from
        // different namespaces" vs "access denied: ..."), which let a
        // caller probe id existence in namespaces it cannot read.
        // (Without resolution there is no cross-namespace boundary, so the
        // detailed validation errors stay.)
        if (nsActive) {
          const bad = ids.find((id) => {
            const n = store.read(id); // gate-ok: admin consolidate: namespace check only
            return !n || n.namespace !== ownNs;
          });
          if (bad !== undefined) return errorResult(`no note with id ${bad}`);
        }
        // Same validation as the real merge, so dry_run previews exactly
        // what would (or would not) be allowed to run. Under nsActive the
        // uniform gate above already rejected every non-own id, so the
        // namespace errors below are unreachable there.
        const notes = resolveConsolidationNotes(store, ids);
        const keep = keep_sources === true;
        if (dry_run) {
          const preview = buildConsolidationPreview(notes, merged_title);
          return untrustedResult({
            dry_run: true,
            would_create: preview,
            would_delete: keep ? [] : ids,
          });
        }
        const merged = consolidateNotes(store, ids, {
          deleteSources: !keep,
          mergedTitle: merged_title,
        });
        // The merge path doesn't embed (store.create is embedding-agnostic);
        // do it here so the merged note is visible to semantic search.
        await maybeEmbed(store, merged);
        return untrustedResult({ merged, deleted: keep ? [] : ids });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_rebuild_edges",
    {
      title: "Rebuild similarity edges",
      annotations: { destructiveHint: true, idempotentHint: true },
      description:
        "Recalculate the note similarity graph from scratch: every note is " +
        "re-scored against same-namespace notes (cosine similarity over title " +
        "+ body) and pairs at/above `threshold` get bidirectional edges. " +
        "Reports {created, removed} directed-edge counts plus the pair count " +
        "scored. O(n^2) -- run as maintenance after bulk imports or threshold " +
        "changes, not interactively. The rebuild is cooperative (it yields " +
        "to concurrent traffic and commits in chunks), but above " +
        `${REBUILD_CONFIRM_NOTE_COUNT} notes in scope it refuses unless ` +
        "`confirm` is true -- tell the user the pair count first." +
        (nsActive
          ? " Rebuilds only this server's own namespace (writes stay local)."
          : ""),
      inputSchema: {
        threshold: z
          .number()
          .optional()
          .describe(
            "Similarity floor for an edge (default 0.25). Must be in (0, 1]."
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required when the note count in scope exceeds " +
              `${REBUILD_CONFIRM_NOTE_COUNT}: re-call with confirm: true ` +
              "after telling the user how many pairs will be scored."
          ),
        // When server-side namespace resolution is active, writes stay in
        // the resolved namespace (same policy as memory_consolidate), so the
        // model-supplied namespace is stripped from the schema rather than
        // accepted-and-ignored. Kept when resolution is off, where it is
        // honored (legacy behavior).
        ...(nsActive
          ? {}
          : {
              namespace: z
                .string()
                .optional()
                .describe(
                  "Rebuild edges for this namespace only. Omit to rebuild the whole store."
                ),
            }),
      },
    },
    async ({ threshold, namespace, confirm }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        if (currentCeiling() !== undefined) {
          return errorResult("rebuilding the similarity graph covers every note; it needs a token with no sensitivity ceiling");
        }
        // BLOCKER 1: price the O(n^2) work before doing it. Above the
        // confirmation threshold the tool refuses unless the caller passes
        // confirm: true -- one admin tool call must not silently kick off a
        // multi-minute CPU-bound rebuild.
        const scope = nsActive ? ownNs : namespace;
        const plan = store.rebuildPlan(scope ? { namespace: scope } : {});
        const notes = plan.reduce((s, g) => s + g.notes, 0);
        const pairs = plan.reduce((s, g) => s + g.pairs, 0);
        if (notes > REBUILD_CONFIRM_NOTE_COUNT && confirm !== true) {
          return errorResult(
            `refusing: rebuilding edges would score ~${pairs.toLocaleString("en-US")} pairs ` +
              `across ${notes.toLocaleString("en-US")} notes in scope (over the ` +
              `${REBUILD_CONFIRM_NOTE_COUNT}-note confirmation threshold). ` +
              `Re-run with confirm: true to proceed.`
          );
        }
        // An invalid threshold surfaces as a ValidationError -> clean tool
        // error (never a 500-style internal fault).
        const result = await store.rebuildEdgesCooperative({
          threshold,
          namespace: scope,
        });
        // Counts only -- no note content -- so no untrusted-data banner.
        return textResult({ ...result, pairs });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_since",
    {
      title: "What changed since",
      // Not readOnlyHint: since:"last" advances this consumer's marker (or,
      // with ack_mode "manual", hands out an ack_token that does).
      description:
        "Change feed: notes created, updated, or deleted since a point in time, oldest first, " +
        "with totals grouped by provenance source. Titles only (read a note for its body). " +
        '`since` is an ISO time, a duration back from now ("24h", "7d"), or "last" = since this ' +
        "`consumer` last read the feed to the end (first use: the last 24h). Page with `cursor`." +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are included."
          : ""),
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('ISO time, a duration like "24h"/"7d", or "last". Required unless `cursor` is given.'),
        cursor: z.string().optional().describe("nextCursor from a previous page."),
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict to this namespace. Ignored unless this server may read it."
              : "Restrict to this namespace."
          ),
        source: z.string().optional().describe("Only changes to notes with this provenance source (the writer's own CLAIM; see written_by)."),
        ...WRITER_FILTER_SHAPE,
        ...NOTE_WRITER_SHAPE,
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Max entries per page (default 100, max ${CHANGES_MAX_LIMIT}).`),
        consumer: z
          .string()
          .optional()
          .describe('Label for the "last" marker, e.g. "phone" or "claude-code" (default: this connection\'s own writer name; pass "default" for the shared one).'),
        wait_seconds: z
          .number()
          .int()
          .optional()
          .describe(
            `Live wait: if nothing new yet, hold the call open up to this many seconds and return the moment something changes in your scope. Use ${WAIT_RECOMMENDED_SECONDS}: proxies and tunnels often cut an idle response at 30s (hard cap ${WAIT_MAX_SECONDS}). Returns timedOut:true if nothing did; just call again. Not with \`cursor\`; best with since:"last". Alias: wait.`
          ),
        wait: z.number().int().optional().describe("Alias of wait_seconds."),
        ack_mode: z
          .enum(["auto", "manual"])
          .optional()
          .describe(
            'auto (default): the "last" marker advances when the final page is served. manual: it does NOT; the final page returns an `ack_token` and the marker moves only when you pass it back as `ack_token` (here or in memory_ack) -- use this if your client can die before it has handled the changes.'
          ),
        ack_token: z.string().optional().describe("Token from an earlier ack_mode:manual page: moves the marker before reading."),
        exclude_self: z
          .boolean()
          .optional()
          .describe("Hide changes WRITTEN BY the token/connection whose label equals your `consumer` label (the writer is recorded by the server; writes with no recorded writer fall back to the note's `source`). Only works if each device has its own token label."),
      },
    },
    async ({ since, cursor, namespace, source, written_by, not_written_by, include_distrusted, note_written_by, not_note_written_by, limit, consumer, wait_seconds, wait, ack_mode, ack_token, exclude_self }, extra) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        let namespaces: string[] | undefined;
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
        } else if (namespace) {
          namespaces = [namespace];
        }
        const signals = [extra?.signal, conn.signal].filter((x): x is AbortSignal => Boolean(x));
        const out = await waitForChanges(
          store,
          { since, cursor, namespaces, source, ...writerFilterArgs(written_by, not_written_by, include_distrusted), ...noteWriterArgs(note_written_by, not_note_written_by), limit, consumer: ownConsumer(consumer), ackMode: ack_mode, ackToken: ack_token, excludeSelf: exclude_self },
          {
            waitSeconds: parseWait(wait_seconds ?? wait),
            signal: signals.length ? AbortSignal.any(signals) : undefined,
            key: conn.waitKey ?? "mcp-local",
            scopeKey: namespaces ? [...namespaces].sort().join(",") : "*",
          }
        );
        if (ack_token) audit({ op: "changes.ack", label: conn.label, kind: "changes", detail: `consumer=${out.consumer ?? ""}` });
        // Titles are attacker-writable content: untrusted banner.
        return untrustedResult({ ...out, searchedNamespaces: namespaces ?? [] });
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
