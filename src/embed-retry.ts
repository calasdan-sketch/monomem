// `monomem reindex` embedder with patience (2026-11-18). A local embedding model's FIRST call loads the model and can take
// longer than the usual timeout; an earlier test saw "operation aborted" for 2 of 5 notes. The first call here gets a longer
// timeout, and a failed note is retried (two more tries, after short pauses) before it is counted as failed. Only `reindex`
// uses this: the write path must never wait this long, and a note that failed there is filled in by the next `reindex`.
import { embed, resetEmbeddingsAuto, type EmbeddingsConfig } from "./embeddings.js";

export const COLD_FIRST_TIMEOUT_MS = 120_000;
export const RETRY_TIMEOUT_MS = 60_000;
export const RETRY_PAUSES_MS: readonly number[] = [2000, 5000];

export interface RetryDeps {
  embed?: typeof embed;
  sleep?: (ms: number) => Promise<void>;
}

/** A function that embeds one text: long first-call timeout until one call succeeds, then up to two retries per failure. */
export function reindexEmbedder(cfg: EmbeddingsConfig, deps: RetryDeps = {}): (text: string) => Promise<Float32Array | null> {
  const run = deps.embed ?? embed;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let warm = false;
  return async (text) => {
    let vec = await run(text, warm ? cfg : { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, COLD_FIRST_TIMEOUT_MS) });
    for (let i = 0; !vec && i < RETRY_PAUSES_MS.length; i++) {
      await sleep(RETRY_PAUSES_MS[i]);
      resetEmbeddingsAuto(); // auto mode marks the endpoint down for a minute after a failure; an explicit reindex asks again
      vec = await run(text, { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, RETRY_TIMEOUT_MS) });
    }
    if (vec) warm = true;
    return vec;
  };
}
