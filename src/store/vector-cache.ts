// Round 8 (speed): an in-memory copy of the note vectors, so a semantic search does not read and copy every BLOB out of
// SQLite on each query. The numbers it returns are bit-for-bit what store.cosineSim gives (same products, same sum order, same
// final expression): the norm of each stored vector is computed once, at insert, with the same loop.
//
// Store.semanticSearch takes the candidate ids from the notes table alone (a join into note_vectors cost 300 ms at 100k rows) and
// scores them here.
//
// Kept honest by three rules (see VectorCacheHolder):
//   - this process's own writes update it in place (upsert) or drop it (every DELETE, including a hard delete);
//   - another connection's commit shows as a new PRAGMA data_version (own commits never change it), and then the copy is dropped
//     and rebuilt at the next search. r10: a table fingerprint (rows, id sum, newest updated_at) decided this before, and it missed
//     a replaced vector whenever this process had written since, or the other row's timestamp was older (r9 review H1);
//   - it never holds more than MONOMEM_VECTOR_CACHE_MB per process (default 512; 0 = off); a bigger table is scanned from SQLite.
// ponytail: any foreign commit (also one that touched no vector, e.g. another process's access-count bump) costs one rebuild at
// the next search: 78-93 ms at 10k x 768 against 66-71 ms for the uncached scan after the same write (r10 bench). A counter
// table bumped by triggers on note_vectors would make the check O(1) if several busy processes share one store.

/** Cache size cap in bytes (MONOMEM_VECTOR_CACHE_MB, default 512, per process, read on every call so a test can change it). */
export function vectorCacheCapBytes(): number {
  const raw = (process.env.MONOMEM_VECTOR_CACHE_MB ?? "").trim();
  const mb = raw === "" ? 512 : Number(raw);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
}

/** sqrt of the sum of squares, summed in index order exactly like cosineSim (a double accumulator over float32 products). */
function norm(v: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  return Math.sqrt(n);
}

export class VectorCache {
  readonly dim: number;
  dataVersion: number;
  private n = 0;
  private mat: Float32Array;
  private norms: Float64Array;
  private index = new Map<number, number>();

  constructor(dim: number, capacityRows: number, dataVersion: number) {
    this.dim = dim;
    this.dataVersion = dataVersion;
    this.mat = new Float32Array(Math.max(1, capacityRows) * dim);
    this.norms = new Float64Array(Math.max(1, capacityRows));
  }

  /** Empty it for a rebuild at `dataVersion`, keeping the buffers (allocating ~30 MB again at 10k x 768 cost more than the refill). */
  reset(dataVersion: number): void {
    this.n = 0;
    this.index.clear();
    this.dataVersion = dataVersion;
  }

  has(id: number): boolean {
    return this.index.has(id);
  }

  get capacity(): number {
    return this.norms.length;
  }

  get bytes(): number {
    return this.mat.byteLength + this.norms.byteLength;
  }

  /** Add a row or replace one. `vec` must have this cache's dimension. Returns false when the copy would pass `capBytes`. */
  put(id: number, vec: Float32Array, capBytes: number): boolean {
    let at = this.index.get(id);
    if (at === undefined) {
      if (this.n * this.dim >= this.mat.length) {
        const grown = Math.max(this.n * 2, 16);
        if (grown * (this.dim * 4 + 8) > capBytes) return false;
        const m = new Float32Array(grown * this.dim);
        m.set(this.mat);
        const nr = new Float64Array(grown);
        nr.set(this.norms);
        this.mat = m;
        this.norms = nr;
      }
      at = this.n++;
      this.index.set(id, at);
    }
    this.mat.set(vec, at * this.dim);
    this.norms[at] = norm(vec);
    return true;
  }

  /** Same value as cosineSim(query, stored vector of `id`); null when the cache has no such row. `qNorm` = sqrt of the query's sum of squares. */
  score(id: number, q: Float32Array, qNorm: number): number | null {
    const at = this.index.get(id);
    if (at === undefined) return null;
    const nb = this.norms[at];
    if (qNorm === 0 || nb === 0) return 0;
    const off = at * this.dim;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i] * this.mat[off + i];
    return dot / (qNorm * nb);
  }
}

export { norm as vectorNorm };

interface Db {
  prepare(sql: string): { get(...p: unknown[]): unknown; iterate(...p: unknown[]): Iterable<unknown> };
}
interface Blob {
  note_id: number;
  dim: number;
  vec: Uint8Array;
}
/** A BLOB's float32 values, read in place when aligned (node:sqlite hands out Uint8Arrays at any offset). */
export function vectorView(vec: Uint8Array, dim: number): Float32Array {
  if (vec.byteOffset % 4 === 0) return new Float32Array(vec.buffer, vec.byteOffset, dim);
  const copy = new Uint8Array(vec.length);
  copy.set(vec);
  return new Float32Array(copy.buffer, 0, dim);
}

/** The Store's handle on the cache: builds it on first use, keeps it in step with this process's writes, checks it against others'. */
export class VectorCacheHolder {
  private cache: VectorCache | null = null;
  constructor(private readonly db: () => Db) {}

  invalidate(): void {
    this.cache = null;
  }

  /** This process stored a vector (Store.setVector). */
  upsert(noteId: number, vec: Float32Array): void {
    const c = this.cache;
    if (!c) return;
    if (c.dim !== vec.length) return this.invalidate(); // model switch: rebuild at the next search
    if (!c.put(noteId, vec, vectorCacheCapBytes())) return this.invalidate();
  }

  /** The copy for queries of `dim`, or null when it is off / too big (the caller then scans SQLite). */
  get(dim: number): VectorCache | null {
    const cap = vectorCacheCapBytes();
    if (cap === 0) return (this.cache = null);
    const db = this.db();
    const dv = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    const c = this.cache;
    if (c && c.dim === dim && c.bytes <= cap && c.dataVersion === dv) return c;
    this.cache = null; // another connection committed since the copy was built: it may have replaced or removed any vector
    const fits = (db.prepare("SELECT COUNT(*) AS c FROM note_vectors WHERE dim = ?").get(dim) as { c: number }).c;
    if (fits === 0 || fits * (dim * 4 + 8) > cap) return null;
    const reuse = c && c.dim === dim && c.capacity >= fits;
    const built = reuse ? c : new VectorCache(dim, fits + 256, dv);
    if (reuse) c.reset(dv);
    for (const r of db.prepare("SELECT note_id, dim, vec FROM note_vectors WHERE dim = ?").iterate(dim) as Iterable<Blob>) {
      if (!built.put(r.note_id, vectorView(r.vec, dim), cap)) return null;
    }
    return (this.cache = built);
  }
}
