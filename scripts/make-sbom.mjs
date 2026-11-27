// Writes a CycloneDX 1.5 SBOM of the runtime dependencies (devDependencies left out) from package-lock.json.
// It wraps the `npm sbom` that ships with npm 10+, so there is no new dependency. The only change to npm's output is the
// root component name, which npm takes from the folder name (a checkout in a folder called "work" would say "work").
// Usage: node scripts/make-sbom.mjs [out-file]   (default build/sbom.cdx.json)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "build", "sbom.cdx.json");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// npm_execpath is set when run through `npm run`. Else Windows: the npm beside node (no bare npm.exe); elsewhere: `npm` on PATH.
const npmCli = process.env.npm_execpath || (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : "");
const sbomArgs = ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev", "--package-lock-only"];
const opts = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] };
const raw = (npmCli ? execFileSync(process.execPath, [npmCli, ...sbomArgs], opts) : execFileSync("npm", sbomArgs, opts));
const bom = JSON.parse(raw);
if (bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components) || bom.components.length === 0) {
  throw new Error("npm sbom returned no CycloneDX components; is package-lock.json present?");
}
bom.metadata.component = { ...bom.metadata.component, name: pkg.name, version: pkg.version };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + "\n");
process.stdout.write(`SBOM: ${bom.components.length} components, ${pkg.name}@${pkg.version} -> ${out}\n`);
