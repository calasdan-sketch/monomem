# Two developers, one Monomem server

Goal: two people share one Monomem, each with their own key, and anything one marks `private` stays out of the other's reach.
This uses Docker for the server, a key per person, and sensitivity limits. Read [Known limits](./known-limits.md) first.

## 1. Start the server

```bash
git clone https://github.com/calasdan-sketch/monomem && cd monomem
cp .env.example .env        # put a long random MONOMEM_TOKEN in .env: that is YOUR (owner) key
docker compose up -d        # dashboard at http://localhost:8790
```

The compose file only listens on this machine (`127.0.0.1`). To let a second computer in, put an authenticated tunnel in front
(Tailscale, or Cloudflare Tunnel with Access). Do not publish the port directly: see [SECURITY.md](../SECURITY.md).

With Tailscale (both developers on the same tailnet), on the server machine:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8791    # MCP for the apps: https://<machine>.<tailnet>.ts.net/mcp
tailscale serve --bg --https=8443 http://127.0.0.1:8790   # dashboard and REST: https://<machine>.<tailnet>.ts.net:8443
tailscale serve status                                    # shows the name, e.g. devbox.tail1234.ts.net
```

Then tell Monomem that name, or every request through the tunnel is refused with `403 host not allowed`. Add it to `.env`
and restart:

```bash
echo "MONOMEM_ALLOWED_HOSTS=devbox.tail1234.ts.net" >> .env
docker compose up -d
```

`tailscale serve` only reaches devices on your tailnet (not the internet; that is `tailscale funnel`, which you do not want here).
Each request still needs a key.

## 2. Give each developer a key with a limit

```bash
docker compose exec monomem monomem keys add alice --max internal
docker compose exec monomem monomem keys add bob   --max internal
```

Each command prints that person's key once, a block to paste into their app, and one sentence saying what the key can and cannot see.
The running server picks the key up within a couple of seconds. List them (keys are never shown): `docker compose exec monomem monomem keys list`.

`--max internal` means: sees `public` and `internal` notes, never `private` ones. Other choices: `--max public`, `--scope read`
(read only), `--namespace alice` (confined to one space). See [give-an-app-limited-access.md](./give-an-app-limited-access.md).

## 3. Each developer connects over HTTP with their own key

`monomem connect <app>` or the snippet printed in step 2 wires an app to the server's MCP address with that person's key. The snippet
prints the server's own address (`http://127.0.0.1:8791/mcp`); on the other computer use the tunnel address instead
(`https://devbox.tail1234.ts.net/mcp` with the Tailscale lines above). Apps wired the
default way (`monomem setup`, stdio) have no key and are not limited: see [give-an-app-limited-access.md](./give-an-app-limited-access.md#which-apps-this-works-for).

Check who a key belongs to. PowerShell:

```powershell
Invoke-RestMethod -Headers @{ Authorization = "Bearer ALICES_KEY" } http://localhost:8790/whoami
```

## 4. What gets shared and what stays private

- A note with no label is `internal`: both developers see it, and every note says who wrote it (`alice`, `bob`).
- A note labelled `private` is invisible to both keys above: it is not found, listed, counted or named, the same as if it did not exist.
  Only your owner key (and the machine's own command line) sees it. Label one with `monomem label <id> private`, or write it with
  `sensitivity: "private"`.
- Neither developer can write above their limit or lower someone's label.

## 5. Check it worked

1. As alice, save a note and mark it private; as bob, search for its words: nothing comes back.
2. `docker compose exec monomem monomem audit --since 24h` shows who changed what.
3. `monomem check --setup` and `monomem check` (inside the container) report keys that have no limit.

## What this does not do

- Alice and Bob each see the other's `internal` notes. If that is not what you want, use `--namespace` to give each their own space.
- It does not stop a developer who can run commands on the server machine from opening the database file.
- From 1.5.0, `tokens.json` in the data volume keeps only a one-way hash of each key (older keys are hashed the first time 1.5.0 starts). Each developer's own app config still holds their key in plain text.
- What was checked (1.5.0): the image was built and run with `MONOMEM_ALLOWED_HOSTS=devbox.tail1234.ts.net`; requests under that
  name got 200 on the API and on MCP, another name got 403, and `monomem` is on the container's PATH. `token add` asks the person
  at the keyboard to confirm, so it must be run from a terminal (`docker compose exec` gives it one; a script does not). The
  `tailscale serve` lines were not run against a real tailnet. Report anything that differs.
