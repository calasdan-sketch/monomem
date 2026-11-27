// The pure functions that take untrusted text, as one table (not a test file).
import { scanClaims } from "../src/lint-claims.js";
import { scanForInjection, scanForPii, scanForDirective, lintContent } from "../src/lint.js";
import { flagConflict } from "../src/conflict-detect.js";
import { parseTimePhrase } from "../src/time-parse.js";
import { cjkBigrams } from "../src/store/cjk-search.js";
import { extractKeywords } from "../src/keywords.js";
import { jaccardSimilarity, tokenize } from "../src/text-sim.js";
import { normalizeForScan } from "../src/security.js";

export const FUNCTIONS: Record<string, (s: string) => unknown> = {
  scanClaimsBody: (s) => scanClaims({ body: s, writer: "agent" }),
  scanClaimsTitle: (s) => scanClaims({ title: s, writer: "agent" }),
  scanClaimsTag: (s) => scanClaims({ tags: [`fact:k=${s}`], writer: "agent" }),
  scanForInjection,
  scanForPii,
  scanForDirective,
  lintContentBody: (s) => lintContent({ title: "t", body: s, tags: [] } as never),
  flagConflict: (s) => flagConflict({ title: "a", body: s }, { title: "a", body: s + " not" }),
  parseTimePhrase: (s) => parseTimePhrase(s),
  cjkBigrams,
  extractKeywords,
  tokenize,
  jaccard: (s) => jaccardSimilarity(s, s.split("").reverse().join("")),
  normalizeForScan: (s) => normalizeForScan(s),
};
