/** `monomem encrypt enable|disable` rewrite every note on disk, so an unknown option (a typo, or a `--dry-run` that does not exist) must stop the command. Returns the refusal text, or null. */
export function unknownEncryptArgs(action: string, extra: string[]): string | null {
  const allowed = action === "status" ? ["--surfaces", "--json"] : ["--yes"];
  const unknown = extra.filter((a) => !allowed.includes(a));
  if (!unknown.length) return null;
  const hint = action === "status" ? "" : " There is no --dry-run; use `monomem encrypt status` to look first.";
  return `monomem encrypt ${action}: unknown option ${unknown.map((u) => JSON.stringify(u)).join(", ")}. Nothing was changed.${hint}`;
}
