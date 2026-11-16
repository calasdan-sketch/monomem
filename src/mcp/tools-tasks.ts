// MCP tools: Task board, runner status, handoffs, catch_up and memory_ack.
// Moved out of createMcpServer (mcp-server-core.ts) unchanged; it calls these in a fixed order, which is the tools/list order.

import { z } from "zod";
import { QuarantinedError } from "../store.js";
import type { LintFinding } from "../lint.js";
import { putTask, listTasks, getTask, writeHandoff, catchUp, claimTask, approveTask, TASK_STATUSES, TaskNotFoundError, TASK_LIMITS } from "../tasks.js";
import { ackChanges } from "../changes.js";
import { runnerStatus } from "../liveness.js";
import { audit } from "../security.js";
import { maybeEmbed } from "../search-service.js";
import { textResult, zInt, untrustedResult, INCLUDE_DISTRUSTED_SHAPE, WRITER_FILTER_SHAPE, NOTE_WRITER_SHAPE, writerFilterArgs, noteWriterArgs, quarantinedResult, withWarnings, errorResult, errorFor, STDIO_ADMIN_HINT } from "./shared.js";
import type { McpCtx } from "./context.js";

export function registerTaskTools(c: McpCtx): void {
  const { server, store, conn, localGuard, has, denyIfUnder, nsActive, ownNs, readable, readScope, writeScope, ownConsumer } = c;
  server.registerTool(
    "task_put",
    {
      title: "Create or update a task",
      // Can queue a command for the runner (still needs admin approval + the runner's allowlist).
      annotations: { destructiveHint: true },
      description:
        "Shared task board across devices and models. Create a task (no `id`: `title` required) or update one " +
        "(`id`: only the fields you pass change). status: idea | planned | running | blocked | done | queued | failed. " +
        "`next_step` is the one concrete thing to do next; `owner` is which device/chat/model has it " +
        "(e.g. \"phone\", \"pc-claude-code\"). Pass `if_rev` (from a previous result) to avoid overwriting a " +
        "change another session just made. Pass `client_key` (any unique string you invent, e.g. a UUID) when " +
        "creating so a retry returns the same task instead of making a duplicate. Optional: priority 0-9, due, " +
        "parent_id, blocked_by[]. To take a task so no one else works it, use task_claim. " +
        "COMMAND TASKS: `command {action, params}` + `target` (the runner name) queues a task for the PC's " +
        "command runner; it runs ONLY after an admin approves it (task_approve) and only if the action is on the " +
        "PC's allowlist. Tasks are notes tagged `task`: they show up in memory_since and search." +
        (nsActive ? " SERVER-RESOLVED NAMESPACE: tasks are written to this server's own namespace." : ""),
      inputSchema: {
        id: z.number().int().optional().describe("Task id to update. Omit to create."),
        ...(nsActive ? {} : { namespace: z.string().optional().describe("Namespace for a new task. Default 'default'.") }),
        title: z.string().optional().describe(`Short single-line title (max ${TASK_LIMITS.title}, no line breaks). Required when creating.`),
        status: z.enum(TASK_STATUSES).optional().describe("idea | planned | running | blocked | done | queued | failed (default idea)."),
        next_step: z.string().optional().describe(`The next concrete step, one line (max ${TASK_LIMITS.nextStep}). Empty string clears it.`),
        owner: z.string().optional().describe("Which device, chat or model owns this now. Empty string clears it."),
        notes: z.string().optional().describe(`Free-form details (max ${TASK_LIMITS.notes}).`),
        if_rev: z.number().int().optional().describe("Compare-and-swap: only update if the task is still at this rev."),
        client_key: z.string().optional().describe("Idempotency key for creating: same key + namespace returns the existing task (replayed:true)."),
        priority: z.number().int().nullable().optional().describe(`0-${TASK_LIMITS.priorityMax}; null clears.`),
        due: z.string().nullable().optional().describe("YYYY-MM-DD or an ISO time; empty/null clears."),
        parent_id: z.number().int().nullable().optional().describe("Id of the parent task (same namespace); null clears."),
        blocked_by: z.array(z.number().int()).optional().describe("Ids of tasks that must finish first; [] clears."),
        command: z
          .object({
            // Same rule validateCommand enforces: an allowlist action NAME, never a command line.
            action: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).describe("Allowlist action name (letters, digits, . _ : -), not a shell command."),
            params: z.record(z.string(), z.string()).optional(),
          })
          .nullable()
          .optional()
          .describe("Command task: runner allowlist action + string params. null removes it. Needs `target`. Changing it voids any approval."),
        target: z.string().optional().describe("Runner name the command is for; must equal the runner's own id."),
        approve: z.boolean().optional().describe("ADMIN tokens only, when creating a command task: approve it in the same call."),
      },
    },
    async ({ id, namespace, title, status, next_step, owner, notes, if_rev, client_key, priority, due, parent_id, blocked_by, command, target, approve }) => {
      const warnings: LintFinding[] = [];
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        if (approve) {
          if (localGuard) return errorResult(`approve:true lets a command run on this machine. ${STDIO_ADMIN_HINT}`);
          const d = denyIfUnder("admin");
          if (d) return errorResult(`approve:true needs an admin token (${d}); an admin can call task_approve`);
          if (id !== undefined || !command) return errorResult("approve:true applies when creating a command task");
        }
        const put = putTask(
          store,
          { id, namespace, title, status, next_step, owner, notes, if_rev, client_key, priority, due, parent_id, blocked_by, command, target },
          writeScope(),
          warnings
        );
        await maybeEmbed(store, put.note);
        let task = put.task;
        if (approve && !put.replayed) task = approveTask(store, { id: task.id, if_rev: task.rev }, writeScope());
        audit({
          op: "task.put",
          id: task.id,
          namespace: task.namespace,
          label: conn.label,
          kind: task.command ? "command-task" : "task",
          detail: put.replayed ? "replay" : id === undefined ? "create" : "update",
        });
        return untrustedResult(withWarnings({ task, ...(put.replayed ? { replayed: true } : {}) }, warnings));
      } catch (e) {
        if (e instanceof QuarantinedError) return quarantinedResult(e);
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "task_get",
    {
      title: "Get one task",
      annotations: { readOnlyHint: true },
      description:
        "One task in full: notes, command, approval state and result. task_list and catch_up return compact rows." +
        (nsActive ? " Only readable namespaces." : ""),
      inputSchema: { id: z.number().int().describe("Task id."), ...INCLUDE_DISTRUSTED_SHAPE },
    },
    async ({ id, include_distrusted }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        if (include_distrusted === true && nsActive) {
          // A pinned admin sees hidden tasks of its OWN namespace only.
          try {
            return untrustedResult({ task: getTask(store, id, [ownNs], { includeDistrusted: true }) });
          } catch (e) {
            if (!(e instanceof TaskNotFoundError)) throw e;
          }
          return untrustedResult({ task: getTask(store, id, readable()) });
        }
        return untrustedResult({ task: getTask(store, id, nsActive ? readable() : undefined, { includeDistrusted: include_distrusted === true }) });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim, heartbeat or release a task",
      description:
        "Take a task so no other session works it at the same time. Atomic compare-and-swap: if someone else holds " +
        "an unexpired claim you get a conflict error naming the holder and expiry. Claiming a task you already hold " +
        "extends it (use as a heartbeat; call again before `ttl_seconds` runs out). `release: true` gives it up. " +
        "An expired claim can be taken by anyone. A claim is cooperative: it protects against other claimers, not " +
        "against a plain task_put edit by an unrelated writer (except changing `owner`).",
      inputSchema: {
        id: z.number().int().describe("Task id."),
        owner: z.string().describe('Who is claiming: device/chat/model label, e.g. "pc-claude-code".'),
        ttl_seconds: z.number().int().optional().describe(`Lease length (${TASK_LIMITS.ttlMin}-${TASK_LIMITS.ttlMax}, default ${TASK_LIMITS.ttlDefault}).`),
        release: z.boolean().optional().describe("Give the claim up (only the holder can)."),
      },
    },
    async ({ id, owner, ttl_seconds, release }) => {
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        const r = claimTask(store, { id, owner, ttl_seconds, release }, writeScope());
        audit({
          op: "task.claim",
          id: r.task.id,
          namespace: r.task.namespace,
          label: conn.label,
          kind: "task",
          detail: r.released ? "release" : r.heartbeat ? "heartbeat" : "claim",
        });
        return untrustedResult(r);
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "task_approve",
    {
      title: "Approve (or revoke) a command task",
      description:
        "ADMIN only. Approve the command currently stored on a queued task so the PC's runner may execute it " +
        "(still only if the action is on the PC's allowlist and the task's `target` is that runner). The approval " +
        "is bound to a hash of the command: editing the command, its params or its target afterwards voids it. " +
        "`revoke: true` withdraws it (and clears any lease). Read the task (task_get) first and pass back its " +
        "`command_hash` (or `rev` as if_rev): the approval is refused if the command changed since you read it. " +
        "An approval expires (default 24 h) and is consumed when the runner starts the task.",
      inputSchema: {
        id: z.number().int().describe("Task id."),
        revoke: z.boolean().optional().describe("Withdraw the approval instead."),
        command_hash: z.string().optional().describe("The task's command_hash exactly as task_get showed it. Required to approve (or pass if_rev)."),
        if_rev: z.number().int().optional().describe("Alternatively the task's rev as task_get showed it."),
      },
    },
    async ({ id, revoke, command_hash, if_rev }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        const task = approveTask(store, { id, revoke, command_hash, if_rev }, writeScope());
        audit({ op: revoke ? "task.revoke" : "task.approve", id: task.id, namespace: task.namespace, label: conn.label, kind: "task" });
        return untrustedResult({ task });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      annotations: { readOnlyHint: true },
      description:
        "List tasks on the shared board, most recently changed first. By default shows everything except " +
        "done; pass status (idea | planned | running | blocked | done | queued | failed) for one status, or \"all\" to include done. " +
        "Filter by `owner` to see what one device/model is holding." +
        (nsActive ? " The `namespace` parameter is an untrusted hint: only readable namespaces are searched." : ""),
      inputSchema: {
        status: z.string().optional().describe('One status, "open" (default: all but done) or "all".'),
        owner: z.string().optional().describe("Only tasks owned by this device/chat/model."),
        parent_id: z.number().int().optional().describe("Only subtasks of this task."),
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: restrict to this namespace." : "Restrict to this namespace."),
        limit: z.number().int().optional().describe(`Max tasks (default 50, max ${TASK_LIMITS.maxList}).`),
        ...WRITER_FILTER_SHAPE,
      },
    },
    async ({ status, owner, parent_id, namespace, limit, written_by, not_written_by, include_distrusted }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const namespaces = readScope(namespace);
        const { tasks, total } = listTasks(store, { namespaces, status, owner, parent_id, limit, ...writerFilterArgs(written_by, not_written_by, include_distrusted) });
        return untrustedResult({ tasks, total, searchedNamespaces: namespaces ?? [] });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "runner_status",
    {
      title: "Is the PC's runner listening? (commands waiting)",
      annotations: { readOnlyHint: true },
      description:
        "Read-only. Whether the PC's command runner looks online or stale (age of its last heartbeat), and, per readable " +
        "namespace, how many admin-approved command tasks are still waiting for it, how many of those have an approval " +
        "ending within 1 h, how many approvals already expired, and how long the oldest has waited. Use it when an approved " +
        "command has not run: a stale runner means the PC is off or asleep and the command will run when it wakes " +
        "(unless the approval expires first). Counts and ages only, never command text (task_get shows that). " +
        "The runner's liveness comes from the server's own timestamp of its heartbeat note (only a note written by the runner process counts); " +
        "it is a good hint, not a cryptographic proof (a human can check a signed result on the sign page). Only commands addressed to that runner, " +
        "in the namespace it serves, are counted. The result lists `targets`: one entry per runner id (its state, age and the commands waiting for exactly that runner); " +
        "a target that never sent a heartbeat is listed with `namespace_unconfirmed: true` and counted in the command's own namespace." +
        (nsActive ? " The `namespace` parameter is an untrusted hint: only readable namespaces are counted." : ""),
      inputSchema: {
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: restrict to this namespace." : "Restrict to this namespace."),
      },
    },
    async ({ namespace }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const namespaces = readScope(namespace);
        return untrustedResult({ ...runnerStatus(store, namespaces, undefined, { pinned: nsActive }), searchedNamespaces: namespaces ?? [] });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "session_handoff",
    {
      title: "Write a session handoff",
      description:
        "Leave a structured handoff for the next session (any device or model) before you stop: what you did, " +
        "what is still pending, what was decided, and the one next step. The next session reads it with " +
        "catch_up (or it appears at session start via `monomem recall`). Stored as a note tagged `handoff`. " +
        "Pass `client_key` so a retry returns the same handoff instead of a duplicate." +
        (nsActive ? " SERVER-RESOLVED NAMESPACE: written to this server's own namespace." : ""),
      inputSchema: {
        surface: z.string().describe('Who is handing off: device/chat/model, e.g. "phone" or "claude-code on pc".'),
        ...(nsActive ? {} : { namespace: z.string().optional().describe("Namespace. Default 'default'.") }),
        summary: z.string().optional().describe(`One or two sentences (max ${TASK_LIMITS.summary}).`),
        done: z.array(z.string()).optional().describe("What got done (short items)."),
        pending: z.array(z.string()).optional().describe("What is still open."),
        decisions: z.array(z.string()).optional().describe("Decisions made that the next session must respect."),
        next_step: z.string().optional().describe("The single next thing to do."),
        client_key: z.string().optional().describe("Idempotency key: same key + namespace returns the existing handoff (replayed:true)."),
      },
    },
    async ({ surface, namespace, summary, done, pending, decisions, next_step, client_key }) => {
      const warnings: LintFinding[] = [];
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        const w = writeHandoff(
          store,
          { surface, namespace, summary, done, pending, decisions, next_step, client_key },
          writeScope(),
          warnings
        );
        await maybeEmbed(store, w.note);
        audit({ op: "handoff.write", id: w.handoff.id, namespace: w.handoff.namespace, label: conn.label, kind: "handoff", detail: w.replayed ? "replay" : "create" });
        return untrustedResult(withWarnings({ handoff: w.handoff, ...(w.replayed ? { replayed: true } : {}) }, warnings));
      } catch (e) {
        if (e instanceof QuarantinedError) return quarantinedResult(e);
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "catch_up",
    {
      title: "Catch up (start of session)",
      // Not readOnlyHint: it advances this consumer's marker (unless ack_mode is manual).
      description:
        "One call to learn where things stand: what changed since THIS consumer last called (titles only; the " +
        `marker then advances), the open tasks (compact: title, status, owner, next step${has("task_get") ? " -- task_get for the rest" : ""}), ` +
        "and the latest handoffs. Call it first in a new session, passing " +
        'a stable `consumer` label for this device/model (e.g. "phone", "claude-code-pc"). The first call for a ' +
        "label covers the last 24h. If your client may die before it has handled the result, pass " +
        `\`ack_mode:"manual"\`: the marker then moves only when you send the returned \`ack_token\` back (${["memory_since", "memory_ack"].filter(has).length ? `next catch_up, ${["memory_since", "memory_ack"].filter(has).join(" or ")}` : "on your next catch_up"}).` +
        (nsActive ? " The `namespace` parameter is an untrusted hint: only readable namespaces are included." : ""),
      inputSchema: {
        consumer: z.string().optional().describe('Label for the "last" marker (default: this connection\'s own writer name; pass "default" for the shared one).'),
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: restrict to this namespace." : "Restrict to this namespace."),
        include_changes: z.boolean().optional().describe("false = skip the changes part (and leave the marker alone). Default true."),
        tasks: zInt().optional().describe("Max open tasks (default 20)."),
        handoffs: zInt().optional().describe("Max handoffs (default 3)."),
        ack_mode: z.enum(["auto", "manual"]).optional().describe("auto (default): marker advances now. manual: it advances when you return `ack_token`."),
        ack_token: z.string().optional().describe("Token from an earlier ack_mode:manual call: moves the marker before reading."),
        exclude_self: z.boolean().optional().describe("Hide changes written by the token whose label equals your `consumer` label (see memory_since)."),
        ...WRITER_FILTER_SHAPE,
        ...NOTE_WRITER_SHAPE,
      },
    },
    async ({ consumer, namespace, include_changes, tasks, handoffs, ack_mode, ack_token, exclude_self, written_by, not_written_by, include_distrusted, note_written_by, not_note_written_by }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const namespaces = readScope(namespace);
        const out = catchUp(store, {
          namespaces,
          consumer: ownConsumer(consumer),
          changes: include_changes,
          tasks,
          handoffs,
          ackMode: ack_mode,
          ackToken: ack_token,
          excludeSelf: exclude_self,
          ...writerFilterArgs(written_by, not_written_by, include_distrusted),
          ...noteWriterArgs(note_written_by, not_note_written_by),
        });
        if (out.changes) {
          audit({
            op: "catch_up",
            label: conn.label,
            kind: "changes",
            detail: `consumer=${out.changes.consumer} total=${out.changes.counts.total}${out.changes.ack_token ? " manual-ack" : " marker-advanced"}${out.changes.acked ? " acked" : ""}`,
          });
        }
        return untrustedResult({ ...out, searchedNamespaces: namespaces ?? [] });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_ack",
    {
      title: "Acknowledge a change-feed page",
      description:
        'Confirm you handled the changes from a memory_since / catch_up call made with ack_mode:"manual": pass its ' +
        "`ack_token` and the consumer\'s \"last\" marker moves there (never backwards). Until then the same changes are returned again.",
      inputSchema: {
        ack_token: z.string().describe("The ack_token from the final page of an ack_mode:manual read."),
        consumer: z.string().optional().describe("Same consumer label you read with (default: this connection's own writer name)."),
        namespace: z.string().optional().describe(nsActive ? "Untrusted hint: same scope you read with." : "Same namespace you read with."),
        source: z.string().optional().describe("Same source filter you read with."),
        ...WRITER_FILTER_SHAPE,
        ...NOTE_WRITER_SHAPE,
      },
    },
    async ({ ack_token, consumer, namespace, source, written_by, not_written_by, include_distrusted, note_written_by, not_note_written_by }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        const namespaces = readScope(namespace);
        const r = ackChanges(store, { ackToken: ack_token, consumer: ownConsumer(consumer), namespaces, source, ...writerFilterArgs(written_by, not_written_by, include_distrusted), ...noteWriterArgs(note_written_by, not_note_written_by) });
        audit({ op: "changes.ack", label: conn.label, kind: "changes", detail: `consumer=${r.consumer} seq=${r.seq}` });
        return textResult({ acked: true, ...r });
      } catch (e) {
        return errorFor(e);
      }
    }
  );
}
