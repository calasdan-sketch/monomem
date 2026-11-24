// REST routes: task board, handoffs, catch-up and runner status.
// Moved out of createApiServer's request handler (api.ts) unchanged; handle() tries the route files in a fixed order.
// Each returns true when it answered the request, false to let the next one try.

import { ValidationError } from "../store.js";
import { truthyParam } from "../trust.js";
import { scopeAllows, audit } from "../security.js";
import { runnerStatus } from "../liveness.js";
import { readBody } from "../http-common.js";
import { maybeEmbed } from "../search-service.js";
import { putTask, listTasks, getTask, writeHandoff, listHandoffs, catchUp, claimTask, approveTask, approveOrHold, TaskNotFoundError, ClaimConflictError } from "../tasks.js";
import { ackChanges } from "../changes.js";
import type { LintFinding } from "../lint.js";
import { sendError, sendJson, ackModeParam, writerFilter, feedWriterFilter, flagParam, intParam, parseJsonBody } from "./shared.js";
import type { ApiCtx, ApiReq } from "./context.js";

export async function taskRoutes(c: ApiCtx, r: ApiReq): Promise<boolean> {
  const { store, readable, trustedHint } = c;
  const { req, res, url, path, principal, scope, nsCtx, refuseDistrustedOptIn } = r;
  // --- Task board, handoffs, catch-up (conventions on notes; tasks.ts) ---
  // Same gating as the notes routes: GET = read, POST/PUT = write (see
  // requiredScope); writes land in the request's own namespace when
  // namespace resolution / a token pin is active; reads cover the
  // readable set, with ?namespace= as an untrusted hint.
  if (
    path === "/tasks" ||
    path === "/handoffs" ||
    path === "/catch-up" ||
    path === "/runner/status" ||
    path === "/ack" ||
    /^\/tasks\/\d+(\/(claim|approve))?$/.test(path)
  ) {
    const readNs = (): string[] | undefined => {
      const hint = url.searchParams.get("namespace") ?? undefined;
      if (nsCtx.active) {
        const t = trustedHint(nsCtx, hint);
        return t ? [t] : readable(nsCtx);
      }
      return hint ? [hint] : undefined;
    };
    const writeNs = nsCtx.active ? { namespace: nsCtx.ownNamespace } : {};
    const jsonBody = async (): Promise<Record<string, unknown> | null> => {
      const raw = await readBody(req);
      try {
        const v = parseJsonBody(raw);
        if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      } catch {
        /* fall through */
      }
      sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
      return null;
    };
    try {
      if (req.method === "GET" && path === "/tasks") {
        const namespaces = readNs();
        const limit = intParam(url, "limit", 1);
        const { tasks, total } = listTasks(store, {
          namespaces,
          status: url.searchParams.get("status") ?? undefined,
          owner: url.searchParams.get("owner") ?? undefined,
          parent_id: intParam(url, "parent_id", 1),
          limit,
          ...writerFilter(url),
        });
        sendJson(res, 200, { tasks, total, searchedNamespaces: namespaces ?? [] });
        return true;
      }
      const getId = /^\/tasks\/(\d+)$/.exec(path);
      if (req.method === "GET" && getId) {
        const namespaces = readNs();
        try {
          const wantDistrusted = flagParam(url, "include_distrusted");
          const tid = Number(getId[1]);
          if (wantDistrusted && nsCtx.active) {
            // A pinned admin sees hidden tasks of its OWN namespace only; a task of a namespace it merely reads is shown as for any reader.
            try {
              sendJson(res, 200, { task: getTask(store, tid, [nsCtx.ownNamespace], { includeDistrusted: true }) });
              return true;
            } catch (e) {
              if (!(e instanceof TaskNotFoundError)) throw e;
            }
            sendJson(res, 200, { task: getTask(store, tid, namespaces) });
            return true;
          }
          sendJson(res, 200, { task: getTask(store, tid, namespaces, { includeDistrusted: wantDistrusted }) });
        } catch (e) {
          if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
          else throw e;
        }
        return true;
      }
      const sub = /^\/tasks\/(\d+)\/(claim|approve)$/.exec(path);
      if (req.method === "POST" && sub) {
        const body = await jsonBody();
        if (!body) return true;
        try {
          if (sub[2] === "claim") {
            const r = claimTask(store, { ...(body as object), id: Number(sub[1]) } as never, writeNs);
            audit({ op: "task.claim", id: r.task.id, namespace: r.task.namespace, label: principal.label, kind: "task", detail: r.released ? "release" : r.heartbeat ? "heartbeat" : "claim" });
            sendJson(res, 200, r);
          } else {
            const task = approveTask(
              store,
              {
                id: Number(sub[1]),
                revoke: body.revoke === true,
                command_hash: typeof body.command_hash === "string" ? body.command_hash : undefined,
                if_rev: typeof body.if_rev === "number" ? body.if_rev : undefined,
              },
              writeNs
            );
            audit({ op: body.revoke === true ? "task.revoke" : "task.approve", id: task.id, namespace: task.namespace, label: principal.label, kind: "task" });
            sendJson(res, 200, { task });
          }
        } catch (e) {
          if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
          else if (e instanceof ClaimConflictError) sendJson(res, 409, { error: e.message, holder: e.holder, until: e.until });
          else throw e;
        }
        return true;
      }
      if (req.method === "POST" && path === "/ack") {
        const body = await jsonBody();
        if (!body) return true;
        if (truthyParam(String(body.include_distrusted ?? "")) && refuseDistrustedOptIn(url.searchParams.get("namespace"))) return true;
        const namespaces = readNs();
        const r = ackChanges(store, {
          ackToken: typeof body.ack_token === "string" ? body.ack_token : "",
          consumer: typeof body.consumer === "string" ? body.consumer : undefined,
          namespaces,
          source: typeof body.source === "string" ? body.source : undefined,
          ...(typeof body.written_by === "string" && body.written_by ? { writtenBy: body.written_by } : {}),
          ...(typeof body.not_written_by === "string" && body.not_written_by ? { notWrittenBy: body.not_written_by } : {}),
          ...(typeof body.note_written_by === "string" && body.note_written_by ? { noteWrittenBy: body.note_written_by } : {}),
          ...(typeof body.not_note_written_by === "string" && body.not_note_written_by ? { notNoteWrittenBy: body.not_note_written_by } : {}),
          ...(truthyParam(String(body.include_distrusted ?? "")) ? { includeDistrusted: true } : {}),
        });
        audit({ op: "changes.ack", label: principal.label, kind: "changes", detail: `consumer=${r.consumer} seq=${r.seq}` });
        sendJson(res, 200, { acked: true, ...r });
        return true;
      }
      if (req.method === "POST" && path === "/tasks") {
        const body = await jsonBody();
        if (!body) return true;
        if (body.id !== undefined) {
          sendJson(res, 400, { error: "POST /tasks creates; update with PUT /tasks/:id" });
          return true;
        }
        const warnings: LintFinding[] = [];
        const wantApprove = body.approve === true;
        if (wantApprove && !scopeAllows(scope, "admin")) {
          sendJson(res, 403, { error: "approve:true needs an admin key; approve with POST /tasks/:id/approve (send the command_hash you read)" });
          return true;
        }
        if (wantApprove && !body.command) {
          sendJson(res, 400, { error: "approve:true only applies to a command task (pass `command` and `target`)" });
          return true;
        }
        const put = putTask(store, body as never, writeNs, warnings);
        await maybeEmbed(store, put.note);
        let task = put.task;
        if (wantApprove && !put.replayed) task = approveOrHold(store, task, writeNs, warnings);
        audit({ op: "task.put", id: task.id, namespace: task.namespace, label: principal.label, kind: task.command ? "command-task" : "task", detail: put.replayed ? "replay" : "create" });
        sendJson(res, put.replayed ? 200 : 201, {
          task,
          ...(put.replayed ? { replayed: true } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
        return true;
      }
      const tid = /^\/tasks\/(\d+)$/.exec(path);
      if (req.method === "PUT" && tid) {
        const body = await jsonBody();
        if (!body) return true;
        const warnings: LintFinding[] = [];
        try {
          if (body.approve !== undefined) {
            sendJson(res, 400, { error: "approve applies when creating; approve an existing task with POST /tasks/:id/approve (admin)" });
            return true;
          }
          const { task, note } = putTask(store, { ...(body as object), id: Number(tid[1]) } as never, writeNs, warnings);
          await maybeEmbed(store, note);
          audit({ op: "task.put", id: task.id, namespace: task.namespace, label: principal.label, kind: task.command ? "command-task" : "task", detail: "update" });
          sendJson(res, 200, warnings.length ? { task, warnings } : { task });
        } catch (e) {
          if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
          else if (e instanceof ClaimConflictError) sendJson(res, 409, { error: e.message, holder: e.holder, until: e.until });
          else if (e instanceof ValidationError && e.message.startsWith("stale write:")) sendJson(res, 409, { error: e.message });
          else throw e;
        }
        return true;
      }
      if (req.method === "POST" && path === "/handoffs") {
        const body = await jsonBody();
        if (!body) return true;
        const warnings: LintFinding[] = [];
        const w = writeHandoff(store, body as never, writeNs, warnings);
        await maybeEmbed(store, w.note);
        audit({ op: "handoff.write", id: w.handoff.id, namespace: w.handoff.namespace, label: principal.label, kind: "handoff", detail: w.replayed ? "replay" : "create" });
        sendJson(res, w.replayed ? 200 : 201, {
          handoff: w.handoff,
          ...(w.replayed ? { replayed: true } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
        return true;
      }
      if (req.method === "GET" && path === "/handoffs") {
        const namespaces = readNs();
        const handoffs = listHandoffs(store, {
          namespaces,
          surface: url.searchParams.get("surface") ?? undefined,
          limit: intParam(url, "limit", 1),
          ...writerFilter(url),
        });
        sendJson(res, 200, { handoffs, searchedNamespaces: namespaces ?? [] });
        return true;
      }
      if (req.method === "GET" && path === "/runner/status") {
        const namespaces = readNs();
        sendJson(res, 200, { ...runnerStatus(store, namespaces, undefined, { pinned: nsCtx.active }), searchedNamespaces: namespaces ?? [] });
        return true;
      }
      if (req.method === "GET" && path === "/catch-up") {
        const namespaces = readNs();
        const out = catchUp(store, {
          namespaces,
          consumer: url.searchParams.get("consumer") ?? undefined,
          changes: !["0", "false"].includes((url.searchParams.get("changes") ?? "").toLowerCase()),
          tasks: intParam(url, "tasks", 1),
          handoffs: intParam(url, "handoffs", 1),
          ackMode: ackModeParam(url),
          ackToken: url.searchParams.get("ack_token") ?? undefined,
          excludeSelf: flagParam(url, "exclude_self"),
          ...feedWriterFilter(url),
        });
        if (out.changes) {
          audit({
            op: "catch_up",
            label: principal.label,
            kind: "changes",
            detail: `consumer=${out.changes.consumer} total=${out.changes.counts.total}${out.changes.ack_token ? " manual-ack" : " marker-advanced"}${out.changes.acked ? " acked" : ""}`,
          });
        }
        sendJson(res, 200, { ...out, searchedNamespaces: namespaces ?? [] });
        return true;
      }
    } catch (e) {
      sendError(res, e);
      return true;
    }
  }
  return false;
}
