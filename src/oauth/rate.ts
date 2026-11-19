// Rate limiting for the OAuth routes when a tunnel (cloudflared, ngrok, tailscale funnel) runs on the same machine.
//
// Behind a tunnel on this machine, every request reaches Monomem from 127.0.0.1. Keyed on the socket address alone, all callers
// share one bucket, so one noisy caller (or an attacker) uses up the limit and every real person is turned away.
//
//   - The operator declared a proxy (MONOMEM_TRUST_PROXY=1 or MONOMEM_TRUST_CLOUDFLARE=1): the forwarded address is the key
//     (security.clientKey does that already), so each caller has their own bucket.
//   - No proxy declared and the socket is this machine: the forwarded header is not trusted (anyone can write it), but it is
//     still used to keep callers in SEPARATE buckets, so a flood from one claimed address does not use up another's. A caller who
//     changes the header gets a fresh bucket; that is why there is also a global cap, which counts only requests that passed their
//     own bucket, so one caller cannot use it up by itself being refused.
//   - Every other case: the socket address.
import type { IncomingMessage } from "node:http";
import { clientKey, type RateLimiter } from "../security.js";

function proxyDeclared(): boolean {
  return process.env.MONOMEM_TRUST_PROXY === "1" || process.env.MONOMEM_TRUST_CLOUDFLARE === "1";
}

function isThisMachine(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** The bucket key for a request (see the file comment). */
export function oauthClientKey(req: IncomingMessage): string {
  if (proxyDeclared() || !isThisMachine(req.socket?.remoteAddress)) return clientKey(req);
  const claimed = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = (Array.isArray(claimed) ? claimed[0] : claimed)?.split(",")[0]?.trim().slice(0, 64);
  return first ? `tunnel:${first}` : "tunnel:none";
}

/** true = allowed. The per-caller bucket first; the global cap counts only requests that passed it. */
export function oauthAllow(perCaller: RateLimiter, global: RateLimiter, req: IncomingMessage): boolean {
  return perCaller.check(oauthClientKey(req)) && global.check("all");
}
