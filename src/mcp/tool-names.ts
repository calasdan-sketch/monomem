// Which MCP tools a server shows and which it answers. A file of its own with no imports, so the prompt hook
// (context-inject.ts) can read the tool names without loading the MCP SDK.
//
// 1.6: the 37 tools of 1.5 (state_*, memory_*, task_*, catch_up, ...) became 16 `memory_*` tools, 7 of them shown by
// default. Every 1.5 name still answers for one release, as a hidden alias with its old arguments and its old result
// shape. MONOMEM_TOOLS=legacy-1.5 shows the 1.5 list again, byte for byte.

/** The 1.5 default list, in its 1.5 order: what MONOMEM_TOOLS=legacy-1.5 shows. */
export const LEGACY_DEFAULT_TOOLS: readonly string[] = [
  "state_write",
  "state_read",
  "state_search",
  "state_list",
  "state_delete",
  "catch_up",
  "memory_supersede_preview",
  "memory_supersede_confirm",
  "memory_supersede_undo",
];

/** Every tool, in tools/list order. The first DEFAULT_COUNT are the default set. */
export const NEW_TOOLS: readonly string[] = [
  "memory_save",
  "memory_search",
  "memory_read",
  "memory_list",
  "memory_archive",
  "memory_replace",
  "memory_catch_up",
  "memory_review",
  "memory_history",
  "memory_rollback",
  "memory_tidy",
  "memory_held",
  "memory_usage",
  "memory_sessions",
  "memory_tasks",
  "memory_trust",
];

/**
 * The tools an assistant needs for memory to work: save, search, read, list, archive, replace (preview, confirm and
 * undo in one tool, so the undo is never missing) and the session catch-up. Everything else (history, tidy, held
 * writes, trust, usage, sessions, the command-task queue) is operator tooling behind MONOMEM_TOOLS: every tool's
 * schema is sent to the model on every turn.
 */
export const DEFAULT_TOOLS: readonly string[] = NEW_TOOLS.slice(0, 7);

/** 1.5 name -> the 1.6 tool that answers for it. memory_history and memory_rollback keep their names. */
export const OLD_TOOL_ALIASES: Readonly<Record<string, string>> = {
  state_write: "memory_save",
  state_read: "memory_read",
  memory_get: "memory_read",
  state_search: "memory_search",
  state_relevant: "memory_search",
  state_list: "memory_list",
  state_delete: "memory_archive",
  memory_supersede_preview: "memory_replace",
  memory_supersede_confirm: "memory_replace",
  memory_supersede_undo: "memory_replace",
  catch_up: "memory_catch_up",
  memory_since: "memory_catch_up",
  memory_ack: "memory_catch_up",
  memory_confirm: "memory_review",
  memory_flag: "memory_review",
  memory_history: "memory_history",
  memory_restore_version: "memory_history",
  memory_history_purge: "memory_history",
  memory_rollback: "memory_rollback",
  memory_consolidation_candidates: "memory_tidy",
  memory_consolidate: "memory_tidy",
  memory_rebuild_edges: "memory_tidy",
  memory_quarantine: "memory_held",
  memory_stats: "memory_usage",
  memory_receipt: "memory_usage",
  memory_why: "memory_usage",
  session_list: "memory_sessions",
  session_handoff: "memory_sessions",
  memory_index: "memory_sessions",
  memory_timeline: "memory_sessions",
  task_put: "memory_tasks",
  task_get: "memory_tasks",
  task_claim: "memory_tasks",
  task_approve: "memory_tasks",
  task_list: "memory_tasks",
  runner_status: "memory_tasks",
  trust_policy: "memory_trust",
};

export interface ToolProfile {
  /** MONOMEM_TOOLS=legacy-1.5: show the 1.5 names. */
  legacy: boolean;
  /** Names shown in tools/list (1.6 names, or 1.5 names when legacy); null = every tool. */
  visible: Set<string> | null;
}

/**
 * MONOMEM_TOOLS: unset, "core" or "default" -> DEFAULT_TOOLS; "all" -> every tool; otherwise a comma-separated list
 * added to the default set (so a typo cannot leave a server that cannot save or search). A 1.5 name in the list turns
 * on the 1.6 tool that answers for it. "legacy-1.5" (alone, or first in a list of 1.5 names, or "legacy-1.5,all")
 * shows the 1.5 tools instead.
 */
export function toolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = (env.MONOMEM_TOOLS ?? "").trim().toLowerCase();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.includes("legacy-1.5")) {
    const rest = parts.filter((p) => p !== "legacy-1.5");
    if (rest.includes("all")) return { legacy: true, visible: null };
    return { legacy: true, visible: new Set([...LEGACY_DEFAULT_TOOLS, ...rest]) };
  }
  if (raw === "all") return { legacy: false, visible: null };
  if (!raw || raw === "core" || raw === "default") return { legacy: false, visible: new Set(DEFAULT_TOOLS) };
  return { legacy: false, visible: new Set([...DEFAULT_TOOLS, ...parts.map(newName)]) };
}

/** The 1.6 tool that answers for a name (a 1.6 name maps to itself). */
export function newName(name: string): string {
  return Object.hasOwn(OLD_TOOL_ALIASES, name) ? OLD_TOOL_ALIASES[name] : name;
}

/** The names a server shows (null = all). Kept for callers that only ask "is this tool on". */
export function enabledToolNames(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  return toolProfile(env).visible;
}
