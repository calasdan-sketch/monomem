// Operator gate shared by the CLI commands (cli.ts, facts.ts): kept out of cli.ts because importing cli.ts runs the CLI.
import readline from "node:readline";

/**
 * Pinned notes are the operator's: changing or retiring one from the CLI needs the same terminal + typed yes as the commands that lower
 * protection. Without it an agent with a shell tool (`</dev/null`) could use the CLI's writer `cli` to get past the pin. Done here, not in
 * the Store, so library callers and tests that act as `cli` are unaffected.
 */
export async function gatePinned(store: import("./store.js").Store, ids: number[], what: string): Promise<void> {
  if (!ids.length) return;
  const pinned = new Set(store.pinnedNotes().map((n) => n.id));
  const hit = ids.find((i) => pinned.has(i));
  if (hit !== undefined) await requireOperator(`${what} on pinned note #${hit}`);
}

/**
 * 1.4.0: pinning (or replacing with) a note from outside content no person confirmed. The Store lets the CLI through and
 * records the pass as the human confirm, so the person must be at a terminal and type yes, exactly like gatePinned.
 */
export async function gateOutside(store: import("./store.js").Store, ids: number[], what: string): Promise<void> {
  const { needsHumanConfirm } = await import("./store.js");
  const hit = ids.find((i) => {
    const n = store.read(i); // gate-ok: the CLI is the operator
    return n !== null && needsHumanConfirm(n);
  });
  if (hit !== undefined) await requireOperator(`${what} note #${hit}, which came from outside content and no person has confirmed,`);
}

/**
 * Operator gate for commands that LOWER protection (undistrust, attester-add/unrevoke, quarantine approve).
 * Needs a real terminal on both ends and a typed "yes"; there is no --yes. This raises the bar against an
 * agent running the CLI through a non-interactive shell tool. It is not a guarantee: a tool that allocates
 * a pseudo-terminal can pass it (SECURITY.md).
 */
export async function requireOperator(what: string): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      `Refused: ${what} lowers this store's protection, so a person must run it in a terminal and type a confirmation. ` +
        "This is not a terminal (an agent's shell tool, a script or a pipe), and there is no --yes for it. Open a terminal and run the same command there."
    );
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${what} lowers protection. Type "yes" to continue: `, resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("Not confirmed; nothing changed.");
    process.exit(1);
  }
}
