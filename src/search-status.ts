// The `monomem check` line about how search finds meaning. Reads settings and files only: no network, no model load.
import { embeddingsConfig } from "./embeddings.js";
import { localEmbedInstalled } from "./embeddings-local.js";

export function searchStatusText(): string {
  const cfg = embeddingsConfig();
  const base = "keyword search with built-in synonyms (English) and Chinese/Japanese/Korean pair matching";
  if (cfg.local) {
    return localEmbedInstalled()
      ? `${base}, plus meaning search by the small local model (MONOMEM_EMBEDDINGS=local, no server)`
      : `${base}. MONOMEM_EMBEDDINGS=local is set but the model is not installed, so search stays keyword (run node scripts/install-local-embeddings.mjs once)`;
  }
  if (cfg.enabled) return `${base}, plus meaning search through ${cfg.url} (${cfg.model})${cfg.auto ? ", keyword when it is not running" : ""}`;
  return `${base}. Meaning search (other languages, paraphrases) is off: set MONOMEM_EMBEDDINGS=auto with Ollama and nomic-embed-text, or MONOMEM_EMBEDDINGS=local after node scripts/install-local-embeddings.mjs`;
}
