// `monomem import --auto <path>`: find out what the file is by reading it (never by its name), show what would come in, and
// write only with --yes. Everything after detection is the ordinary `import --from <tool>` path.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SetupEnv, SetupIO } from "../setup.js";
import { runForeignImport, type ForeignSource } from "../foreign-import.js";
import { sniffFile } from "../importers/rivals.js";
import { findCodexMemoryFiles } from "../importers/codex.js";
import { MAX_FILE_BYTES } from "../claude-import.js";

export interface AutoOptions {
  path?: string;
  yes: boolean;
  namespace?: string;
  dbPath: string;
}

const FORMATS = "Engram (.db or export JSON), agentmemory (export JSON), ai-memory (export JSON), mem0 (JSON), the MCP memory server (memory.jsonl), claude-mem (.db), basic-memory (folder), Codex memories (folder), Notion (.zip or folder)";

/** What a path is. Folders and zips are told apart by their contents; files by sniffing. */
export function detect(path: string): { from: ForeignSource; why: string } | null {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error("it is a link; give the real path");
  if (st.isFile()) {
    if (/\.zip$/i.test(path)) return { from: "notion", why: "a .zip (Notion export)" };
    return sniffFile(path);
  }
  if (!st.isDirectory()) return null;
  if (findCodexMemoryFiles(path, MAX_FILE_BYTES).length) return { from: "codex", why: "a folder with Codex MEMORY.md / memory_summary.md" };
  const names = readdirSync(path);
  if (names.some((n) => /[0-9a-f]{32}\.(md|csv)$/i.test(n))) return { from: "notion", why: "a folder of Notion-style page names" };
  if (names.some((n) => n.endsWith(".md"))) return { from: "basic-memory", why: "a folder of Markdown notes" };
  const sub = names.find((n) => lstatSync(join(path, n)).isDirectory());
  return sub && readdirSync(join(path, sub)).some((n) => n.endsWith(".md")) ? { from: "basic-memory", why: "a folder tree of Markdown notes" } : null;
}

export async function runAutoImport(e: Pick<SetupEnv, "home" | "env" | "cwd">, io: SetupIO, opts: AutoOptions): Promise<number> {
  if (!opts.path) {
    io.err("Name the file or folder to bring in: monomem import --auto <path> [--yes]");
    return 1;
  }
  const path = resolve(e.cwd, opts.path);
  if (!existsSync(path)) {
    io.err(`I found nothing at ${path}. Check the path.`);
    return 1;
  }
  let found: ReturnType<typeof detect>;
  try {
    found = detect(path);
  } catch (err) {
    io.err(`Could not read ${path}: ${(err as Error).message}`);
    return 1;
  }
  if (!found) {
    io.err(`I could not tell what ${path} is. Formats I know: ${FORMATS}.\nIf you know the tool, name it: monomem import --from <tool> --path <path>`);
    return 1;
  }
  io.out(`Detected ${found.from}: ${found.why}.`);
  const code = await runForeignImport(e, io, { from: found.from, path, dryRun: !opts.yes, yes: opts.yes, namespace: opts.namespace, dbPath: opts.dbPath, preview: true });
  if (code === 0 && !opts.yes) io.out(`Nothing was written. To bring these in: monomem import --auto ${opts.path} --yes`);
  return code;
}
