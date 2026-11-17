# Connect claude.ai or ChatGPT over the internet (OAuth)

**Off by default.** Most people never need this: apps on your own computer (Claude Code, Cursor, Claude Desktop) connect
with `monomem connect <app>` and never touch the internet. Read this page only if you want claude.ai on the web, the
Claude mobile app, or ChatGPT to read and write your Monomem notes.

This feature has not had its own outside security review yet. Treat it as a preview.

## What it does

claude.ai and ChatGPT add a "custom connector" (a remote MCP server) by URL and then sign in with OAuth. When you switch
this on, Monomem answers that sign-in itself, on the same port as its MCP server (8791 by default). It never uses the
dashboard port, and it adds no outside sign-in service.

- **You approve every app with a pairing code.** The browser shows a Monomem page asking whether to connect the app.
  Allow works only with a code that `monomem oauth pair` prints in a terminal on your computer. No code, no access.
- **Each approved app becomes an ordinary key.** It shows up in `monomem keys` and in the dashboard as
  `oauth:<app name>`, and `monomem keys remove "oauth:<app name>"` (or Remove in the dashboard) ends it.
- **You pick read, or read and write. Never more.** An OAuth app can never delete notes, manage keys or approve held
  notes. It sees public and internal notes, never private ones (ceiling `internal`).
- **Its notes are marked as from outside.** claude.ai and ChatGPT read the web, so every note such an app writes is
  marked "from outside" and stays unconfirmed until you confirm it (`monomem review`), like any key with `reads_outside`.
- **Keys are short-lived and stored as hashes.** The key works for one hour. The app renews it with a refresh
  token, which works once and is replaced each time. If an old refresh token is used again, Monomem assumes it was
  copied and ends that app's access. tokens.json and oauth.json hold only SHA-256 hashes, never the keys themselves.
- **Every new grant, and every grant that ends, is written to the audit log** (the app's name, scope and reason only, never a key).

## You need HTTPS that reaches this computer

claude.ai and ChatGPT only connect to `https://` addresses on the public internet. Monomem does not set this up for you,
and it stays bound to `127.0.0.1` either way. **Do not** change `MONOMEM_BIND` to `0.0.0.0` for this. Both options below
forward a public https address to `http://127.0.0.1:8791` on your computer. Each has its own account and its own terms.

| Option | What you get | Limits |
|---|---|---|
| Tailscale Funnel (`tailscale funnel 8791`) | `https://<computer>.<tailnet>.ts.net`, certificate handled by Tailscale | Beta. Public ports 443, 8443 or 10000 only. Tailscale's relays see the traffic's metadata. |
| Cloudflare Tunnel (named tunnel, see [INFRA.md](../INFRA.md)) | `https://<name>.<your domain>` | Needs a domain on Cloudflare. Cloudflare ends TLS, so Cloudflare can see the traffic. A Quick Tunnel's address changes on every restart, which breaks connected apps. |

Anyone on the internet can then reach the MCP port. Without a valid key they get `401`; failed attempts are slowed
down and rate-limited. The OAuth pages are reachable too, and they are guarded by the pairing code.

Rate limits count per caller address. Through a tunnel every caller arrives from `127.0.0.1`, so all callers share one
count, and a stranger hammering `/token` could slow down your own apps' renewals. Behind Cloudflare, set
`MONOMEM_TRUST_CLOUDFLARE=1` so each caller is counted on its own address ([configuration.md](./configuration.md)).

## Turn it on

1. Start the tunnel (above) and note its https address, for example `https://my-pc.tail1234.ts.net`.
2. In a terminal, run `monomem oauth on https://my-pc.tail1234.ts.net` and type `yes`. (It refuses to run from an
   agent's shell: a person must type the confirmation.)
3. Set `MONOMEM_ALLOWED_HOSTS=my-pc.tail1234.ts.net` for the server ([configuration.md](./configuration.md)), so it
   accepts requests under that name, and start it: `monomem start`.
4. In claude.ai: Settings, Connectors, Add custom connector, URL `https://my-pc.tail1234.ts.net/mcp`. In ChatGPT: add an
   MCP server (developer mode) with the same URL and OAuth.
5. A Monomem page opens in your browser. Check the app name and the address it returns to (`claude.ai` or
   `chatgpt.com`). Run `monomem oauth pair` in a terminal on your computer, type the code, choose read or read and write,
   and press Allow.

`monomem oauth list` shows the connected apps. `monomem oauth off` switches the OAuth pages off (they answer "not
found"); apps already connected stop within an hour, when their key expires and cannot be renewed. To end one at once:
`monomem keys remove "oauth:<name>"`.

## Details

| Address (on the MCP port) | Standard | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` and `.../oauth-protected-resource/mcp` | RFC 9728 | `resource` = `<your url>/mcp`, `authorization_servers` = `[<your url>]` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | PKCE `S256` only, client auth `none`, `iss` in responses (RFC 9207) |
| `POST /register` | RFC 7591 | https redirect addresses, or http to `localhost` / `127.0.0.1`. At most 50 apps; one nobody approved within a day is dropped. 10 per 10 minutes per address |
| `GET`/`POST /authorize` | OAuth 2.1 | Consent page. Unknown app or unregistered redirect address: an error page, never a redirect. Redirect addresses must match exactly (a `localhost` one with any port, RFC 8252). The form needs its cookie and same-origin; 60 per minute per address |
| `POST /token` | OAuth 2.1 | Form-encoded. Codes work once, for 60 seconds, only with the matching PKCE verifier and redirect address. 30 per minute per address |
| `POST /revoke` | RFC 7009 | Always `200` |
| `401` on `/mcp` | RFC 6750 | Adds `WWW-Authenticate: Bearer resource_metadata="..."` while OAuth is on |

- The key in tokens.json has `expires_at`, `reads_outside: true` and `max_sensitivity: "internal"`. The key also works on
  the REST port (on loopback only, unless you exposed that too); the same scope and ceiling apply there.
- Pairing codes: 10 characters, 10 minutes, one use. Five wrong codes burn it; make a new one.
- Authorization codes and open consent pages live in the server's memory: restarting the server cancels a sign-in
  in progress. Connected apps are not affected.
- State: `<data dir>/oauth.json` (switch, public address, apps, refresh-token hashes). Delete it, and remove the
  `oauth:` keys, to remove every trace.

## Not built (yet)

- **Client ID Metadata Documents.** The MCP spec now prefers them over registration, and claude.ai and ChatGPT both
  support them. Supporting them means Monomem fetches a URL during sign-in (an outbound call, and a server-side request
  forgery risk), so Monomem offers registration only. Both apps fall back to registration when the server does not
  advertise CIMD.
- Choosing a namespace or another ceiling on the consent page (use `monomem keys` for a key with other limits).
- A cap on how long a grant may keep renewing itself (each refresh token lasts 30 days from its last use).

## Sources (read 2026-11-17)

- MCP authorization, current revision 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
  (and its pages `authorization-server-discovery` and `client-registration`; registration is deprecated there in favour of
  Client ID Metadata Documents but still allowed)
- Claude connectors, authentication requirements: https://claude.com/docs/connectors/building/authentication
  (DCR and CIMD both supported, PKCE S256 on every request, callback `https://claude.ai/api/mcp/auth_callback`, Claude Code
  loopback redirect on any port, form-encoded `/token`, rotate refresh tokens, `invalid_grant` for a dead refresh token,
  10 s limit on discovery/registration/token, 30 s on refresh)
- ChatGPT apps, authentication: https://developers.openai.com/apps-sdk/build/auth
  (CIMD or DCR, S256 required, `resource` sent on authorize and token, `iss` per RFC 9207; with it ChatGPT uses the
  redirect `https://chatgpt.com/connector_platform_oauth_redirect`)
- Tailscale Funnel: https://tailscale.com/kb/1223/funnel
