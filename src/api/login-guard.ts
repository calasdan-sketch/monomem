// POST /login is open to anyone who can reach the port. Wrong codes are counted per source address: after MAX_FAILS in a
// minute that source is refused (429) until the minute is up. A right code is never blocked: it is checked first, so a stranger sharing the key behind a tunnel cannot lock the owner out. (Guessing is not the risk: codes are 128 random bits.)
const WINDOW_MS = 60_000;
const MAX_FAILS = 8;
const MAX_SOURCES = 1000;

export class LoginGuard {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  private recent(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const live = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (live.length) this.fails.set(key, live);
    else this.fails.delete(key);
    return live;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= MAX_FAILS;
  }
  fail(key: string): void {
    const live = this.recent(key);
    if (this.fails.size >= MAX_SOURCES && !this.fails.has(key)) this.fails.delete(this.fails.keys().next().value as string); // ponytail: oldest source dropped; a per-IP LRU if abuse shows up
    this.fails.set(key, [...live, this.now()]);
  }
}
export const loginGuard = new LoginGuard();
