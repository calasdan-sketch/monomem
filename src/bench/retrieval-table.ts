// One table of recall@k (k = 1, 3, 5, 10, 20) for every mode that ran, so no single k or mode is shown alone.
import type { MetricRow } from "./retrieval-metrics.js";

interface ModeLike {
  metrics: Record<string, MetricRow>;
}
interface ReportLike {
  keyword: ModeLike;
  relevant: ModeLike;
  semantic?: ModeLike;
  hybrid: ModeLike | { skipped: string };
}

const KS: Array<[string, keyof MetricRow]> = [["R@1", "r1"], ["R@3", "r3"], ["R@5", "r5"], ["R@10", "r10"], ["R@20", "r20"]];
const pct = (x: number): string => (x * 100).toFixed(1).padStart(7);

/** Any-hit recall at each k, all questions, one row per mode that ran (a skipped mode is named, not dropped). */
export function renderRecallAtK(r: ReportLike): string {
  const rows: Array<[string, ModeLike | { skipped: string } | undefined]> = [
    ["keyword", r.keyword], ["relevant", r.relevant], ["semantic", r.semantic], ["hybrid", r.hybrid],
  ];
  const lines = ["recall@k, any gold hit in the top k, all questions", `${"mode".padEnd(10)}${KS.map(([h]) => h.padStart(7)).join("")}`];
  for (const [name, m] of rows) {
    if (!m) continue;
    if ("skipped" in m) lines.push(`${name.padEnd(10)}skipped: ${m.skipped}`);
    else lines.push(`${name.padEnd(10)}${KS.map(([, f]) => pct(m.metrics.all[f])).join("")}`);
  }
  return lines.join("\n");
}
