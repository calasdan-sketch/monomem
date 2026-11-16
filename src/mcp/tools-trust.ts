// MCP tools: Held writes and the trust policy: memory_quarantine, trust_policy.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { z } from "zod";
import { quarantineCasNote } from "../store.js";
import { maybeEmbed } from "../search-service.js";
import { textResult, errorResult, errorFor } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerTrustTools(c: McpCtx): void {
  const { server, store, denyIfUnder, nsActive, ownNs } = c;
  server.registerTool(
    "memory_quarantine",
    {
      title: "Review quarantined writes",
      description:
        "Admin review queue for writes the memory linter held (prompt-injection-like text, or secrets " +
        "when MONOMEM_LINT says quarantine). Quarantined writes are not notes: they are invisible to " +
        "search, list, and recall until approved. action=list shows id, reasons, namespace and time only -- " +
        "never the held text, which a human reviews in the dashboard or with `monomem quarantine list`; " +
        "context lists the other notes in the same namespace saved since the write was held that share its topic " +
        "(ids, titles, times, writers; never the held text); " +
        "approve applies the write as originally requested, keeping the time it was written (a held edit fails if the note changed since); " +
        "keep_history stores it with its written time and marks it replaced by the newest related note from context (or `by`), " +
        "and is refused when there is none; reject discards it. " +
        "Requires the admin scope." +
        (nsActive ? " Only this server's own namespace is visible." : ""),
      annotations: { destructiveHint: true },
      inputSchema: {
        action: z.enum(["list", "context", "approve", "keep_history", "reject"]).describe("list, context, approve, keep_history, or reject."),
        id: z.number().int().optional().describe("Quarantine id (required for every action but list)."),
        by: z.number().int().optional().describe("keep_history only: the newer note that replaces it (default: the newest one context lists)."),
        limit: z.number().int().optional().describe("Max entries for list (default 50, max 500)."),
      },
    },
    async ({ action, id, by, limit }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        if (action === "list") {
          // Metadata only: the held text is what the linter flagged, so it must never reach a
          // model -- reading it "as untrusted" is still reading it. A human sees the content in
          // the dashboard or with `monomem quarantine list`.
          const entries = store
            .listQuarantine({ namespaces: nsActive ? [ownNs] : undefined, limit })
            .map(({ id, op, target_id, namespace, reasons, created_at }) => ({ id, op, target_id, namespace, reasons, created_at }));
          return textResult({ quarantined: entries, count: entries.length });
        }
        if (id === undefined) return errorResult(`id is required for ${action}`);
        const entry = store.getQuarantine(id);
        // Uniform "no such entry" for foreign namespaces: no existence oracle.
        if (!entry || (nsActive && entry.namespace !== ownNs)) {
          return errorResult(`no quarantined write with id ${id}`);
        }
        if (action === "reject") {
          store.rejectQuarantine(id);
          return textResult({ rejected: id });
        }
        if (action === "context") {
          // Other notes only (ids, titles, times, writers), exactly what a list of the namespace shows; never the held text.
          const ctx = store.quarantineContext(id)!;
          return textResult({
            id,
            op: ctx.op,
            target_id: ctx.target_id,
            namespace: ctx.namespace,
            held_at: ctx.held_at,
            ...(ctx.target_changed !== undefined ? { target_changed: ctx.target_changed } : {}),
            ...(ctx.clears ? { clears: ctx.clears } : {}),
            since_held: ctx.notes,
            note: quarantineCasNote(ctx.op),
          });
        }
        if (action === "keep_history") {
          const kept = store.keepQuarantineAsHistory(id, by);
          await maybeEmbed(store, kept.note); // S-01: the kept note is searchable by meaning on every surface, as from the CLI
          return textResult({ kept_as_history: id, note_id: kept.note.id, superseded_by: kept.superseded_by });
        }
        const note = store.approveQuarantine(id);
        await maybeEmbed(store, note);
        // Id only, for the same reason as list: approving must not echo the flagged text back.
        return textResult({ approved: id, note_id: note.id });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "trust_policy",
    {
      title: "Trust policy: distrusted writers and trusted attesters",
      description:
        "Admin-only. Manage who this store does NOT trust. `distrust` puts a writer (a token label such as \"phone\", or a stable " +
        "writer_id `<server_id>/<label>`) on a namespace's distrust list (namespace \"*\" = every namespace): notes that writer last " +
        "wrote are then left out of recall, search, list, relevant, memory_since, catch_up, tasks, handoffs and the command runner " +
        "(a distrusted command task is NEVER run) unless a read passes include_distrusted:true. `undistrust` removes the entry. " +
        "`add_attester` / `remove_attester` manage the public keys whose signed export attestations an import will believe " +
        "(a verified note keeps its original writer in `attested_writer`); `revoke_attester` / `unrevoke_attester` stop trusting a key at once. " +
        "Signed attestations and cross-server writer ids are EXPERIMENTAL and may change in a minor release. `list` shows the policy, the recent trust log and this " +
        "server's identity (server_id and public key to give another server's admin). Changes are audit-logged. " +
        "The list lives in the database and cannot be set by a write token or by note content. See docs/trust.md." +
        (nsActive ? " This server is pinned to its own namespace: it can manage only that namespace's rules and cannot change the attester list." : ""),
      annotations: { destructiveHint: true },
      inputSchema: {
        action: z.enum(["list", "distrust", "undistrust", "add_attester", "remove_attester", "revoke_attester", "unrevoke_attester"]).describe("What to do."),
        ...(nsActive ? {} : { namespace: z.string().optional().describe('Namespace of the rule (distrust / undistrust); "*" = every namespace.') }),
        writer: z.string().optional().describe("Token label or writer_id to distrust / undistrust."),
        public_key: z.string().optional().describe("add_attester: the other server's 43-character base64url public key (from `monomem trust identity`)."),
        server_id: z.string().optional().describe("add_attester: the server id this key signs for. Required unless any_server is true: a key is trusted for ONE server."),
        any_server: z.boolean().optional().describe("add_attester: EXPERIMENTAL escape hatch. Trust the key for ANY server id (discouraged: the key holder can then claim to be any peer)."),
        not_after: z.string().optional().describe("add_attester: ISO time at which trust in this key ENDS (judged when an import is verified). An expiry, not a revocation: use revoke_attester for a leaked key."),
        label: z.string().optional().describe("add_attester: a note to yourself about whose key this is."),
        key_id: z.string().optional().describe("remove_attester / revoke_attester / unrevoke_attester: the 16-hex-digit key id."),
        reason: z.string().optional().describe("revoke_attester: why (kept in the trust log)."),
      },
    },
    async (args: { action: string; namespace?: string; writer?: string; public_key?: string; server_id?: string; any_server?: boolean; not_after?: string; label?: string; key_id?: string; reason?: string }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        const ns = nsActive ? ownNs : (args.namespace ?? "").trim();
        const attesterGuard = (): string | null => (nsActive ? "the attester list is server-wide: use an admin connection that is not pinned to a namespace" : null);
        switch (args.action) {
          case "list": {
            // Read-only: reports the key only if one already exists (never creates it).
            const view = store.trustView(nsActive ? ownNs : undefined);
            return textResult({ ...store.peekIdentity(), distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log });
          }
          case "distrust":
            return textResult({ distrust: store.distrustAdd(ns, args.writer ?? ""), matched_notes: store.distrustMatchCount(ns, args.writer ?? ""), rules: store.trustView(nsActive ? ownNs : undefined).distrust });
          case "undistrust":
            return textResult({ removed: store.distrustRemove(ns, args.writer ?? ""), rules: store.trustView(nsActive ? ownNs : undefined).distrust });
          case "add_attester": {
            const g = attesterGuard();
            if (g) return errorResult(g);
            return textResult({
              attester: store.attesterAdd({
                public_key: args.public_key ?? "",
                server_id: args.server_id,
                label: args.label,
                any_server: args.any_server === true,
                not_after: args.not_after,
              }),
              attesters: store.attesterList(),
            });
          }
          case "remove_attester": {
            const g = attesterGuard();
            if (g) return errorResult(g);
            return textResult({ removed: store.attesterRemove(args.key_id ?? ""), attesters: store.attesterList() });
          }
          case "revoke_attester": {
            const g = attesterGuard();
            if (g) return errorResult(g);
            return textResult({ revoked: store.attesterRevoke(args.key_id ?? "", args.reason ?? ""), revocations: store.revocationList() });
          }
          case "unrevoke_attester": {
            const g = attesterGuard();
            if (g) return errorResult(g);
            return textResult({ removed: store.attesterUnrevoke(args.key_id ?? ""), revocations: store.revocationList() });
          }
          default:
            return errorResult("unknown action");
        }
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
