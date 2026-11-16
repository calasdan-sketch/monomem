// The opt-in switches of the prompt-time features, in a module with no imports, so setup can read them without loading the store.

/** MONOMEM_SUBAGENT_MEMORY: "on" turns the SubagentStart pack and the SubagentStop note on. Default off. */
export function subagentMemoryOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true|yes)$/i.test((env.MONOMEM_SUBAGENT_MEMORY ?? "").trim());
}
