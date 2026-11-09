// "Did you mean ...?" for mistyped commands and app names.
/** The closest known name, or null when nothing is close. */
export function didYouMean(word: string, options: readonly string[]): string | null {
  const w = word.toLowerCase();
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const x = dist(w, o);
    if (x < bestD || (x === bestD && o.startsWith(w[0] ?? ""))) {
      best = o;
      bestD = x;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(w.length / 3)) ? best : null;
}

