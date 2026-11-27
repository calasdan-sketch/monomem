// `monomem setup` offers meaning search only when it is free and local: an Ollama on this computer that already has the
// nomic-embed-text model. Then new app entries get MONOMEM_EMBEDDINGS=auto (never "on": auto gives up after 5 s and backs
// off for a minute, so a busy GPU cannot hang a write; see embeddings.ts). Only the MCP server entries get it: the hooks are
// separate commands and never call the embeddings endpoint.
const OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags";
const MODEL = "nomic-embed-text";

export const EMBEDDINGS_OFFER_ENV: Readonly<Record<string, string>> = { MONOMEM_EMBEDDINGS: "auto" };

export const embeddingsOfferLine =
  `Found Ollama with ${MODEL} on this computer, so new app entries get MONOMEM_EMBEDDINGS=auto: search also matches meaning ` +
  "while Ollama runs, and falls back to keyword search when it does not (the session hooks never use it). Leave it out with --no-embeddings.";

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * True when a local Ollama answers within timeoutMs and lists nomic-embed-text. False (never throws) when the person already
 * chose (MONOMEM_EMBEDDINGS or MONOMEM_EMBED_URL set), when probes are off (MONOMEM_NO_SERVER_PROBE=1, the test suite), or on
 * any error.
 */
export async function localEmbeddingsAvailable(env: NodeJS.ProcessEnv, fetchFn?: Fetch, timeoutMs = 800): Promise<boolean> {
  if (env.MONOMEM_NO_SERVER_PROBE === "1" || env.MONOMEM_EMBEDDINGS?.trim() || env.MONOMEM_EMBED_URL?.trim()) return false;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const r = fetchFn ? await fetchFn(OLLAMA_TAGS, { signal }) : await fetch(OLLAMA_TAGS, { signal });
    if (!r.ok) return false;
    const models = (await r.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    return Array.isArray(models.models) && models.models.some((m) => [m.name, m.model].some((n) => typeof n === "string" && (n === MODEL || n.startsWith(MODEL + ":"))));
  } catch {
    return false;
  }
}

/** The honest cost of the opt-in local model (measured on the bench machine; the numbers are in docs/search.md). */
export const LOCAL_EMBEDDINGS_COST = "130 MB download once, about +40 ms per write, about +13 ms per search";

/**
 * What `monomem setup` prints about meaning search: the Ollama line when one was found, otherwise (nothing configured) the
 * one-command opt-in with its cost. Pure text, no network and no download: setup never installs it for you.
 */
export function embeddingsSetupLine(found: boolean | undefined, env: NodeJS.ProcessEnv, remote: boolean): string {
  if (remote) return "";
  if (found) return embeddingsOfferLine;
  if (env.MONOMEM_EMBEDDINGS?.trim() || env.MONOMEM_EMBED_URL?.trim()) return "";
  return `Search matches words only. For meaning search (other languages, paraphrases) with no server, opt in yourself: in the Monomem source folder run  node scripts/install-local-embeddings.mjs  (${LOCAL_EMBEDDINGS_COST}), then set MONOMEM_EMBEDDINGS=local and run  monomem reindex.  Setup never downloads it for you.`;
}
