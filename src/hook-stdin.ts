// The hook processes' stdin reader and payload parser, in a module with no imports, so the PreToolUse action guard can
// read its payload without loading hook.ts (capture, crypto) on every tool call. hook.ts re-exports both.
/** stdin is read up to this much; the rest is ignored (a hook payload past 1 MiB is a tool output we only keep 4 KB of). */
export const STDIN_MAX = 1024 * 1024;
/** Give up on a stdin that never closes (a hook started by hand in a terminal) after this long. */
const STDIN_WAIT_MS = 2000;

export async function readStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, max = STDIN_MAX): Promise<string> {
  if (stream.isTTY) return "";
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners?.("data");
      resolve(Buffer.concat(chunks).toString("utf8"));
      (stream as { pause?: () => void }).pause?.();
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      if (size < max) chunks.push(b.subarray(0, max - size));
      size += b.length;
      if (size >= max) finish();
    });
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

export function parsePayload(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

