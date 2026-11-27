// Optional semantic-search embeddings.
//
// OFF by default -- keyword (FTS5) search is the zero-dependency default and
// nothing here runs unless MONOMEM_EMBEDDINGS is turned on. When on,
// embeddings are produced by *your own* OpenAI-compatible endpoint (Ollama's
// `/v1/embeddings`, a local text-embedding server, or any OpenAI-shaped API).
// Nothing is sent to a third party you didn't configure, and there are still
// zero native modules -- this is a plain fetch().
//
// Every failure path returns null so the caller silently falls back to
// keyword search. A memory tool must never lose a write or a query because
// an optional embedding server was down.
//
// MONOMEM_EMBEDDINGS=auto: use embeddings when the configured endpoint
// answers, keyword-only when it does not, without a word on stderr. A failed
// call marks the endpoint down for AUTO_RETRY_MS (no request at all until
// then), and the timeout is AUTO_TIMEOUT_MS unless MONOMEM_EMBED_TIMEOUT_MS
// is set, so a machine without the backend never waits on it.

import { localEmbed, localModelName } from "./embeddings-local.js";

const AUTO_RETRY_MS = 60_000;
const AUTO_TIMEOUT_MS = 5000;
/** auto mode: no call before this time (the endpoint failed recently). */
let autoDownUntil = 0;

export interface EmbeddingsConfig {
  enabled: boolean;
  /** MONOMEM_EMBEDDINGS=local: run a small model in this process (embeddings-local.ts) instead of calling an endpoint. */
  local?: boolean;
  /** MONOMEM_EMBEDDINGS=auto: a failure is silent and backs off. */
  auto?: boolean;
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export function embeddingsConfig(): EmbeddingsConfig {
  const flag = (process.env.MONOMEM_EMBEDDINGS || "").trim().toLowerCase();
  const auto = flag === "auto";
  const local = flag === "local";
  const enabled = auto || local || flag === "1" || flag === "on" || flag === "true" || flag === "yes";
  return {
    enabled,
    ...(auto ? { auto: true } : {}),
    ...(local ? { local: true } : {}),
    // Ollama's OpenAI-compatible route by default; override for any other.
    url: process.env.MONOMEM_EMBED_URL || "http://localhost:11434/v1/embeddings",
    model: process.env.MONOMEM_EMBED_MODEL || "nomic-embed-text",
    apiKey: process.env.MONOMEM_EMBED_KEY || undefined,
    // 30s default: a local embedding model's first (cold-load) call can be
    // slow; after that it's fast. Raise it with MONOMEM_EMBED_TIMEOUT_MS.
    timeoutMs: Number(process.env.MONOMEM_EMBED_TIMEOUT_MS || (auto ? AUTO_TIMEOUT_MS : 30000)),
  };
}

/** The model name stored with a vector: the local model's own name for MONOMEM_EMBEDDINGS=local (not the unused endpoint model). */
export const vectorModelLabel = (cfg: EmbeddingsConfig): string => (cfg.local ? localModelName() : cfg.model);

/** Test hook: forget an auto-mode "endpoint is down" mark. */
export function resetEmbeddingsAuto(): void {
  autoDownUntil = 0;
}

export function embeddingsEnabled(): boolean {
  return embeddingsConfig().enabled;
}

/** Text used to represent a note for embedding. */
export function noteEmbeddingText(title: string, body: string): string {
  return body && body.trim() ? `${title}\n\n${body}` : title;
}

function parseEmbedding(json: unknown): Float32Array | null {
  // OpenAI shape: { data: [ { embedding: number[] } ] }
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data) && data[0] && Array.isArray((data[0] as { embedding?: unknown }).embedding)) {
    return Float32Array.from((data[0] as { embedding: number[] }).embedding);
  }
  // Ollama native shape: { embedding: number[] }  (fallback)
  const emb = (json as { embedding?: unknown }).embedding;
  if (Array.isArray(emb)) return Float32Array.from(emb as number[]);
  return null;
}

/**
 * Embed a single string. Returns null (never throws) on disabled, timeout,
 * network error, non-200, or an unrecognized response shape.
 */
const loggedFailures = new Set<string>();

export async function embed(
  text: string,
  cfg: EmbeddingsConfig = embeddingsConfig(),
  role: "query" | "passage" = "passage"
): Promise<Float32Array | null> {
  if (!cfg.enabled || !text || !text.trim()) return null;
  if (cfg.local) return localEmbed(text, role);
  if (cfg.auto && Date.now() < autoDownUntil) return null;
  // auto: a failure is expected (no backend on this machine), so it is quiet and backs off instead of logging.
  const fail = (msg: string): null => {
    if (cfg.auto) autoDownUntil = Date.now() + AUTO_RETRY_MS;
    else if (!loggedFailures.has(msg)) {
      // The same failure (backend down) repeats on every call: say it once per process, not once per note.
      loggedFailures.add(msg);
      console.error(`${msg} (repeats of this error are not shown)`);
    }
    return null;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    warnIfRemote(cfg.url);
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: text }),
      signal: controller.signal,
      // A redirect could send note text (and the API key) to a host nobody configured.
      redirect: "error",
    });
    if (!res.ok) return fail(`[monomem] embeddings endpoint returned ${res.status}; using keyword search`);
    const json = (await res.json()) as unknown;
    const vec = parseEmbedding(json);
    if (!vec || vec.length === 0) return fail("[monomem] embeddings response had no vector; using keyword search");
    if (cfg.auto) autoDownUntil = 0;
    return vec;
  } catch (e) {
    return fail(`[monomem] embeddings call failed (${(e as Error).message}); using keyword search`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Round 4: search queries repeat (an agent re-asks, the hook and the tool ask the same thing), and each embed is an HTTP
 * round trip (~20 ms local). Up to QUERY_VECTOR_MAX recent query vectors are kept in this process, keyed by endpoint, model
 * and text; least recently used goes first. Failures are not kept. Each caller gets a copy.
 */
const QUERY_VECTOR_MAX = 256;
const queryVectors = new Map<string, Float32Array>();

export async function embedQuery(text: string, cfg: EmbeddingsConfig = embeddingsConfig()): Promise<Float32Array | null> {
  const key = JSON.stringify([cfg.url, cfg.model, text]);
  const hit = queryVectors.get(key);
  if (hit) {
    queryVectors.delete(key);
    queryVectors.set(key, hit); // most recent last
    return hit.slice();
  }
  const vec = await embed(text, cfg, "query");
  if (!vec) return null;
  queryVectors.set(key, vec.slice());
  if (queryVectors.size > QUERY_VECTOR_MAX) queryVectors.delete(queryVectors.keys().next().value!);
  return vec;
}

/** Test hook (and nothing else needs it): forget the cached query vectors. */
export function clearQueryVectors(): void {
  queryVectors.clear();
}

// Note text goes to the embeddings endpoint. A remote one is allowed (hosted embedding APIs are a
// documented choice), but never silently: say once, on stderr, where the text is going.
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;
let remoteWarned = false;
function warnIfRemote(url: string): void {
  if (remoteWarned) return;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (LOOPBACK.test(host)) return;
  remoteWarned = true;
  process.stderr.write(`[monomem] embeddings: the text of each note and search is sent to ${host}, which is not this machine (MONOMEM_EMBED_URL)
`);
}
