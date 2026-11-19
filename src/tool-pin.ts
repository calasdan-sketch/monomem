// Tool description pinning. An MCP server tells the agent what each tool is called and what it does; if those words change
// without you knowing (a "rug pull"), an agent can be steered. `monomem tools --verify` records a hash of the tool names,
// descriptions and input schemas this build serves, in <data folder>/tool-pin.json, and says so in plain words when they
// later differ. A change after you upgraded Monomem is expected; a change at the same version is not.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ToolPin {
  version: string;
  recorded_at: string;
  overall: string;
  tools: Record<string, string>;
}
export interface PinVerdict {
  status: "recorded" | "unchanged" | "changed-after-upgrade" | "changed-same-version" | "unreadable";
  added: string[];
  removed: string[];
  changed: string[];
  message: string;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** JSON with sorted keys, so the same schema always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export function hashTools(tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>, version: string, now = new Date()): ToolPin {
  const per: Record<string, string> = {};
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) per[t.name] = sha(stable({ n: t.name, d: t.description ?? "", s: t.inputSchema ?? null }));
  return { version, recorded_at: now.toISOString(), overall: sha(stable(per)), tools: per };
}

/** The tools this build serves to an admin (the full set), listed through an in-process client. */
export async function servedTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Store } = await import("./store.js");
  const { createMcpServer } = await import("./mcp-server-core.js");
  const store = new Store(":memory:");
  const server = createMcpServer(store, "admin");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "monomem-tool-pin", version: "1.0.0" });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    return (await client.listTools()).tools as Array<{ name: string; description?: string; inputSchema?: unknown }>;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    store.close();
  }
}

export const pinPath = (dataDir: string): string => join(dataDir, "tool-pin.json");

export function readPin(path: string): ToolPin | null {
  try {
    if (!existsSync(path)) return null;
    const p = JSON.parse(readFileSync(path, "utf8")) as ToolPin;
    return p && typeof p.overall === "string" && p.tools && typeof p.tools === "object" ? p : null;
  } catch {
    return null;
  }
}

export function writePin(path: string, pin: ToolPin): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(pin, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

const list = (a: string[]): string => a.join(", ");

/** Compare the served tools with the stored pin (null: nothing recorded yet). Pure: writes nothing. */
export function comparePin(stored: ToolPin | null, now: ToolPin, unreadable = false): PinVerdict {
  const none = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  if (unreadable) return { status: "unreadable", ...none, message: "The saved tool record could not be read. Run `monomem tools --verify --accept` to record the current tools again." };
  if (!stored) return { status: "recorded", ...none, message: `No tool record yet. This is the first check, so the ${Object.keys(now.tools).length} tools now served were recorded as the baseline.` };
  if (stored.overall === now.overall) return { status: "unchanged", ...none, message: `The ${Object.keys(now.tools).length} tool names, descriptions and inputs are the same as when they were recorded (${stored.recorded_at.slice(0, 10)}, version ${stored.version}).` };
  const added = Object.keys(now.tools).filter((k) => !(k in stored.tools)).sort();
  const removed = Object.keys(stored.tools).filter((k) => !(k in now.tools)).sort();
  const changed = Object.keys(now.tools).filter((k) => k in stored.tools && stored.tools[k] !== now.tools[k]).sort();
  const parts = [added.length ? `new: ${list(added)}` : "", removed.length ? `gone: ${list(removed)}` : "", changed.length ? `reworded or changed inputs: ${list(changed)}` : ""].filter(Boolean).join("; ");
  if (stored.version !== now.version)
    return { status: "changed-after-upgrade", added, removed, changed, message: `The tools changed since version ${stored.version} (now ${now.version}): ${parts}. That is normal after an upgrade. Read the release notes, then run \`monomem tools --verify --accept\` to record the new set.` };
  return { status: "changed-same-version", added, removed, changed, message: `The tools changed but the version is still ${now.version}: ${parts}. Nothing in an upgrade explains this, and it is what a swapped tool description looks like. Check the install (\`monomem doctor\`), and do not accept it until you know why.` };
}
