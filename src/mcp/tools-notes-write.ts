// MCP tools: Writing notes: state_write, memory_confirm, memory_flag.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { SENSITIVITY_LEVELS } from "../sensitivity.js";
import { z } from "zod";
import { QuarantinedError, StaleWriteError } from "../store.js";
import { currentWriter } from "../actor.js";
import type { LintFinding } from "../lint.js";
import { assertPlainWriteTags, assertReviewedTag } from "../reserved-tags.js";
import { prepareNoteUpdate, overwriteNotice, staleDetail } from "../note-update.js";
import { withFacts, COMMON_FACT_KEYS } from "../facts.js";
import { scopeAllows, printableWords } from "../security.js";
import { checkFilesInput } from "../code-anchor.js";
import { maybeEmbed } from "../search-service.js";
import { canRead } from "../namespace.js";
import { RECEIPT_CHECK } from "../store/write-receipt.js";
import { zInt, zTags, zFacts, noBody, untrustedResult, untrustedError, quarantinedResult, withConflicts, withWarnings, errorResult, errorFor } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerNotesWriteTools(c: McpCtx): void {
  const { server, store, scope, denyIfUnder, nsActive, ownNs, grants, noNote } = c;
  server.registerTool(
    "state_write",
    {
      title: "Write shared state",
      description:
        "Create a new note in the shared cross-surface state store, or update an existing one if `id` is given. Returns the resulting note without its body (state_read id=N has it)." +
        " When the note records a decision or setting, also pass `facts`: other agents then read the exact value, and a disagreement is caught." +
        (nsActive
          ? " SERVER-RESOLVED NAMESPACE: this server writes to its own namespace; no `namespace` parameter is accepted."
          : ""),
      inputSchema: {
        id: zInt().optional().describe("Id of an existing note to update. Omit to create a new note."),
        // When server-side namespace resolution is active the model-supplied
        // namespace is dropped entirely (writes always land in the resolved
        // namespace), so the parameter is stripped from the schema rather
        // than accepted-and-ignored. Kept when resolution is off, where it
        // is honored (legacy behavior).
        ...(nsActive
          ? {}
          : {
              namespace: z
                .string()
                .optional()
                .describe("Namespace/bucket for the note. Defaults to 'default'."),
            }),
        title: z
          .string()
          .optional()
          .describe("Note title. When creating a note without one, it is made from the body's first line (about 60 characters) and the reply says so."),
        body: z.string().optional().describe("Note body/content."),
        tags: zTags().optional().describe("Tags for the note (a list, or one comma-separated string)."),
        facts: zFacts()
          .optional()
          .describe(
            "Settings as key/value pairs, e.g. {\"package_manager\":\"pnpm\",\"test_runner\":\"vitest\"}. Use a common key when one fits: " + COMMON_FACT_KEYS.join(", ") + ". Add a subject prefix only when the project has several (api.deploy_target). At most 10; keys are lowercase a-z 0-9 _ . - (max 40 chars), values one line of at most 80 chars. The reply may carry `conflicts` (another writer states a different value; your write still succeeds, so tell the user) or `similar_keys` and a `hint` (an existing key looks like the same setting; follow the hint)."
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Optional: who or what you CLAIM this note came from (not checked). The server records who really wrote it separately."
          ),
        if_rev: z
          .number()
          .int()
          .optional()
          .describe(
            "Compare-and-swap: only update if the note is still at this revision (from a prior read). Omit to force."
          ),
        forget_after: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Retention: days until this note is archived (soft-deleted, restorable). On update, resets the deadline; 0 clears it. Omit to keep the current deadline (none for new notes)."
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .nullable()
          .optional()
          .describe(
            "Optional CLAIM, 0 to 1, of how sure you are of this note (0 = a guess, 1 = certain). It is only your claim: the server stores it next to your name, shows it to readers as a claim, and never uses it to rank notes or to override who is trusted. On update, null removes it."
          ),
        sensitivity: z
          .preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(SENSITIVITY_LEVELS))
          .optional()
          .describe(
            "Who may read this note: public, internal (default) or private. A connection with a ceiling cannot read, write or relabel above it; lowering a label needs an admin."
          ),
        outside: z
          .boolean()
          .optional()
          .describe(
            "Set true when this note's content came from outside (a web page, a document, another server). The note is then marked unconfirmed until a person confirms it. It can only add the mark, never remove it."
          ),
        derived_from: z
          .array(z.union([z.number().int().positive(), z.string().regex(/^\d{1,15}$/)]))
          .max(20)
          .optional()
          .describe(
            "Ids of the notes this one was built from (at most 20). Links are only ever added, never removed. A note built from an unconfirmed note is marked unconfirmed too."
          ),
        client_key: z
          .string()
          .optional()
          .describe("Idempotency key for creating (any unique string you invent, e.g. a UUID): a retry with the same key returns the note the first write made (deduplicated:true) instead of a duplicate."),
        files: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("When creating: the files in this git repository the note is about (at most 20, e.g. [\"src/auth.ts\"], tracked by git). When one of them changes in a later commit, reads label the note `[code changed since this was written: ...]` until a person checks it."),
      },
    },
    async ({ id, namespace, title: givenTitle, body, tags: plainTags, facts, source, if_rev, forget_after, confidence, sensitivity, outside, derived_from, client_key, files }) => {
      const warnings: LintFinding[] = [];
      let title = givenTitle;
      let tags = plainTags;
      // R2-06: the audit line of this write's decision (accepted, held, refused) comes back as `receipt`.
      const withReceipt = (r = store.takeWriteReceipt()) => (r ? { receipt: r, receipt_check: RECEIPT_CHECK } : {});
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        store.takeWriteReceipt(); // drop a decision left by an earlier call
        // task / handoff / task.* tags belong to task_put and session_handoff.
        // 1.5.0 (A2): for an update the guard runs below, on the note this caller may see (the same order as REST), so a
        // reserved-tag refusal can't reveal a hidden note.
        if (tags !== undefined && id === undefined) {
          assertPlainWriteTags(tags, undefined);
          assertReviewedTag(tags, undefined, false);
        }
        if (id !== undefined && client_key !== undefined) return errorResult("client_key applies to creating a note; use if_rev to guard an update");
        if (id !== undefined && files !== undefined) return errorResult("files applies to creating a note; a person refreshes an existing note's files with monomem review keep <id>");
        const anchorFiles = checkFilesInput(files);
        if (id !== undefined) {
          // When namespace resolution is active the model-supplied namespace
          // is dropped entirely (the note keeps its existing namespace), and
          // the note being updated must live in THIS server's namespace --
          // a read grant never confers write access, otherwise an
          // update-by-id could rewrite notes from a granted namespace. A
          // missing or foreign note reports the same "no note" so the caller
          // can't probe which ids exist in namespaces it may not write.
          // A note the distrust list hides reads as missing here too (only an admin may rewrite it). The checks are shared with
          // REST PUT /notes/:id (note-update.ts). `reviewed` is never an MCP caller's: an admin connection is an agent.
          const check = prepareNoteUpdate(store, { admin: scopeAllows(scope, "admin"), mayReview: false, ...(nsActive ? { ownNs } : {}) }, id, tags, facts);
          if (!check.ok) return errorResult(check.why === "missing" ? noNote(id, scopeAllows(scope, "admin")) : `no note with id ${id}`);
          tags = check.tags;
          const patch = nsActive
            ? { title, body, tags, source, forget_after, confidence, sensitivity, outside, derived_from }
            : { namespace, title, body, tags, source, forget_after, confidence, sensitivity, outside, derived_from };
          const result = store.update(id, patch, { ifRev: if_rev, lintWarnings: warnings });
          if (!result) return errorResult(`no note with id ${id}`);
          const { unchanged, ...updated } = result;
          const receipt = withReceipt(); // before any await: the write is synchronous, the next one is not ours
          // r2-improvement #3: replacing another writer's text without if_rev is said out loud (that writer sees it in catch_up).
          const overwrite = !unchanged && if_rev === undefined ? overwriteNotice(check.target, updated, currentWriter()) : null;
          if (!unchanged) await maybeEmbed(store, updated);
          // A partial update echoes back the merged note, which can include a
          // pre-existing body planted by someone else -- wrap it as untrusted.
          return untrustedResult(withConflicts(withWarnings({ note: noBody(updated), ...(unchanged ? { unchanged: true } : {}), ...(overwrite ?? {}), ...receipt }, warnings), store, updated, facts));
        }
        let titleGenerated = false;
        if (!title || !title.trim()) {
          const first = (body ?? "").split("\n").map((l) => l.trim()).find(Boolean);
          if (!first) return errorResult("a new note needs a title or a body");
          title = printableWords(first, 60);
          titleGenerated = true;
        }
        // Writes always go to the server-resolved namespace when active; the
        // model-supplied `namespace` is ignored (prompt-injection guard).
        tags = withFacts(plainTags, facts);
        const once = store.createOnce(
          nsActive
            ? { namespace: ownNs, title, body, tags, source, forget_after, sensitivity, outside, derived_from, ...(typeof confidence === "number" ? { confidence } : {}) }
            : { namespace, title, body, tags, source, forget_after, sensitivity, outside, derived_from, ...(typeof confidence === "number" ? { confidence } : {}) },
          client_key,
          { lintWarnings: warnings, ...(anchorFiles ? { files: anchorFiles } : {}) }
        );
        const receipt = withReceipt();
        // R2-04: a retry with a known key wrote nothing; the reply is the note the first write made.
        if (once.deduplicated) return untrustedResult({ note: noBody(once.note), deduplicated: true });
        const created = once.note;
        await maybeEmbed(store, created);
        const sim = store.similarNote(created.id);
        return untrustedResult(withConflicts(withWarnings({ note: noBody(created), ...receipt, ...(titleGenerated ? { title_generated: `No title was given, so it was made from the body's first line. To change it: state_write id=${created.id} title="..."` } : {}), ...(sim ? { similar_note: { id: sim.id, title: sim.title, hint: `looks similar to #${sim.id} - consider updating it (state_write with id=${sim.id}) if this is the same thing` } } : {}) }, warnings), store, created, facts));
      } catch (e) {
        const receipt = withReceipt(store.refusedWriteReceipt(e, id));
        if (e instanceof QuarantinedError) return quarantinedResult(e, receipt);
        if (e instanceof StaleWriteError && id !== undefined && if_rev !== undefined) {
          const d = staleDetail(store, id, if_rev);
          if (d) return untrustedError(d.message, { stale: d.stale, ...receipt });
        }
        return errorFor(e, receipt);
      }
    }
  );

  // 1.4.0: not in DEFAULT_TOOLS (it costs context every turn, and over stdio a confirm never counts). A token agent that
  // checks notes for others turns it on with MONOMEM_TOOLS. It never lifts the block on pinning: only a person can.
  server.registerTool(
    "memory_confirm",
    {
      title: "Confirm a note from outside content",
      description:
        "Record that you checked a note marked unconfirmed (from outside content) against a source. It counts only when you did not write the note, connect with your own key (not a local connection), name a source different from the note's own and from earlier confirms, and have not read the note's text yet. A counted confirm is corroboration, not verification: it lets the note back into session start, never lets it be pinned. The reply says whether it counted and why.",
      inputSchema: {
        id: zInt().describe("Id of the note to confirm."),
        source: z.string().max(200).optional().describe("What you checked it against (a URL or a short description). Required for it to count."),
      },
    },
    async ({ id, source }) => {
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        const probe = store.read(id); // gate-ok: namespace check only; confirm() re-reads through readVisible
        if (!probe || (nsActive && !canRead(grants, ownNs, probe.namespace))) return errorResult(`no note with id ${id}`);
        const r = store.confirm(id, { source });
        if (!r) return errorResult(noNote(id));
        return untrustedResult({ counted: r.counted, kind: r.kind, ...(r.reason ? { reason: r.reason } : {}), message: r.message, id: r.id, rev: r.rev });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  // 1.5.0 (R2-02): not in DEFAULT_TOOLS; turn it on with MONOMEM_TOOLS=memory_flag. Same rules as POST /notes/:id/flag.
  server.registerTool(
    "memory_flag",
    {
      title: "Flag a note that looks wrong",
      description:
        "Say that a note looks wrong or out of date, with a one-line reason, instead of overwriting it. The note does not change. Until a person looks at it, a note nobody confirmed is left out of session start; a note a person confirmed stays, labelled. You cannot flag your own note (change it instead); at most 20 flags a day.",
      inputSchema: {
        id: zInt().describe("Id of the note that looks wrong."),
        reason: z.string().describe("One line: what looks wrong and why (at most 200 characters), e.g. \"package.json says pnpm\"."),
      },
    },
    async ({ id, reason }) => {
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        // A flag changes what session start shows in the note's namespace: like an edit, only in this server's own namespace.
        const probe = store.read(id); // gate-ok: namespace check only; flagNote re-reads through readVisible
        if (!probe || (nsActive && probe.namespace !== ownNs)) return errorResult(`no note with id ${id}`);
        const r = store.flagNote(id, reason);
        if (!r) return errorResult(`no note with id ${id}`);
        return untrustedResult({ flagged: true, id: r.note_id, rev: r.rev, message: "Flag recorded. The note is unchanged; a person decides in monomem review." });
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
