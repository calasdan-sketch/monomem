// The opt-in switches of the prompt-time features, in a module with only node:fs and node:path imports, so setup and the
// hooks can read them without loading the store or config.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** MONOMEM_SUBAGENT_MEMORY: "on" turns the SubagentStart pack and the SubagentStop note on. Default off. */
export function subagentMemoryOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true|yes)$/i.test((env.MONOMEM_SUBAGENT_MEMORY ?? "").trim());
}

/**
 * One switch from the dashboard's <data dir>/ui-settings.json (ui/settings.ts writes it): "on", "off", or undefined when
 * the file is missing, unreadable, hand-broken or does not say, so the caller's default applies.
 */
export function uiSwitch(dataDir: string, key: "prompt_recall" | "daily_backups" | "claude_refresh"): "on" | "off" | undefined {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, "ui-settings.json"), "utf8")) as Record<string, unknown> | null;
    const x = v && typeof v === "object" ? v[key] : undefined;
    return x === "on" || x === "off" ? x : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prompt-time recall (steps 2-4 of prompt/step.ts). MONOMEM_PROMPT_RECALL wins when it is set ("on" turns it on, any
 * other value off); unset, the dashboard's Settings switch decides (dataDir given). Default off.
 */
export function promptRecallOn(env: NodeJS.ProcessEnv = process.env, dataDir?: string): boolean {
  const v = (env.MONOMEM_PROMPT_RECALL ?? "").trim();
  if (v) return /^(on|1|true|yes)$/i.test(v);
  return dataDir ? uiSwitch(dataDir, "prompt_recall") === "on" : false;
}
