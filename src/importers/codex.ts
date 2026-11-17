// `monomem import --from codex`: the local memories Codex CLI and the ChatGPT desktop app write (layout as documented at
// https://learn.chatgpt.com/docs/customization/memories and in openai/codex codex-rs/memories/README.md):
//   $CODEX_HOME/memories/ and $CODEX_HOME/memories_v2/   (CODEX_HOME defaults to ~/.codex)
//     MEMORY.md          the consolidated handbook ("# Task Group: ...", "## User preferences", ...)
//     memory_summary.md  the short summary injected at session start (its first line is the version marker "v1")
// Only these two files are read, cut at level 1 and 2 headings like CLAUDE.md. raw_memories.md, rollout_summaries/ and
// skills/ are Codex's own working material (generated from the same chats) and are left out. Codex memories are off by
// default: with the feature never switched on, none of these files exist and there is nothing to import.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitSections } from "../claude-import.js";
import type { Item } from "../foreign-import.js";

export const CODEX_DIRS = ["memories", "memories_v2"];
export const CODEX_FILES = ["MEMORY.md", "memory_summary.md"];
const h = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const codexHome = (e: { home: string; env: NodeJS.ProcessEnv }): string => e.env.CODEX_HOME || join(e.home, ".codex");

/** The memory files under a Codex home (or a memories folder given directly). Links are not followed. */
export function findCodexMemoryFiles(root: string, maxFile: number): string[] {
  const out: string[] = [];
  for (const dir of ["", ...CODEX_DIRS]) {
    for (const f of CODEX_FILES) {
      const p = join(root, dir, f);
      try {
        const st = lstatSync(p);
        if (st.isFile() && st.size > 0 && st.size <= maxFile) out.push(p);
      } catch {
        /* not there */
      }
    }
  }
  return out;
}

export function readCodexMemories(root: string, maxFile: number): Item[] {
  const files = findCodexMemoryFiles(root, maxFile);
  if (!files.length) throw new Error(`no Codex memory files here (looked for ${CODEX_DIRS.map((d) => `${d}/MEMORY.md`).join(" and ")}, and memory_summary.md). Codex writes them only after its memories feature is switched on`);
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const p of files) {
    const file = p.endsWith("memory_summary.md") ? "memory_summary.md" : "MEMORY.md";
    const text = readFileSync(p, "utf8").replace(/^\uFEFF?v1[ \t]*\r?\n/, "");
    for (const s of splitSections(text, file === "MEMORY.md" ? "Codex memory" : "Codex memory summary").sections) {
      // The same section in memories/ and memories_v2/ (Codex writes both during its migration) is one note.
      const id = `${file}:${h(`${s.path}\u0000${s.occurrence}`)}:${h(s.body)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, group: file, title: s.path, body: s.body, tags: [`codex-file:${file}`] });
    }
  }
  return items;
}
