// The per-connection state every MCP tool shares: the server (with its registerTool wrapper that filters the tool list,
// reports ignored arguments and runs each call inside the caller's actor context), the namespace rules and the read
// helpers. Split out of mcp-server-core.ts unchanged; the tool files under src/mcp/ take it as `c`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorStore, currentWriter } from "../actor.js";
import { z } from "zod";
import { Store, clampInt, type NoteRecord } from "../store.js";
import { distrustedOptInRefusal } from "../trust.js";
import { ORIGIN_DECLARED, ReadTaint, unconfirmedIdsIn } from "../taint.js";
import { withDisputes } from "../facts.js";
import { type Scope, PACKAGE_VERSION } from "../config.js";
import { ADMIN_SCOPE_NEEDED, scopeAllows, UNTRUSTED_BANNER } from "../security.js";
import { runSearch, runRelevantSearch, roundRobin, type SearchOpts, type RelevantOpts } from "../search-service.js";
import { type ServerNamespaceOpts, canRead, readableNamespaces } from "../namespace.js";
import { withWhenBase, WriterFilterArgs, splitIgnored, ignoredRefusal, withFields, withIgnored, errorResult, ConnectionCtx, OPERATOR_ONLY_TOOLS, READ_TOOLS, ID_PROBE_TOOLS, CREATING_TOOLS, noteIdsIn, STDIO_ADMIN_HINT, stdioAdminToolsAllowed } from "./shared.js";
import { toolProfile, newName, NEW_TOOLS, withToolHints, type ToolProfile } from "./tool-names.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { withComputer } from "../sync/marks.js";

/**
 * The 1.5 names each agent was already told the new name of. Keyed by the read-taint set: one per stdio process, one
 * per token writer over HTTP (mcp-http.ts makes a new server per request but keeps that set per writer).
 */
const renameHintsShown = new WeakMap<ReadTaint, Set<string>>();

export function mcpContext(store: Store, scope: Scope, opts: ServerNamespaceOpts, conn: ConnectionCtx) {
  const server = new McpServer({ name: "monomem", version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  // Stamp the connection's label on every write a tool makes (change_log.actor),
  // by running each tool handler inside the actor context.
  const profile: ToolProfile =
    opts.tools === "all" ? { legacy: false, visible: null } : opts.tools ? { legacy: false, visible: new Set(opts.tools.map(newName)) } : toolProfile();
  const enabled = profile.visible;
  /** Whether a 1.5 tool answers on this server: as itself (legacy-1.5), or as the hidden alias of a shown 1.6 tool. */
  const oldCallable = (name: string): boolean => !enabled || enabled.has(profile.legacy ? name : newName(name));
  /** The 1.5 tools as registered (their wrapped handler and argument schema), for the 1.6 tools to call. */
  const oldTools = new Map<string, { schema?: z.ZodType; cb: (...a: unknown[]) => unknown }>();
  const newNames = new Set(NEW_TOOLS);
  const localGuard = conn.local === true && !stdioAdminToolsAllowed();
  // 1.4.0: unconfirmed notes this connection has read. The stdio server is one process = one agent: its own set. An
  // HTTP connection gets a new server per request, so mcp-http.ts passes the token writer's set from its registry.
  const taintedReads: ReadTaint = conn.taintedReads ?? new ReadTaint();
  const connTaint = (): string[] => (conn.readsOutside ? [ORIGIN_DECLARED] : []); // read-taint (via:memory) is decided by the Store from taintedReads
  /** Whether a tool is offered on this server: descriptions name only tools the model was actually given. */
  const has = (name: string): boolean => oldCallable(name);
  /** A note for a read reply: staleness, a readable date and (R2-01) the dispute marker, computed inside the caller's request. */
  // Device sync: a note that came from another computer says which one (from_computer), on every MCP read.
  const withWhen = (n: NoteRecord) => withComputer(store, withDisputes(store, withWhenBase(n) as NoteRecord));
  const registerRaw = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, cfg: unknown, handler: unknown) => {
    // Every registered tool's name and description is sent to the model on
    // every turn, so an unused tool is a cost paid continuously. Registering
    // all 32 made the first measurable effect of installing Monomem a bigger
    // context bill, and gave the model a long menu to pick the wrong item from
    // (several hosts also cap how many tools they will accept).
    if (!oldCallable(name as string)) return undefined;
    if (localGuard && OPERATOR_ONLY_TOOLS.includes(name as string)) return undefined;
    // A raw shape is parsed loosely so an argument the tool does not have reaches here and is reported back
    // (ignored_arguments) instead of being dropped without a word. It is removed before the tool sees the call.
    const c = withToolHints(name as string, cfg as { inputSchema?: unknown; annotations?: Record<string, unknown> });
    const shape = c.inputSchema && !(c.inputSchema instanceof z.ZodType) ? (c.inputSchema as z.ZodRawShape) : undefined;
    const looseCfg = shape ? { ...c, inputSchema: z.looseObject(shape) } : c;
    const cb = (...rawArgs: unknown[]): unknown => {
      const known = shape ? splitIgnored(rawArgs[0], shape) : { args: rawArgs[0], ignored: [] };
      const args = [known.args, ...rawArgs.slice(1)];
      if (known.ignored.length) {
        const early = ignoredRefusal(name as string, rawArgs[0] as Record<string, unknown>, known.args as Record<string, unknown>, known.ignored);
        if (early) return errorResult(early);
        const out = runTool(name as string, handler, args);
        return out instanceof Promise ? out.then((r) => withIgnored(r, name as string, known.ignored, shape!)) : withIgnored(out, name as string, known.ignored, shape!);
      }
      return runTool(name as string, handler, args);
    };
    oldTools.set(name as string, { schema: (looseCfg as { inputSchema?: z.ZodType }).inputSchema, cb });
    // A 1.6 tool with the same name (memory_history) answers for it, except under legacy-1.5. memory_rollback is both.
    if (!profile.legacy && newNames.has(name as string) && name !== "memory_rollback") return undefined;
    const renamed = newName(name as string);
    if (profile.legacy || renamed === name) return registerRaw(name, looseCfg, cb);
    // A 1.5 name called directly: its reply is unchanged, plus (once per agent) a line naming the 1.6 tool.
    const line = `(${name as string} is now ${renamed}. The old name still works.)`;
    const seen = renameHintsShown.get(taintedReads) ?? new Set<string>();
    renameHintsShown.set(taintedReads, seen);
    const withHint = (r: unknown): unknown => {
      const res = r as { content?: unknown[]; isError?: boolean } | null;
      // Never on an error: a hidden note and a missing one must answer byte for byte the same (no oracle).
      if (seen.has(name as string) || !res || !Array.isArray(res.content) || res.isError) return r;
      seen.add(name as string);
      return { ...res, content: [...res.content, { type: "text", text: line }] };
    };
    return registerRaw(name, looseCfg, (...a: unknown[]) => {
      const out = cb(...a);
      return out instanceof Promise ? out.then(withHint) : withHint(out);
    });
  };

  const runTool = (name: string, handler: unknown, args: unknown[]): unknown => {
    {
      // include_distrusted turns the trust policy OFF for the call: admin only, for every tool.
      // A read/write connection (or an agent a hostile note talked into asking) gets a refusal.
      // The rule itself is distrustedOptInRefusal (trust.ts), shared with REST; this maps its answer to an error result.
      // A namespace-pinned admin: honoured for its OWN namespace only (the ones it merely reads belong to their own admins).
      // By-id tools (state_read, task_get) are checked against the note's namespace where they read it.
      const first = args[0] as { include_distrusted?: unknown; namespace?: unknown } | undefined;
      const why =
        first && first.include_distrusted === true
          ? distrustedOptInRefusal({
              admin: scopeAllows(scope, "admin"),
              local: localGuard,
              byId: name === "state_read" || name === "task_get",
              pinnedWithGrants: () => nsActive && readable().some((n) => n !== ownNs),
              ownNs,
              nsHint: first.namespace,
            })
          : null;
      if (why === "local") return errorResult(`include_distrusted shows notes from writers the operator distrusted. ${STDIO_ADMIN_HINT}`);
      if (why === "not-admin") return errorResult("include_distrusted needs an admin connection: it shows notes from writers the admin put on the distrust list");
      if (why === "other-namespace") {
        return errorResult(
          `include_distrusted is honoured only for this connection's own namespace ("${ownNs}"): pass namespace "${ownNs}". The namespaces it can only read are governed by their own admins.`
        );
      }
      return actorStore.run(
        {
          label: conn.label ?? "",
          authed: conn.authed === true,
          ...(conn.maxSensitivity !== undefined ? { maxSensitivity: conn.maxSensitivity } : {}),
          canDeclassify: scopeAllows(scope, "admin"),
          taint: connTaint(),
          taintedReads,
          ...(conn.cwd !== undefined ? { cwd: conn.cwd } : {}),
          // 1.4.0: a write's derived_from may only name notes this connection could read.
          ...(nsActive ? { readable: readable() } : {}),
        },
        () => {
          const fb0 = store.bodyIndexFallbacks();
          const out = (handler as (...x: unknown[]) => unknown)(...args);
          // R1-05: EVERY reply that hands this connection an unconfirmed note marks it, not only the read tools (a metadata edit,
          // a task claim and a history call echo the text too). The access log stays for read tools only.
          const marked = READ_TOOLS.has(name as string) ? logRead(name as string, args[0] as Record<string, unknown> | undefined, out) : markReads(name as string, args[0] as Record<string, unknown> | undefined, out);
          // C-06: a search that could not read sealed bodies says so in the reply (body_search), never silently.
          // ponytail: the fallback counter is per process; a concurrent call's fallback can add the notice here too (never drop it).
          const note = (r: unknown): unknown => {
            const n = store.bodySearchNotice(fb0);
            return n ? withFields(r, { body_search: n }) : r;
          };
          return marked instanceof Promise ? marked.then(note) : note(marked);
      });
    }
  };

  const markReads = (tool: string, a: Record<string, unknown> | undefined, out: unknown): unknown => {
    const mark = (r: unknown): unknown => {
      if (CREATING_TOOLS.has(tool) && a?.id === undefined) return r;
      const res = r as { isError?: boolean; content?: Array<{ text?: unknown }> } | undefined;
      const text = res?.content?.[0]?.text;
      if (res?.isError || typeof text !== "string") return r;
      let payload: unknown;
      try {
        payload = JSON.parse(text.startsWith(UNTRUSTED_BANNER) ? text.slice(UNTRUSTED_BANNER.length) : text);
      } catch {
        return r;
      }
      for (const id of unconfirmedIdsIn(payload)) taintedReads.add(id);
      return r;
    };
    return out instanceof Promise ? out.then(mark) : mark(out);
  };

  // Read access log (Store.logAccess): one row per successful read tool call, written inside the caller's actor context
  // so it carries the same identity a write would be stamped with. No tool reads the log back.
  const logRead = (tool: string, a: Record<string, unknown> | undefined, out: unknown): unknown => {
    const record = (r: unknown): unknown => {
      const res = r as { isError?: boolean; content?: Array<{ text?: unknown }> } | undefined;
      const text = res?.content?.[0]?.text;
      if (res?.isError || typeof text !== "string") return r;
      let payload: unknown;
      try {
        payload = JSON.parse(text.startsWith(UNTRUSTED_BANNER) ? text.slice(UNTRUSTED_BANNER.length) : text);
      } catch {
        payload = undefined;
      }
      if (payload && typeof payload === "object" && "error" in payload) return r;
      if (tool === "memory_quarantine" && a?.action !== "context") return r;
      // 1.4.0: this connection has now read outside content nobody confirmed; what it writes next is marked via:memory.
      for (const id of unconfirmedIdsIn(payload)) taintedReads.add(id);
      if (ID_PROBE_TOOLS.has(tool)) {
        for (const id of new Set([...noteIdsIn(a), ...noteIdsIn(payload)])) if (store.read(id)?.unconfirmed) taintedReads.add(id); // gate-ok: read-taint probe, a flag check, nothing returned
      }
      const query = typeof a?.query === "string" ? a.query : typeof a?.message === "string" ? a.message : a;
      store.logAccess({ tool, namespaces: typeof a?.namespace === "string" ? [a.namespace] : [], query, payload });
      return r;
    };
    return out instanceof Promise ? out.then(record) : record(out);
  };

  const denyIfUnder = (need: Scope): string | null =>
    scopeAllows(scope, need)
      ? null
      : `this token lacks the required '${need}' scope. ` +
        (need === "admin"
          ? ADMIN_SCOPE_NEEDED.slice(ADMIN_SCOPE_NEEDED.indexOf("Deleting"))
          : "This app's key can only read; a key that can also write is made with: monomem keys add <name> --scope write.");

  // Server-side namespace resolution, active only when the entry point
  // resolved a namespace at startup (see resolveStartupNamespace).
  const nsActive = typeof opts.namespace === "string" && opts.namespace.length > 0;
  const ownNs = opts.namespace ?? "";
  const grants = opts.readsFrom ?? {};
  const readable = (): string[] => readableNamespaces(ownNs, grants);
  // The model-supplied namespace is an UNTRUSTED HINT: usable only when it
  // names a namespace this server may actually read.
  const trustedHint = (hint: string | undefined): string | undefined =>
    hint && canRead(grants, ownNs, hint) ? hint : undefined;

  // Search across every readable namespace (used when the hint is missing
  // or names something unreadable). Fans out per namespace and merges with
  // round-robin interleaving: concatenating in namespace order would starve
  // later namespaces (the 2nd namespace gets zero hits at limit=5), while
  // interleaving gives each namespace a fair share.
  async function searchReadable(
    query: string,
    o: Omit<SearchOpts, "namespace">
  ): Promise<{ results: NoteRecord[]; searchedNamespaces: string[] }> {
    const limit = clampInt(o.limit, 20, 1, 200);
    const lists: NoteRecord[][] = [];
    for (const ns of readable()) {
      lists.push(await runSearch(store, query, { ...o, namespace: ns }));
    }
    return { results: roundRobin(lists, limit), searchedNamespaces: readable() };
  }

  // state_relevant across every readable namespace: same fan-out-and-merge
  // as searchReadable, but keywords are identical per namespace (they come
  // from the message, not the data), so only the results merge.
  async function relevantReadable(
    message: string,
    o: Omit<RelevantOpts, "namespace">
  ): Promise<{ keywords: string[]; results: NoteRecord[]; searchedNamespaces: string[] }> {
    const limit = clampInt(o.limit, 10, 1, 200);
    const lists: NoteRecord[][] = [];
    let keywords: string[] = [];
    for (const ns of readable()) {
      const r = await runRelevantSearch(store, message, { ...o, namespace: ns });
      keywords = r.keywords;
      lists.push(r.results);
    }
    return { keywords, results: roundRobin(lists, limit), searchedNamespaces: readable() };
  }

  // List across every readable namespace, newest-first like store.list
  // (updated_at DESC, id DESC), paged in SQL so total and deep offsets are
  // exact (the old merge-in-memory capped each namespace at 500 notes).
  function listReadable(limit?: number, offset?: number, wf: WriterFilterArgs = {}): { notes: NoteRecord[]; total: number } {
    return store.list({ namespaces: readable(), limit, offset, ...wf });
  }

  // An archived (forgotten, not replaced) note the caller may read gets a plain explanation instead of "no note", so an
  // agent does not quietly re-create it. Unreadable namespaces and distrusted writers keep the plain "no note".
  const archivedMessage = (id: number | string, already = ""): string =>
    `note ${id} is ${already}archived (hidden, not erased); a person can restore it with \`monomem restore ${id}\`; write a new note only if the user wants a fresh one`;
  const isArchivedVisible = (id: number, includeDistrusted = false): boolean => {
    const n = store.readVisible(id, { includeDistrusted }); // gate-ok: archived check, only a yes/no leaves here
    return Boolean(n?.archived_at && n.superseded_by == null && (!nsActive || canRead(grants, ownNs, n.namespace)));
  };
  const noNote = (id: number, includeDistrusted = false): string =>
    isArchivedVisible(id, includeDistrusted) ? archivedMessage(id) : `no note with id ${id}`;

  // The one gated by-id read behind state_read (a single id, or each of several).
  function readOne(
    id: number,
    start: number,
    max: number,
    neighbors: boolean,
    wantDistrusted: boolean
  ): { note: Record<string, unknown> } | { error: string; archived?: true } {
    // BLOCKER 4 / S-LOW-1: gate before tracking. The probe is an
    // untracked read -- no access-counter writes and no neighbor
    // computation -- so a denied cross-namespace read leaves
    // access_count, last_accessed, and search ranking untouched, and
    // existing-vs-missing ids cost the same.
    const probe = store.read(id); // gate-ok: access probe: readVisible decides before anything is returned
    // Uniform "no note": a distinct denial would let the caller probe
    // which ids exist in namespaces it cannot read.
    if (!probe || (nsActive && !canRead(grants, ownNs, probe.namespace))) return { error: `no note with id ${id}` };
    // Authorized: the ONE gated read, with tracking (and neighbors, when asked)
    // so the returned counters include this read. A distrusted writer's note
    // reads as "no note" unless an admin opts in (then it is marked).
    const includeDistrusted = wantDistrusted && (!nsActive || probe.namespace === ownNs);
    const note = store.readVisible(id, { hideArchived: true, trackAccess: true, withNeighbors: neighbors, includeDistrusted });
    if (!note) return isArchivedVisible(id, includeDistrusted) ? { error: archivedMessage(id), archived: true } : { error: `no note with id ${id}` };
    // Round edge scores to 3 decimals for readability (stored raw in
    // SQLite), mirroring memory_consolidation_candidates.
    const annotated = withWhen(note);
    const payload: Record<string, unknown> = note.neighbors
      ? { ...annotated, neighbors: note.neighbors.map((n) => ({ ...n, score: Math.round(n.score * 1000) / 1000 })) }
      : { ...annotated };
    const full = typeof note.body === "string" ? note.body : "";
    if (start > 0 || full.length > max) {
      const end = Math.min(full.length, start + max);
      return { note: { ...payload, body: full.slice(start, end), body_truncated: true, body_chars: full.length, ...(end < full.length ? { next_offset: end } : {}) } };
    }
    return { note: payload };
  }

  // --- Task board, handoffs, catch-up (conventions on notes; see tasks.ts) ---

  // Read scope: the model-supplied namespace is an untrusted hint when
  // resolution is active (same rule as memory_since / state_search).
  const readScope = (namespace: string | undefined): string[] | undefined => {
    if (nsActive) {
      const hint = trustedHint(namespace);
      return hint ? [hint] : readable();
    }
    return namespace ? [namespace] : undefined;
  };
  const writeScope = (): { namespace?: string } => (nsActive ? { namespace: ownNs } : {});
  // No consumer given: this connection's own writer (the token label, or stdio:<app>), so two apps sharing one store
  // each keep their own "last" marker instead of moving one shared "default" marker for each other.
  // A consumer key allows only [A-Za-z0-9._@-], so "stdio:claude-code" is kept as "stdio_claude-code".
  const ownConsumer = (consumer: string | undefined): string | undefined =>
    consumer ?? ((conn.label || currentWriter()).replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64) || undefined);

  return { server, store, scope, opts, conn, enabled, profile, oldTools, oldCallable, localGuard, taintedReads, connTaint, has, withWhen, registerRaw, runTool, markReads, logRead, denyIfUnder, nsActive, ownNs, grants, readable, trustedHint, searchReadable, relevantReadable, listReadable, archivedMessage, isArchivedVisible, noNote, readOne, readScope, writeScope, ownConsumer };
}

export type McpCtx = ReturnType<typeof mcpContext>;
