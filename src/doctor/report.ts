// What every doctor check gets: the reporter (ok / warn / fail lines, counted for the verdict), the path of cli.js, and
// the facts an earlier check found that a later one needs (the database check notes dbProblem, sealedNotes, ...).

export interface Doctor {
  /** The path of cli.js: app entries and hooks are compared with, or written for, this file. */
  cliPath: string;
  ok(message: string): void;
  warn(message: string, fix?: string): void;
  fail(message: string, fix?: string): void;
  warnings: number;
  failures: number;
  /** The first run of doctor made the main key (reported by tokenCheck). */
  keyJustCreated: boolean;
  dataDirWritable: boolean;
  dbProblem: boolean;
  oldSchema: boolean;
  distrustCount: number;
  hasLabelled: boolean;
  hasPrivate: boolean;
  /** Which store this is, for the server probe. */
  storeIdForProbe: string;
  sealedNotes: number;
}

/** A reporter that prints to stdout, coloured only for a person at a terminal. */
export function newDoctor(cliPath: string): Doctor {
  // Colour only for a person at a terminal: not when piped, and not when NO_COLOR is set (no-color.org).
  // FORCE_COLOR=0 / false means off (even on a terminal); any other value forces colour on.
  const force = process.env.FORCE_COLOR;
  const colour = (force === undefined || force === "" ? process.stdout.isTTY : force !== "0" && force !== "false") && !process.env.NO_COLOR;
  const tag = (t: string, code: number) => (colour ? `\x1b[${code}m${t}\x1b[0m` : t);
  const say = (kind: string, problem: string, fix?: string) => {
    console.log("  " + tag(`[${kind}]`, kind === "warn" ? 33 : 31) + " " + (fix ? "Problem: " : "") + problem);
    if (fix) console.log("         Fix: " + fix);
  };
  const d: Doctor = {
    cliPath,
    ok: (m: string) => console.log("  " + tag("[ok]", 32) + "   " + m),
    warn: (m: string, fix?: string) => {
      d.warnings++;
      say("warn", m, fix);
    },
    fail: (m: string, fix?: string) => {
      d.failures++;
      say("FAIL", m, fix);
    },
    warnings: 0,
    failures: 0,
    keyJustCreated: false,
    dataDirWritable: true,
    dbProblem: false,
    oldSchema: false,
    distrustCount: 0,
    hasLabelled: false,
    hasPrivate: false,
    storeIdForProbe: "",
    sealedNotes: 0,
  };
  return d;
}
