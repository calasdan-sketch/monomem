// `monomem import --from notion --path <export.zip | folder>`: a Notion "Markdown & CSV" export (Settings, Export all
// workspace content, or a page's "..." menu, Export). One page = one note (cut into parts when it is over the note size
// limit). Notion names each file "<Page title> <32-hex id>.md" inside folders named after the parent pages; the id is
// dropped from the title and the folder path becomes the row label. Database tables (.csv) are not read: their rows are also
// exported as pages. The zip is read in memory (importers/zip.ts); a folder is walked without following links.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Item } from "../foreign-import.js";
import { MAX_ZIP_BYTES, readZipMarkdown, type ZipStats } from "./zip.js";

const MAX_MD_FILES = 100_000;
const NOTION_ID = /\s+[0-9a-f]{32}$/i;
const h = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const stripNotionId = (s: string): string => s.replace(NOTION_ID, "").trim();

/** The .md files of an unzipped export: path relative to the folder, and text. */
function readFolder(root: string, maxFile: number, stats: ZipStats): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || out.length >= MAX_MD_FILES) continue;
      const p = join(dir, name);
      const st = lstatSync(p); // links are not followed: the folder is read as it is
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && /\.md$/i.test(name)) {
        if (st.size > maxFile) stats.skipped++;
        else out.push({ name: relative(root, p), text: readFileSync(p, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

export function readNotion(path: string, maxFile: number, stats: ZipStats = { skipped: 0 }): Item[] {
  const st = statSync(path);
  let files: Array<{ name: string; text: string }>;
  if (st.isDirectory()) files = readFolder(path, maxFile, stats);
  else {
    if (st.size > MAX_ZIP_BYTES) throw new Error(`larger than ${MAX_ZIP_BYTES / 1024 / 1024} MiB: unzip it and point --path at the folder`);
    files = readZipMarkdown(readFileSync(path), maxFile, stats);
  }
  const items: Item[] = [];
  for (const f of files) {
    const rel = f.name.split("\\").join("/").replace(/^\/+/, "");
    const parts = rel.replace(/\.md$/i, "").split("/").map(stripNotionId);
    const text = f.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const m = /^#[ \t]+(.+)\n?/.exec(text);
    const body = (m ? text.slice(m[0].length) : text).trim();
    if (!body) continue;
    const title = (m?.[1]?.trim() || parts[parts.length - 1] || "Untitled").slice(0, 200);
    const folder = parts.slice(0, -1).join(" / ") || "(top)";
    // The text's hash is part of the id: a page edited in Notion and exported again comes in as a new note; the old one stays.
    items.push({ id: `${h(rel)}:${h(body)}`, group: folder, title, body, tags: [] });
  }
  return items;
}
