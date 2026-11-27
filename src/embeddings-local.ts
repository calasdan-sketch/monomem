// Optional in-process embeddings (MONOMEM_EMBEDDINGS=local): a small multilingual model run by transformers.js, with no
// server and no network at run time. OFF by default and never downloaded by monomem: the person installs the package and the
// model files once (scripts/install-local-embeddings.mjs, one command) and then opts in. Every failure returns null, so
// search falls back to keyword search exactly as when an Ollama endpoint is down.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/** Default model: multilingual-e5-small, 384 numbers per note, 100+ languages (needs "query: " / "passage: " prefixes). */
export const LOCAL_MODEL = "Xenova/multilingual-e5-small";

/** Where the install script puts the package and model; MONOMEM_LOCAL_EMBED_DIR overrides. */
export function localEmbedDir(): string {
  return process.env.MONOMEM_LOCAL_EMBED_DIR || join(process.env.MONOMEM_HOME || process.env.ONEMEMORY_HOME || join(homedir(), ".monomem"), "embed");
}

interface Transformers {
  env: Record<string, unknown>;
  pipeline: (task: string, model: string, o: Record<string, unknown>) => Promise<Extractor>;
}
type Extractor = (text: string, o: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
/** The model name stored beside each vector, so a later model change is visible (not the endpoint model name). */
export const localModelName = (): string => process.env.MONOMEM_LOCAL_EMBED_MODEL || LOCAL_MODEL;

/** A failed load is tried again after this long (a model installed later, a memory squeeze that passed). */
export const LOAD_RETRY_MS = 60_000;
let loading: Promise<Extractor | null> | null = null;
let failedAt = 0;
let lastWarning = "";
let loader: () => Promise<Extractor> = load;
/** Test hook: replace the loader and forget everything cached. */
export function resetLocalEmbed(l: () => Promise<Extractor> = load): void {
  loader = l;
  loading = null;
  failedAt = 0;
  lastWarning = "";
}
const warnOnce = (msg: string): void => {
  if (msg === lastWarning) return;
  lastWarning = msg;
  process.stderr.write(`[monomem] local embeddings: ${msg}; search stays keyword (retrying in about a minute)
`);
};

async function load(): Promise<Extractor> {
  const dir = localEmbedDir();
  let mod: Transformers;
  try {
    mod = createRequire(join(dir, "package.json"))("@huggingface/transformers") as Transformers; // the install script's folder
  } catch {
    mod = (await import("@huggingface/transformers" as string)) as Transformers; // a plain install next to monomem
  }
  mod.env.allowRemoteModels = false; // never download here
  mod.env.localModelPath = join(dir, "models");
  return mod.pipeline("feature-extraction", localModelName(), { dtype: "q8" });
}

/** The embedding of `text`, or null when the package or model is not installed. role picks the e5 prefix. */
export async function localEmbed(text: string, role: "query" | "passage"): Promise<Float32Array | null> {
  if (loading && failedAt && Date.now() - failedAt >= LOAD_RETRY_MS) loading = null; // a failed load is not kept forever
  loading ??= loader().then(
    (r) => ((failedAt = 0), r),
    (e: unknown) => (warnOnce(`could not load the model (${(e as Error)?.message ?? String(e)})`), (failedAt = Date.now()), null)
  );
  const run = await loading;
  if (!run) return null;
  try {
    const out = await run(`${role}: ${text.slice(0, 2000)}`, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data);
  } catch (e) {
    warnOnce(`the model failed on a note (${(e as Error).message})`);
    return null;
  }
}

/** True when the package and the model files are present (for `monomem check`; loads nothing). */
export function localEmbedInstalled(): boolean {
  const dir = localEmbedDir();
  return existsSync(join(dir, "node_modules", "@huggingface", "transformers")) && existsSync(join(dir, "models"));
}
