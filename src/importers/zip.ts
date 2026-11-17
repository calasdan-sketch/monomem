// Reads the Markdown files out of a .zip in memory (a Notion export), with node:zlib only. Nothing is written to disk, so a
// name like "../../x.md" is just a label. Stored and deflated entries are read; ZIP64, encrypted entries and anything over
// the limits are skipped or refused with a plain message. A zip inside the zip (Notion splits big exports into
// "Part-1.zip", "Part-2.zip") is opened one level deep.
import { inflateRawSync } from "node:zlib";

export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
/** All entries together, uncompressed: a small zip cannot expand into gigabytes. */
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

export interface ZipText {
  name: string;
  text: string;
}

export interface ZipStats {
  /** .md entries over the size limit, encrypted, or in an unknown compression. */
  skipped: number;
}

function eocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

/** The .md entries of `buf` (and of the zips inside it, one level), each at most `maxFile` bytes uncompressed. */
export function readZipMarkdown(buf: Buffer, maxFile: number, stats: ZipStats = { skipped: 0 }, depth = 0, budget = { left: MAX_TOTAL_BYTES }): ZipText[] {
  const end = eocd(buf);
  if (end < 0) throw new Error("not a zip file (or a damaged one)");
  const count = buf.readUInt16LE(end + 10);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("this zip uses ZIP64, which is not read here: unzip it and point --path at the folder");
  const out: ZipText[] = [];
  let p = cdOffset;
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("the zip's table of contents is damaged");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    p = next;
    const isMd = /\.md$/i.test(name);
    const isZip = depth === 0 && /\.zip$/i.test(name);
    if (!isMd && !isZip) continue;
    const limit = isMd ? maxFile : MAX_ZIP_BYTES;
    if (flags & 1 || (method !== 0 && method !== 8) || size > limit || size > budget.left || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
      if (isMd) stats.skipped++;
      continue;
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    try {
      data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: limit });
    } catch {
      if (isMd) stats.skipped++;
      continue;
    }
    budget.left -= data.length;
    if (isZip) out.push(...readZipMarkdown(data, maxFile, stats, depth + 1, budget));
    else out.push({ name, text: data.toString("utf8") });
  }
  return out;
}
