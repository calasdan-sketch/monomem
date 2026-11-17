// The apps `monomem setup` connects beyond the first eight (setup.ts detectClients has those). Each one was checked
// against the app's own current documentation on 2026-11-17 (file place, the key that holds the servers, the entry shape);
// docs/apps.md lists the sources and the apps left out because their file could not be verified.
//
// The same promises as every other target hold, because these go through setup.ts planFile: the change is shown first,
// nothing is written without a yes, the file is backed up and `monomem setup --undo` puts it back exactly, and the entry
// carries MONOMEM_CLIENT=<id> so its writes are stamped stdio:<id>.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerEntry, SetupEnv } from "../setup.js";

/** How an app writes one stdio server. "std": {command, args, env} (Claude Desktop / Cursor style). */
export type EntryShape = "std" | "copilot" | "opencode" | "kilo";

export interface ExtraTarget {
  id: (typeof EXTRA_CLIENT_IDS)[number];
  label: string;
  /** The user-level config file. */
  file: (e: SetupEnv) => string;
  /** A folder whose presence means the app is installed even when the file is not there yet. */
  dir?: (e: SetupEnv) => string;
  /** Where the servers live in the file (an object path). */
  key: readonly string[];
  shape: EntryShape;
}

export const EXTRA_CLIENT_IDS = ["windsurf", "devin", "kiro", "cline", "copilot-cli", "antigravity", "qwen", "opencode", "kilo"] as const;

const appData = (e: SetupEnv): string => e.env.APPDATA?.trim() || join(e.home, "AppData", "Roaming");
const xdgConfig = (e: SetupEnv): string => e.env.XDG_CONFIG_HOME?.trim() || join(e.home, ".config");
/** The first of these files that exists, else the first one (the one the app's docs show for a new file). */
const firstExisting = (...files: string[]): string => files.find((f) => existsSync(f)) ?? files[0];

export const EXTRA_TARGETS: readonly ExtraTarget[] = [
  // docs.devin.ai/cli/reference/configuration/read-config-from: Windsurf (stable channel) keeps its servers in
  // ~/.codeium/windsurf/mcp_config.json under "mcpServers".
  { id: "windsurf", label: "Windsurf", file: (e) => join(e.home, ".codeium", "windsurf", "mcp_config.json"), key: ["mcpServers"], shape: "std" },
  // docs.devin.ai/cli/extensibility/mcp/configuration: user servers in ~/.config/devin/mcp_config.json
  // (%APPDATA%\devin\mcp_config.json on Windows), "mcpServers" with command/args/env. Devin Desktop uses the same files.
  { id: "devin", label: "Devin (Desktop and CLI)", file: (e) => join(e.platform === "win32" ? appData(e) : xdgConfig(e), "devin", "mcp_config.json"), key: ["mcpServers"], shape: "std" },
  // kiro.dev/docs/mcp/configuration: user level ~/.kiro/settings/mcp.json, "mcpServers" with command/args/env.
  { id: "kiro", label: "Kiro", file: (e) => join(e.home, ".kiro", "settings", "mcp.json"), dir: (e) => join(e.home, ".kiro"), key: ["mcpServers"], shape: "std" },
  // docs.cline.bot/mcp: the CLI's file is ~/.cline/data/settings/cline_mcp_settings.json (CLINE_MCP_SETTINGS_PATH moves it).
  // The VS Code extension's file is only reachable from its panel (the docs give no path), so it is not written.
  {
    id: "cline",
    label: "Cline CLI",
    file: (e) => e.env.CLINE_MCP_SETTINGS_PATH?.trim() || join(e.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    dir: (e) => join(e.home, ".cline"),
    key: ["mcpServers"],
    shape: "std",
  },
  // docs.github.com .../copilot-cli/customize-copilot/add-mcp-servers: ~/.copilot/mcp-config.json, "mcpServers" with
  // {type: "local", command, args, env, tools: ["*"]}.
  { id: "copilot-cli", label: "GitHub Copilot CLI", file: (e) => join(e.home, ".copilot", "mcp-config.json"), key: ["mcpServers"], shape: "copilot" },
  // antigravity.google/docs/mcp: global ~/.gemini/config/mcp_config.json, "mcpServers" with command/args/env.
  { id: "antigravity", label: "Antigravity", file: (e) => join(e.home, ".gemini", "config", "mcp_config.json"), key: ["mcpServers"], shape: "std" },
  // qwenlm.github.io/qwen-code-docs .../features/mcp: user scope ~/.qwen/settings.json, "mcpServers" with command/args/env.
  { id: "qwen", label: "Qwen Code", file: (e) => join(e.home, ".qwen", "settings.json"), key: ["mcpServers"], shape: "std" },
  // opencode.ai/docs/config and /docs/mcp-servers: ~/.config/opencode/opencode.json(c); V2 servers live under
  // "mcp" -> "servers" as {type: "local", command: [exe, ...args], environment}.
  {
    id: "opencode",
    label: "OpenCode",
    file: (e) => firstExisting(join(xdgConfig(e), "opencode", "opencode.json"), join(xdgConfig(e), "opencode", "opencode.jsonc")),
    key: ["mcp", "servers"],
    shape: "opencode",
  },
  // kilo.ai/docs/automate/mcp/using-in-kilo-code: ~/.config/kilo/kilo.jsonc (or kilo.json), servers directly under "mcp"
  // as {type: "local", command: [exe, ...args], environment, enabled: true}. The VS Code extension uses the same file.
  {
    id: "kilo",
    label: "Kilo Code",
    file: (e) => firstExisting(join(xdgConfig(e), "kilo", "kilo.jsonc"), join(xdgConfig(e), "kilo", "kilo.json")),
    key: ["mcp"],
    shape: "kilo",
  },
];

export const extraTarget = (id: string): ExtraTarget | undefined => EXTRA_TARGETS.find((t) => t.id === id);

export function extraFound(e: SetupEnv, t: ExtraTarget): { file: string; exists: boolean; present: boolean } {
  const file = t.file(e);
  const exists = existsSync(file);
  return { file, exists, present: exists || existsSync(t.dir ? t.dir(e) : dirname(file)) };
}

/** The entry setup writes, in the app's own shape. */
export function shapeEntry(shape: EntryShape, entry: ServerEntry): Record<string, unknown> {
  if (shape === "std") return entry;
  if (shape === "copilot") return { type: "local", ...entry, tools: ["*"] };
  const { command, args, env, type: _type, ...rest } = entry;
  void _type;
  const out: Record<string, unknown> = { type: "local", command: [command, ...args], ...(env && Object.keys(env).length ? { environment: env } : {}), ...rest };
  return shape === "kilo" ? { ...out, enabled: true } : out;
}

/** An app's entry read back as {command, args, env}, so the stale / outdated checks work on every shape. */
export function stdView(entry: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(entry.command)) return entry;
  const [command, ...args] = entry.command.map(String);
  return { command: command ?? "", args, ...(entry.environment && typeof entry.environment === "object" ? { env: entry.environment } : {}) };
}
