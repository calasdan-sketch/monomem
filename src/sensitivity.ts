// Per-memory sensitivity labels.
//
// Every note carries one label, ordered public < internal < private. A token may
// carry a ceiling (`max_sensitivity`): it can then never read, list, search,
// inject, export, relabel or overwrite a note above that ceiling, on any path.
// The ceiling travels with the request in the actor context (src/actor.ts), and
// the store applies it inside its own queries, so no surface has to remember.
//
// Fail closed: a label the code does not know (a hand-edited database, a value
// from a newer build) ranks ABOVE every ceiling, so it is hidden from any
// restricted token rather than shown.

export const SENSITIVITY_LEVELS = ["public", "internal", "private"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** The label of a note written without one (and of every note that existed before labels did). */
export const DEFAULT_SENSITIVITY: Sensitivity = "internal";

export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === "string" && (SENSITIVITY_LEVELS as readonly string[]).includes(v);
}

/** Position in the order; anything unknown ranks above every real label (so a ceiling never admits it). */
export function sensitivityRank(v: unknown): number {
  const i = typeof v === "string" ? (SENSITIVITY_LEVELS as readonly string[]).indexOf(v) : -1;
  return i < 0 ? SENSITIVITY_LEVELS.length : i;
}

/** The labels a token with this ceiling may see. An unknown ceiling admits nothing. */
export function levelsAtOrBelow(max: unknown): Sensitivity[] {
  if (!isSensitivity(max)) return [];
  const r = sensitivityRank(max);
  return SENSITIVITY_LEVELS.filter((l) => sensitivityRank(l) <= r);
}

/** True when a note labelled `label` may be shown to a caller whose ceiling is `max` (undefined = no ceiling). */
export function sensitivityVisible(label: unknown, max: unknown): boolean {
  if (max === undefined) return true;
  return isSensitivity(max) && isSensitivity(label) && sensitivityRank(label) <= sensitivityRank(max);
}

/** Normalise user input ("PRIVATE", " Public ") to a label, or null when it is not one. */
export function parseSensitivity(v: unknown): Sensitivity | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return isSensitivity(t) ? t : null;
}

export const SENSITIVITY_HELP = `one of ${SENSITIVITY_LEVELS.join(", ")}`;

/**
 * MONOMEM_RECALL_MAX_SENSITIVITY: a ceiling for the local hooks that put memory into an agent's context (SessionStart recall,
 * file-context). undefined = not set (no ceiling); null = set to something that is not a label (the caller must inject
 * NOTHING, never everything).
 */
export function recallCeilingFromEnv(env: NodeJS.ProcessEnv = process.env): Sensitivity | null | undefined {
  const raw = (env.MONOMEM_RECALL_MAX_SENSITIVITY ?? "").trim();
  if (!raw) return undefined;
  return parseSensitivity(raw);
}

/** The highest label among these notes ("internal" when none carries one). A merge or replacement must never lower a label. */
export function strictestLabel(notes: Array<{ sensitivity?: string }>): Sensitivity {
  let best: Sensitivity = DEFAULT_SENSITIVITY;
  for (const n of notes) {
    const l = n.sensitivity ?? DEFAULT_SENSITIVITY;
    if (sensitivityRank(l) > sensitivityRank(best)) best = (isSensitivity(l) ? l : "private") as Sensitivity;
  }
  return best;
}

let warnedExposure = false;
/**
 * Start-up warning, once per process: some notes carry a label other than "internal", yet a secondary token has no
 * ceiling and so still reads everything. Never throws; it is advice, not a gate.
 */
export function warnUnlabelledExposure(store: { labelledAboveDefault(): number }, tokens: Array<{ label: string; max_sensitivity?: string }>, primaryLabel = "primary"): void {
  if (warnedExposure) return;
  try {
    const open = tokens.filter((t) => t.label !== primaryLabel && t.max_sensitivity === undefined);
    if (open.length === 0 || store.labelledAboveDefault() === 0) return;
    warnedExposure = true;
    console.error(
      `[monomem] warning: some notes are labelled, but ${open.length} secondary token(s) (${open.map((t) => JSON.stringify(t.label || "(unnamed)")).join(", ")}) have no "max_sensitivity" and still read every label. ` +
        "Set one on each (or MONOMEM_DEFAULT_MAX_SENSITIVITY). See docs/sensitivity-labels.md."
    );
  } catch {
    /* advice only */
  }
}

/** MONOMEM_DEFAULT_MAX_SENSITIVITY: undefined = unset, null = not a label (the caller must refuse to start). */
export function defaultCeilingFromEnv(): Sensitivity | undefined | null {
  const raw = (process.env.MONOMEM_DEFAULT_MAX_SENSITIVITY ?? "").trim();
  if (!raw) return undefined;
  return parseSensitivity(raw);
}

/**
 * Private notes are not sent to an embeddings endpoint (MONOMEM_EMBED_URL) unless MONOMEM_ALLOW_PRIVATE_REMOTE=1: that call
 * carries the note's text off this process, whatever the label says. Such a note is found by keyword search only.
 */
export function mayEmbed(note: { sensitivity?: string }): boolean {
  return note.sensitivity !== "private" || process.env.MONOMEM_ALLOW_PRIVATE_REMOTE === "1";
}
