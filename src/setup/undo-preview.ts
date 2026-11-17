// `monomem setup --undo --dry-run`: say what --undo would put back, and change nothing (ease N9: it used to undo).
import { readHistory, type SetupEnv, type SetupIO } from "../setup.js";

export function undoPreview(e: SetupEnv, io: SetupIO): number {
  const all = readHistory(e);
  const s = [...all].reverse().find((x) => !x.undone);
  if (!s) {
    io.out("Nothing to undo: setup has not changed any file on this computer (or it was already undone).");
    return 0;
  }
  io.out(`Dry run: nothing was changed. monomem setup --undo would undo the setup from ${s.at}:`);
  if (s.path) io.out(`  ${s.path.where}: take out ${s.path.dir}`);
  for (const c of [...s.changes].reverse()) io.out(`  ${c.file}: ${c.createdFile ? "remove (setup had created it)" : "put back as it was before setup"}`);
  return 0;
}
