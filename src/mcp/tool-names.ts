// Which MCP tools a server registers. A file of its own with no imports, so the prompt hook (context-inject.ts) can
// read the tool names without loading the MCP SDK.

/**
 * The tools an assistant needs for memory to work: save, find, read, list,
 * forget, the session catch-up, and the two-step replace that lets an agent
 * correct a memory without silently overwriting one.
 *
 * state_relevant left the default set: state_search mode "relevant" does
 * the same thing, so the separate tool only cost context. It is still
 * registered for MONOMEM_TOOLS=all or an explicit list (old prompts keep working).
 *
 * Everything else -- history and version restore, consolidation, edge rebuild,
 * quarantine, trust policy, stats, timelines, the command-task queue and the
 * runner status -- is operator tooling. It stays available behind
 * MONOMEM_TOOLS but is not worth the context it costs on every single turn
 * of every session.
 */

export const DEFAULT_TOOLS: readonly string[] = [
  "state_write",
  "state_read",
  "state_search",
  "state_list",
  "state_delete",
  "catch_up",
  "memory_supersede_preview",
  "memory_supersede_confirm",
  // The undo belongs with the confirm. Without it, a default install performs
  // the destructive half of supersede while both the pre-confirm warning and
  // the confirm response tell the user it can be undone -- by a tool the agent
  // was never given. Same mistake already caught for memory_quarantine above.
  "memory_supersede_undo",
];

/**
 * Which tools to register. `null` means every tool (no filtering).
 *
 * MONOMEM_TOOLS: unset or "core" -> DEFAULT_TOOLS; "all" -> everything;
 * otherwise a comma-separated list, added to the core set so a typo cannot
 * leave a server with no way to read or write memory.
 */
export function enabledToolNames(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = (env.MONOMEM_TOOLS ?? "").trim().toLowerCase();
  if (raw === "all") return null;
  if (!raw || raw === "core" || raw === "default") return new Set(DEFAULT_TOOLS);
  const extra = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_TOOLS, ...extra]);
}
