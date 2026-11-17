// `monomem rollback --note <id> [--include-likely] [--include-conflicts] [--yes] [--json]`: undo one bad note and what was
// built on it (rollback-note.ts). Same flow as the writer rollback: print the plan, ask, then apply it in one transaction.
import { QuarantinedError, ValidationError, type Store } from "../store.js";
import type { Caller } from "../supersede.js";
import { embedRestored } from "../rollback.js";
import { noteRollbackPreview, noteRollbackConfirm } from "../rollback-note.js";
import type { CliIO } from "../supersede-cli.js";

export async function noteRollbackCli(store: Store, flags: Record<string, string | true>, io: CliIO, caller: Caller): Promise<number> {
  try {
    if (flags.writer !== undefined || flags.since !== undefined) {
      io.err("Error: --note cannot be combined with --writer or --since: roll back by note, or by writer, not both.");
      return 1;
    }
    const json = flags.json === true;
    const dryRun = flags["dry-run"] === true;
    const how = dryRun ? "Dry run: nothing was changed." : flags.yes === true || io.interactive ? "" : "Nothing was changed. Run it again at a terminal, or add --yes, to go ahead.";
    const preview = noteRollbackPreview(
      store,
      caller,
      { note: flags.note, include_likely: flags["include-likely"] === true, include_conflicts: flags["include-conflicts"] === true },
      how
    );
    io.out(json ? JSON.stringify(preview, null, 2) : preview.warning);
    if (preview.actions.length === 0 || dryRun) return 0;
    if (flags.yes !== true) {
      if (!io.interactive) return 2;
      const a = await io.ask(`\nRoll back note ${preview.note} and ${preview.actions.length - 1 > 0 ? "what was built on it" : "nothing else"}? Type yes: `);
      if (a.trim().toLowerCase() !== "yes") {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
    }
    const out = noteRollbackConfirm(store, caller, { token: preview.token });
    await embedRestored(store, out);
    io.out(json ? JSON.stringify(out, null, 2) : out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`A restored text was held for review (held write #${e.quarantineId}); nothing was rolled back.`);
      return 1;
    }
    if (e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
