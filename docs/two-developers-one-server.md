# Two developers, one Monomem server

Goal: two people share one Monomem, each with their own key, and anything one marks `private` stays out of the other's reach.
This uses Docker for the server, a key per person, and sensitivity limits. Read [Known limits](../README.md#known-limits) first.

## 1. Start the server

```bash
git clone https://github.com/calasdan-sketch/monomem && cd monomem
cp .env.example .env        # put a long random MONOMEM_TOKEN in .env: that is YOUR (owner) key
docker compose up -d        # dashboard at http://localhost:8790
```

The compose file only listens on this machine (`127.0.0.1`). To let a second computer in, put an authenticated tunnel in front
(Tailscale, or Cloudflare Tunnel with Access). Do not publish the port directly: see [SECURITY.md](../SECURITY.md).

## 2. Give each developer a key with a limit

```bash
docker compose exec monomem monomem token add alice --max internal
docker compose exec monomem monomem token add bob   --max internal
```

Each command prints that person's key once, a block to paste into their app, and one sentence saying what the key can and cannot see.
The running server picks the key up within a couple of seconds. List them (keys are never shown): `docker compose exec monomem monomem token list`.

`--max internal` means: sees `public` and `internal` notes, never `private` ones. Other choices: `--max public`, `--scope read`
(read only), `--namespace alice` (confined to one space). See [give-an-app-limited-access.md](./give-an-app-limited-access.md).

## 3. Each developer connects over HTTP with their own key

`monomem connect <app>` or the snippet printed in step 2 wires an app to the server's MCP address with that person's key. Apps wired the
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
3. `monomem doctor` and `monomem health` (inside the container) report keys that have no limit.

## What this does not do

- Alice and Bob each see the other's `internal` notes. If that is not what you want, use `--namespace` to give each their own space.
- It does not stop a developer who can run commands on the server machine from opening the database file.
- Keys are stored in plain text in `tokens.json` in the data volume.
- This walk-through was written from the code and the other docs; the Docker steps were not run when it was written, so report anything that differs.
