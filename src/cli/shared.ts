// Small helpers every CLI command file uses: the flag parser and the terminal prompt. No imports that load config.js
// (cli.js imports this statically; see test/cli-static-imports.test.ts).

import readline from "node:readline";

/** Tiny flag parser: --name value / --name=value / boolean flags. */
export function parseFlags(
  args: string[],
  spec: { values: string[]; bools: string[] }
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  // A value is never swallowed from a KNOWN following flag (`--label --any-server` is a missing value), but a value
  // that merely starts with "--" (a base64url key can) is still a value.
  const looksLikeFlag = (t: string): boolean => {
    if (!t.startsWith("--") || t.length <= 2) return false;
    const n = t.slice(2, t.indexOf("=") > 0 ? t.indexOf("=") : undefined);
    return spec.values.includes(n) || spec.bools.includes(n);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // everything after a bare -- is positional (a base64url key or a label may start with "-")
      rest.push(...args.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    let name = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    // --ns is short for --namespace wherever a command takes --namespace.
    if (name === "ns" && !spec.values.includes("ns") && spec.values.includes("namespace")) name = "namespace";
    if (name && spec.values.includes(name)) {
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) flags[name] = args[++i];
      else {
        console.error(`--${name} needs a value`);
        process.exit(1);
      }
    } else if (name && spec.bools.includes(name)) {
      flags[name] = true;
    } else if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else rest.push(a); // a base64url key id may start with a single "-"; that is a value, not an option
  }
  return { flags, rest };
}

export const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** TTY yes/no prompt; anything but y/yes aborts. */
export function terminalIO(): import("../setup.js").SetupIO {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (prompt) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a: string) => {
          rl.close();
          resolve(a);
        });
      }),
  };
}
