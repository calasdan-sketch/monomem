// Known hosts (PLAN D, destination allowlist): the one list of hosts this person expects data to go to. The taint gate
// (taint-gate.ts) asks before a curl / wget / fetch / WebFetch to a host NOT on it once the session has read outside content;
// other checks of where Monomem sends things read the same list (knownHosts + isKnownHost), so there is one list to keep.
//
// Stored as <data dir>/known-hosts.json ({"hosts": [...]}), not in the database: the gate runs on every tool call and must not
// open the store to read it. A missing or broken file means the defaults. Only node:fs and node:path imports (hook latency).
// Adding a host loosens the gate, so `monomem settings known-hosts add` needs a person at a terminal (cli/known-hosts-cmd.ts).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export const DEFAULT_KNOWN_HOSTS: readonly string[] = ["github.com", "registry.npmjs.org", "localhost"];
export const KNOWN_HOSTS_FILE = "known-hosts.json";

/** A host name in comparable form: lowercase, no brackets, no trailing dot, no port; "" when it is not a plain host name. */
export function normHost(s: string): string {
  let h = s.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined); // [::1]:8080 -> ::1
  else if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(":")); // host:port
  h = h.replace(/\.+$/, "");
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || /^[0-9a-f:]{2,39}$/.test(h) ? h : "";
}

/** The list as stored, or the defaults when there is no usable file. */
export function knownHosts(dataDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, KNOWN_HOSTS_FILE), "utf8")) as { hosts?: unknown };
    if (v && Array.isArray(v.hosts)) return [...new Set(v.hosts.filter((x): x is string => typeof x === "string").map(normHost).filter(Boolean))];
  } catch {
    /* no file yet, or unreadable: the defaults */
  }
  return [...DEFAULT_KNOWN_HOSTS];
}

/** Write the whole list (atomic rename). Returns the list as saved. */
export function saveKnownHosts(dataDir: string, hosts: readonly string[]): string[] {
  const list = [...new Set(hosts.map(normHost).filter(Boolean))].sort();
  const file = join(dataDir, KNOWN_HOSTS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ hosts: list }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return list;
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/;

/**
 * Whether `host` is on the list: the same name, or a subdomain of a listed name (api.github.com under github.com).
 * "localhost" on the list also covers 127.x.x.x and ::1.
 */
export function isKnownHost(host: string, list: readonly string[]): boolean {
  const h = normHost(host);
  if (!h) return false;
  if (list.includes("localhost") && (h === "localhost" || h.endsWith(".localhost") || LOOPBACK.test(h))) return true;
  return list.some((k) => h === k || h.endsWith("." + k));
}

/** The host of a URL ("" when it has none or is not a URL). */
export function urlHost(u: string): string {
  try {
    return normHost(new URL(u.trim()).hostname);
  } catch {
    return "";
  }
}
