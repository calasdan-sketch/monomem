// Plain words for the file-system errors that reach the top of the CLI (a path that is a file, a folder that is not there, no permission),
// instead of Node's "EEXIST: file already exists, mkdir ..." text. Anything else keeps its own message.

const HINTS: Record<string, [string, string]> = {
  EEXIST: ["a file is in the way: that path exists and is not a folder", "pick a path that does not exist yet, or a folder"],
  ENOTDIR: ["part of that path is a file, not a folder", "check the path"],
  ENOENT: ["that file or folder does not exist (or its parent folder does not)", "check the spelling; create the parent folder first"],
  EISDIR: ["that path is a folder, and a file was expected", "name a file"],
  EACCES: ["no permission for that path", "pick a folder you can write to"],
  EPERM: ["no permission for that path", "pick a folder you can write to"],
  EROFS: ["that location is read-only", "pick a folder you can write to"],
};

/** [message, fix?] for errorLine(): the system's own words are kept after a plain-language lead. */
export function describeFsError(e: unknown, msg: string): [string, string?] {
  const code = (e as { code?: unknown } | null)?.code;
  const hint = typeof code === "string" ? HINTS[code] : undefined;
  return hint ? [`${hint[0]} (${msg})`, hint[1]] : [msg];
}
