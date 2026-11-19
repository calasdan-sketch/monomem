// A WEAK, informational hint: did a shell command fetch something from the network? It is NOT an outside-content mark. It never
// changes a note, a taint window or the action guard (taint.ts says why shell fetches are not counted there: nearly every
// session runs curl or git). It only feeds a count in the digest, so a person can see exposure the strong mark misses.
//
// Rules, from the security review of this design:
//  - exact shell tool names only (Bash, PowerShell): the name is the hook payload's tool_name, never text the model wrote;
//  - the fetcher must be in COMMAND POSITION (start of a segment after ; && || | & newline or an open paren), so `echo curl`
//    and `grep curl x` do not count;
//  - a loopback target is ignored only when EVERY target in the segment parses (new URL) to a loopback host, so
//    `curl http://localhost@evil.com` and `curl localhost; curl evil.com` still count;
//  - no output requirement: `curl -o file` and `wget -q` fetch content and print nothing.
// Known misses (a hint, not a guarantee): obfuscation ($(echo cu)rl), other fetchers (python -c urllib, node -e fetch, nc),
// package installs, and a script that runs curl inside it. The caller classifies the raw command BEFORE it is cut to 4096 chars.
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WRAPPERS = new Set(["env", "sudo", "command", "time", "nohup", "exec", "builtin", "nice", "stdbuf"]);
const FETCHERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "start-bitstransfer"]);
const GIT_FETCH = new Set(["clone", "fetch", "pull", "ls-remote"]);
const GH_FETCH = new Set(["api", "pr", "issue", "release", "gist", "run", "search"]);
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const isShellTool = (tool: string): boolean => SHELL_TOOLS.has(tool);

/** The hostname of a URL-like token, or null when it is not one. Parsed with URL so `localhost@evil.com` is evil.com. */
function hostOf(tok: string): string | null {
  const t = tok.replace(/^["'`(]+|["'`);,]+$/g, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : /^[^\s/:@?#-][^\s/@?#]*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$|^localhost(?::\d+)?(?:[/?#]\S*)?$|^\[::1\](?::\d+)?/i.test(t) ? `http://${t}` : "";
  if (!withScheme) return null;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

const isLoopback = (h: string): boolean => h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || LOOPBACK_V4.test(h);

/** Split on shell separators outside quotes; each piece is one simple command. */
function segments(cmd: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'[^']*'|\|\||&&|[;|&\n(]|[^\s;|&()"']+/g;
  for (const m of cmd.matchAll(re)) {
    const tok = m[0];
    if (/^(\|\||&&|[;|&\n(])$/.test(tok)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(tok);
  }
  if (cur.length) out.push(cur);
  return out;
}

function commandWords(seg: string[]): string[] {
  let i = 0;
  while (i < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]) || WRAPPERS.has(seg[i].toLowerCase()) || (i > 0 && /^-/.test(seg[i]) && WRAPPERS.has(seg[i - 1].toLowerCase())))) i++;
  return seg.slice(i);
}

function segmentFetches(seg: string[]): boolean {
  const words = commandWords(seg);
  if (!words.length) return false;
  const head = words[0].replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  const sub = words.slice(1).find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
  if (head === "git") return GIT_FETCH.has(sub);
  if (head === "gh") return GH_FETCH.has(sub) || (sub === "repo" && words.some((w) => w.toLowerCase() === "clone"));
  if (!FETCHERS.has(head)) return false;
  const hosts = words.slice(1).map(hostOf).filter((h): h is string => h !== null);
  return !(hosts.length > 0 && hosts.every(isLoopback));
}

/** True when this tool call looks like a shell command that fetched from the network. */
export function isShellFetch(tool: string, command: string): boolean {
  if (!isShellTool(tool) || typeof command !== "string" || !command) return false;
  return segments(command).some(segmentFetches);
}
