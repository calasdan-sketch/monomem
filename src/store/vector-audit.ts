// `monomem check`: stored note vectors that the current embedding model cannot be compared with. semanticSearch skips a vector
// whose length differs from the query's, so after switching model (for example to MONOMEM_EMBEDDINGS=local) without
// `monomem reindex`, search silently stays keyword for those notes. This counts them so check can say so.
import type { DatabaseSync } from "node:sqlite";

export interface VectorMismatch {
  /** Vectors made under another model label, or (when the length is known) of another length. */
  mismatched: number;
  total: number;
}

/** `expectedDim` is only known for the default local model (384); pass undefined otherwise. */
export function vectorMismatch(db: DatabaseSync, modelLabel: string, expectedDim?: number): VectorMismatch {
  const row = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN model <> ? OR (? IS NOT NULL AND dim <> ?) THEN 1 ELSE 0 END), 0) AS bad FROM note_vectors")
    .get(modelLabel, expectedDim ?? null, expectedDim ?? null) as { total: number; bad: number };
  return { mismatched: Number(row.bad), total: Number(row.total) };
}

/** The check line, or "" when everything lines up (or there are no vectors). */
export function vectorMismatchText(m: VectorMismatch): string {
  return m.mismatched > 0 ? `${m.mismatched} of ${m.total} stored meaning vectors came from another model (or a different length) and search skips them, staying keyword for those notes: run monomem reindex` : "";
}
