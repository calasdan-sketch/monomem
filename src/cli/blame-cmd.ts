// `monomem blame "<claim>"` and `monomem ask "<question>"`: the owner's view (the shell owns the database file). Logic is in blame.ts.
import { parseFlags } from "./shared.js";

const OWNER = { includeSuperseded: true, includeDistrusted: true, showHeld: true } as const;

export async function blameCmd(cmd: "blame" | "ask", args: string[]): Promise<void> {
  const ask = cmd === "ask";
  const usage = ask ? 'Usage: monomem ask "<question>" [--since 7d|<date>] [--writer <label>] [--limit N] [--json]' : 'Usage: monomem blame "<claim or topic>" [--limit N] [--json]';
  const { flags, rest } = parseFlags(args, { values: ask ? ["since", "writer", "limit"] : ["limit"], bools: ["json"] });
  const query = rest.join(" ").trim();
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
  if (!query || (limit !== undefined && !Number.isInteger(limit))) {
    console.error(usage);
    process.exit(1);
  }
  let since: string | undefined;
  if (typeof flags.since === "string") {
    since = (await import("../blame.js")).sinceIso(flags.since) ?? undefined;
    if (!since) {
      console.error(`--since must be a window like 7d or 24h, or a date. ${usage}`);
      process.exit(1);
    }
  }
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const m = await import("../blame.js");
  const store = new Store(DB_PATH);
  try {
    const out = ask
      ? await m.askTimeline(store, query, OWNER, { since, writer: typeof flags.writer === "string" ? flags.writer : undefined, limit })
      : await m.blame(store, query, OWNER, limit);
    console.log(flags.json === true ? JSON.stringify(out, null, 2) : "kind" in out ? m.renderTimeline(out, query) : m.renderBlame(out, query));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
