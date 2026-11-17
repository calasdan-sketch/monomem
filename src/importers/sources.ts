// What other memory tools left on this computer, for the dashboard's Welcome "Bring in memories" list. Only looks (file
// checks); nothing is read into Monomem until the person presses Bring in, which runs the ordinary import command.
import { existsSync } from "node:fs";
import type { SetupEnv } from "../setup.js";
import { MAX_FILE_BYTES } from "../claude-import.js";
import { bridgeStatus } from "../claude-refresh.js";
import { defaultPath } from "../foreign-import.js";
import { codexHome, findCodexMemoryFiles } from "./codex.js";

export interface FoundSource {
  id: "claude" | "claude-mem" | "basic-memory" | "mcp-memory" | "codex";
  label: string;
  where: string;
}

export const SOURCE_IDS: ReadonlyArray<FoundSource["id"]> = ["claude", "claude-mem", "basic-memory", "mcp-memory", "codex"];

/** The import command for a found source (the dashboard runs it with --yes after the person said yes). */
export function importArgs(id: FoundSource["id"]): string[] {
  return id === "claude" ? ["import", "--claude", "--no-project", "--yes"] : ["import", "--from", id, "--yes"];
}

export async function findSources(e: Pick<SetupEnv, "home" | "env" | "cwd">, dbPath: string): Promise<FoundSource[]> {
  const out: FoundSource[] = [];
  const claude = await bridgeStatus(e, dbPath, true);
  if (claude.files) out.push({ id: "claude", label: "Claude Code's own memory", where: `${claude.files} file(s) (CLAUDE.md and auto memory)${claude.last_import ? `, ${claude.changed} changed since the last import` : ""}` });
  for (const [id, label] of [["claude-mem", "claude-mem"], ["basic-memory", "basic-memory"], ["mcp-memory", "The MCP memory server"]] as const) {
    const p = defaultPath(id, e);
    if (p && existsSync(p)) out.push({ id, label, where: p });
  }
  const codex = findCodexMemoryFiles(codexHome(e), MAX_FILE_BYTES);
  if (codex.length) out.push({ id: "codex", label: "Codex memories", where: codexHome(e) });
  return out;
}
