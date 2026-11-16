// MCP tools: Progressive disclosure: memory_index, memory_timeline, memory_get, session_list.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { z } from "zod";
import { memoryIndex, memoryTimeline, memoryGet, sessionList, sessionGet, GET_MAX_IDS, type ReadScope } from "../progressive.js";
import { untrustedResult, INCLUDE_DISTRUSTED_SHAPE, errorResult, errorFor } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerSessionTools(c: McpCtx): void {
  const { server, store, denyIfUnder, nsActive, readScope } = c;
  // ---- Automatic memory: progressive disclosure (progressive.ts; REST parity in api.ts) ------------------------------
  const capScope = (namespace?: string, include_distrusted?: boolean): ReadScope => ({
    namespaces: readScope(namespace),
    ...(include_distrusted === true ? { includeDistrusted: true } : {}),
  });
  const NS_HINT = {
    namespace: z
      .string()
      .optional()
      .describe(nsActive ? "Untrusted hint: restrict to this namespace. Ignored unless this server may read it." : "Restrict to this namespace."),
  };

  server.registerTool(
    "memory_index",
    {
      title: "Index of memory (start here)",
      annotations: { readOnlyHint: true },
      description:
        "START HERE to look something up in memory. Returns COMPACT rows (id, kind, type, title, date, files, ~tokens) for notes, " +
        "captured observations (bugfix, feature, decision, ...) and session summaries, newest first or best match first with `query`. " +
        "Cheap: scan the rows, then open the interesting ones with memory_timeline (what happened around it) and memory_get (full text). " +
        "Cite what you use as om:#<id>.",
      inputSchema: {
        query: z.string().optional().describe("Full-text search words (any order)."),
        kind: z.enum(["note", "observation", "summary", "all"]).optional().describe("Row kind (default all)."),
        obs_type: z.string().optional().describe("Observation type: bugfix, feature, refactor, change, discovery, decision, security_alert, security_note."),
        file: z.string().optional().describe("Only rows linked to this file path (as shown in `files`)."),
        session: z.string().optional().describe("Only rows from this session id."),
        since: z.string().optional().describe("Only rows created at/after this ISO-8601 date or time."),
        limit: z.number().int().optional().describe("Max rows (default 30, max 200)."),
        ...NS_HINT,
        ...INCLUDE_DISTRUSTED_SHAPE,
      },
    },
    async ({ query, kind, obs_type, file, session, since, limit, namespace, include_distrusted }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        return untrustedResult(memoryIndex(store, capScope(namespace, include_distrusted), { query, kind, obs_type, file, session, since, limit }));
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_timeline",
    {
      title: "What happened around a memory",
      annotations: { readOnlyHint: true },
      description:
        "Compact rows before and after an anchor, oldest first: the anchor is a note id, or the best match for query / file / session. " +
        "Use after memory_index to see the context of a row (what led to a fix, what came after a decision); then memory_get for full text.",
      inputSchema: {
        anchor: z.number().int().optional().describe("Note id to centre on."),
        query: z.string().optional().describe("Or: centre on the best match for these words."),
        file: z.string().optional().describe("Or: centre on the newest row linked to this file."),
        session: z.string().optional().describe("Or: centre on this session (and stay inside it)."),
        before: z.number().int().optional().describe("Rows before the anchor (default 5, max 50)."),
        after: z.number().int().optional().describe("Rows after the anchor (default 5, max 50)."),
        ...NS_HINT,
        ...INCLUDE_DISTRUSTED_SHAPE,
      },
    },
    async ({ anchor, query, file, session, before, after, namespace, include_distrusted }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        return untrustedResult(memoryTimeline(store, capScope(namespace, include_distrusted), { anchor, query, file, session, before, after }));
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_get",
    {
      title: "Full text of memories",
      annotations: { readOnlyHint: true },
      description:
        `The full notes for up to ${GET_MAX_IDS} ids (from memory_index / memory_timeline), with their files, their session and a citation (om:#<id>). ` +
        "Fetch only what you need. Ids you may not read come back in `missing`.",
      inputSchema: {
        ids: z.array(z.number().int()).describe(`Note ids (max ${GET_MAX_IDS}).`),
        ...INCLUDE_DISTRUSTED_SHAPE,
      },
    },
    async ({ ids, include_distrusted }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        return untrustedResult(memoryGet(store, capScope(undefined, include_distrusted), ids));
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "session_list",
    {
      title: "Recorded agent sessions",
      annotations: { readOnlyHint: true },
      description:
        "Agent sessions Monomem recorded (newest first): folder, start/end, prompt and event counts, and the title of the session summary. " +
        "Pass `session` for one session with its observations as compact rows.",
      inputSchema: {
        session: z.string().optional().describe("One session id: its summary and observations."),
        limit: z.number().int().optional().describe("Max sessions (default 20, max 200)."),
        ...NS_HINT,
      },
    },
    async ({ session, limit, namespace }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const scope = capScope(namespace);
        if (session) {
          const one = sessionGet(store, scope, session);
          return one ? untrustedResult(one) : errorResult(`no session ${session}`);
        }
        return untrustedResult(sessionList(store, scope, limit));
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
