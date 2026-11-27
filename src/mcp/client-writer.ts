// When MONOMEM_CLIENT is not set, the stdio writer name comes from the MCP initialize handshake (clientInfo.name), so ten apps
// do not all share one writer "stdio" (one flood-guard budget, one provenance label). Like MONOMEM_CLIENT it is a CLAIM by
// the connecting program, not an identity: it tells apps apart. "stdio" still means every stdio:<app> for distrust rules.
import { setProcessWriter } from "../actor.js";

/** "Claude Code" -> "stdio:claude-code"; null when nothing usable is left (the writer stays plain "stdio"). */
export function writerFromClientName(name: unknown, env: NodeJS.ProcessEnv = process.env): `stdio:${string}` | null {
  if ((env.MONOMEM_CLIENT ?? "").trim() !== "") return null; // the operator set one (valid, or invalid and warned about): theirs wins
  if (typeof name !== "string") return null;
  const label = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[-._]+$/g, "").slice(0, 40).replace(/[-._]+$/, "");
  return label ? `stdio:${label}` : null;
}

/** Adopt the writer name for this process from the client's declared name. Returns the writer now in force. */
export function adoptClientWriter<W extends string>(name: unknown, current: W, env: NodeJS.ProcessEnv = process.env): W | `stdio:${string}` {
  // Once only (security review F1): a client that re-sends `initialized` must not change its name mid-session to reset its flood budget
  // or take another app's name. Only the plain launch name "stdio" is replaced.
  if (current !== "stdio") return current;
  const w = writerFromClientName(name, env);
  if (!w) return current;
  setProcessWriter(w);
  return w;
}
