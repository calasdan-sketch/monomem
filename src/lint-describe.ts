// describeFindings lives apart from lint.ts so cli.ts can use it without loading config.js at startup:
// `bench --longmemeval|--locomo` must point MONOMEM_HOME at a temp folder BEFORE config.js reads it (see bench/retrieval-env.ts).
import type { LintFinding } from "./lint.js";

/** "GitHub token in body; instruction override in title" */
export function describeFindings(findings: LintFinding[]): string {
  return findings.map((f) => (f.category === "approval" ? f.label : `${f.label} in ${f.field}`)).join("; ");
}
