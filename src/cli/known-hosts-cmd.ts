// `monomem settings known-hosts [add <host> | remove <host>]`: the known-hosts list (known-hosts.ts) the taint gate uses.
// Adding a host loosens the gate, so it needs a person at a terminal and a typed yes; removing one tightens it and does not.
import { requireOperator } from "../operator-gate.js";
import { knownHosts, normHost, saveKnownHosts } from "../known-hosts.js";

const USAGE = "Usage: monomem settings known-hosts [add <host> | remove <host>]";

export async function knownHostsCmd(args: string[]): Promise<void> {
  const { DATA_DIR } = await import("../config.js");
  const [verb, raw, ...extra] = args;
  const show = (list: readonly string[]): void => {
    console.log(`known hosts (${list.length}): ${list.join(", ") || "(none)"}`);
    console.log("The taint gate asks before a web request to any other host once a session has read outside content.");
  };
  if (verb === undefined) return show(knownHosts(DATA_DIR));
  const host = normHost(raw ?? "");
  if ((verb !== "add" && verb !== "remove") || !host || extra.length) {
    console.error(raw && !host ? `"${String(raw).slice(0, 80)}" is not a host name (write it like example.com).\n${USAGE}` : USAGE);
    process.exit(1);
  }
  const now = knownHosts(DATA_DIR);
  if (verb === "add") {
    if (now.includes(host)) return show(now);
    await requireOperator(`add ${host} to the known hosts (web requests to it will no longer be asked about after outside content)`);
    return show(saveKnownHosts(DATA_DIR, [...now, host]));
  }
  if (!now.includes(host)) {
    console.error(`${host} is not on the list.`);
    return show(now);
  }
  show(saveKnownHosts(DATA_DIR, now.filter((h) => h !== host)));
}

/** After `monomem project-rules` wrote a rules file: record its hashes so the next session start does not report it. Best effort. */
export async function recordRulesWrite(path: string): Promise<void> {
  try {
    const { DB_PATH } = await import("../config.js");
    const { Store } = await import("../store.js");
    const store = new Store(DB_PATH);
    try {
      (await import("../rules-watch.js")).recordRulesFile(store.captureDb(), path);
    } finally {
      store.close();
    }
  } catch {
    /* the next session start then reports the block change once */
  }
}
