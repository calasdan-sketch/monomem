// `monomem tidy edges` compares every note with every other one, so the work
// grows with the square of the note count. Above this many comparisons the
// command refuses by default (the person can still pass --all).
export const EDGES_HARD_CAP_PAIRS = 20_000_000;
const PAIRS_PER_SECOND = 190_000; // measured on a laptop

/** Plain-language refusal text, or null when the job is small enough. */
export function edgesTooBigMessage(notes: number, pairs: number): string | null {
  if (pairs <= EDGES_HARD_CAP_PAIRS) return null;
  const minutes = Math.max(10, Math.round(pairs / PAIRS_PER_SECOND / 60));
  return (
    `Too big to do in one go: ${notes.toLocaleString("en-US")} notes means about ` +
    `${pairs.toLocaleString("en-US")} comparisons, which could take over ${minutes} minutes. ` +
    "Nothing was changed.\n" +
    "Search by meaning keeps working for new notes as you add them. To do it anyway, run " +
    "`monomem tidy edges --all --yes` when you can leave it running, " +
    "or run it from inside one project folder so only that project's notes are compared."
  );
}
