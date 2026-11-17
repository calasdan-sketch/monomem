// The trust and review commands: `trust`, `token`, `quarantine`, `confirm`, `review`, `approve-first`. Moved out of cli.ts
// unchanged. Untrusted text goes through printable(), as it did in cli.ts once main() had loaded security.js.

import { requireOperator } from "../operator-gate.js";
import { describeFindings } from "../lint-describe.js"; // not lint.js: that loads config.js before bench moves MONOMEM_HOME
import { parseFlags, str } from "./shared.js";
import { printable } from "../security.js";

function trustHelp(): void {
  console.log(
    [
      "monomem trust: whom this store does not believe.",
      "",
      "  trust [list] [--json]                    the distrust list, trusted attesters, recent changes, this server's id",
      "  trust identity [--json]                  this server's id and public key (creates the signing key if needed)",
      "  trust distrust <writer> --namespace <ns|'*'> [--force]     leave a writer's notes out of every read and never run them",
      "        A name with no notes that is close to one that has some is refused with a 'Did you mean'; --force saves it as typed.",
      "  trust undistrust <writer> --namespace <ns|'*'>",
      "        <writer> is an app key's name, or a writer id <server_id>/<label>. Quote the star: --namespace '*'.",
      "  trust probation [--json]                 writers Monomem saw for the first time: labelled \"new writer\", not a second source yet",
      "  trust confirm-writer <name>              end a new writer's probation (a person only). See docs/trust.md \"New writers\".",
      "  trust attester-add <public-key> --server-id <id> [--label text] [--not-after <ISO time>] [--any-server]",
      "        Believe signed exports from that server. A key is trusted for ONE server (--server-id);",
      "        --any-server accepts a key for any server id (discouraged). --not-after ends trust in the key",
      "        at that time: afterwards it is believed for nothing, old exports too (re-import first, or keep the key without it). A key starting with '-': --public-key <key>.",
      "  trust attester-remove <key-id>",
      "  trust attester-revoke <key-id> [--reason text]   stop believing anything signed by that key, whatever date it claims",
      "        (not_after only EXPIRES trust; a leaked key needs revoking). trust attester-unrevoke <key-id> undoes it.",
      "  trust export-key --out <file>            copy this server's signing key (mode 0600) to move its identity",
      "  trust rotate [--keep-old-private]        make a new signing key. The old PUBLIC key is recorded so this server still",
      "        recognises its earlier exports; the old private key is deleted unless --keep-old-private.",
      "        Running servers switch to the new key at their next signed export, no restart needed.",
      "",
      "Attestations (signed exports), cross-server writer ids, `rotate` and `--any-server` are EXPERIMENTAL:",
      "their wire format and commands may change. See docs/trust.md.",
    ].join("\n")
  );
}

// `monomem trust ...`: the trust policy (docs/trust.md). Local, like every CLI command.
/** R2-08: what happened to each writer's writes in the last 30 days. Counts only: Monomem holds or hides nothing because of them. */
function printWriterRecord(r: Record<string, { quarantined: number; rejected: number; rolled_back: number; flags_upheld: number; superseded: number }>): void {
  const writers = Object.keys(r).sort();
  if (!writers.length) return void console.log("Writer record, last 30 days: nothing held, rejected, rolled back or replaced.");
  console.log("Writer record, last 30 days (counts only; nothing is held or hidden because of them):");
  for (const w of writers) {
    const c = r[w];
    console.log(`  ${printable(w, 60)}: held by the linter ${c.quarantined}, rejected by a person ${c.rejected}, rolled back ${c.rolled_back}, flags upheld ${c.flags_upheld}, replaced by someone else ${c.superseded}`);
  }
}

export async function trustCmd(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.some((a) => a === "--help" || a === "-h") || args[0] === "help") {
    trustHelp();
    return;
  }
  const { DB_PATH } = await import("../config.js");
  const { Store, ValidationError } = await import("../store.js");
  const { flags, rest } = parseFlags(args, {
    values: ["namespace", "server-id", "label", "public-key", "writer", "key-id", "not-after", "out", "reason"],
    bools: ["json", "any-server", "keep-old-private", "force"],
  });
  const action = rest[0] ?? "list";
  const known = ["list", "probation", "confirm-writer", "identity", "distrust", "undistrust", "attester-add", "attester-remove", "attester-revoke", "attester-unrevoke", "export-key", "rotate"];
  if (!known.includes(action)) {
    console.error(`Unknown trust action: ${action}\n`);
    trustHelp();
    process.exit(1);
  }
  const maxRest = action === "list" || action === "probation" || action === "identity" || action === "rotate" || action === "export-key" ? 1 : 2;
  if (rest.length > maxRest) {
    console.error(
      `Unexpected extra argument(s): ${rest.slice(maxRest).map((x) => JSON.stringify(x.slice(0, 40))).join(" ")}. ` +
        "If you typed --namespace * the shell expanded the star into file names: write --namespace '*'."
    );
    process.exit(1);
  }
  const nsFlag = str(flags.namespace);
  if (nsFlag && nsFlag !== "*") {
    const { existsSync } = await import("node:fs");
    if (existsSync(nsFlag)) {
      console.error(`Note: "${nsFlag}" is also a file or folder in this directory. If you meant every namespace, quote the star: --namespace '*'.`);
    }
  }
  const store = new Store(DB_PATH);
  const show = (v: unknown, text: string): void => console.log(flags.json ? JSON.stringify(v, null, 2) : text);
  try {
    switch (action) {
      case "list": {
        // Read-only: never creates the signing key.
        const identity = store.peekIdentity();
        const view = store.trustView();
        const reputation = store.writerReputation();
        const out = { ...identity, distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log, writer_record_30d: reputation };
        if (flags.json) {
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        printWriterRecord(reputation);
        console.log(`This server: ${identity.server_id}${identity.key_id ? ` (signing key ${identity.key_id})` : " (no signing key yet: `monomem trust identity` creates it)"}`);
        console.log(`Distrusted writers (${out.distrust.length}):`);
        for (const r of out.distrust) console.log(`  [${r.namespace}] ${r.writer}  (added ${r.added_at} by ${r.added_by})`);
        console.log(`Trusted attesters (${out.attesters.length}):`);
        for (const a of out.attesters) {
          console.log(
            `  ${a.key_id} server=${a.server_id || "(ANY - unpinned)"} ${a.label ? `"${a.label}" ` : ""}${a.not_after ? `not_after=${a.not_after} ` : ""}[${a.source}]`
          );
        }
        if (out.revoked.length) {
          console.log(`Revoked keys (${out.revoked.length}):`);
          for (const r of out.revoked) console.log(`  ${r.key_id}  (revoked ${r.at} by ${r.by}${r.reason ? `: ${r.reason}` : ""})`);
        }
        if (out.log.length) {
          console.log("Recent changes:");
          for (const l of out.log) console.log(`  ${l.at} ${l.actor} ${l.action} [${l.namespace}] ${l.subject}`);
        }
        return;
      }
      case "export-key": {
        const out = str(flags.out);
        if (!out) {
          console.error("Usage: monomem trust export-key --out <file>");
          process.exit(1);
        }
        const r = store.exportSigningKey(out!);
        show(r, `Copied signing key ${r.key_id} to ${r.path} (${process.platform === "win32" ? "Windows: file modes do not apply, so protect the folder's permissions" : "mode 0600"}). Guard it: whoever holds it can sign as this server. Do not run two live servers with the same key.`);
        return;
      }
      case "rotate": {
        const r = store.rotateSigningKey({ keepOldPrivate: flags["keep-old-private"] === true });
        show(
          r,
          `New signing key ${r.new_key_id}${r.old_key_id ? ` (replaces ${r.old_key_id})` : ""}.\n` +
            (r.old_key_id
              ? `The old PUBLIC key is recorded as a retired key of this server, so exports it signed still verify here. ` +
                (r.old_key_file ? `The old private key was kept as ${r.old_key_file} (guard it or delete it).` : "The old private key was deleted.") +
                "\nIf the old key LEAKED, also run: monomem trust attester-revoke " + r.old_key_id + " (and tell your peers to do the same).\n"
              : "") +
            "Running servers and MCP processes pick up the new key at their next signed export; no restart is needed.\n" +
            `Give the new public key to the peers that verify this server's exports:\n  monomem trust attester-add --public-key ${r.public_key} --server-id ${store.serverId()}\n` +
            (r.old_key_id ? "A peer keeps believing the old key until it removes it (attester-remove) or revokes it (attester-revoke); not_after only expires trust." : "")
        );
        return;
      }
      case "identity": {
        const i = store.identity();
        show(i, `server_id:  ${i.server_id}\nkey_id:     ${i.key_id}\npublic_key: ${i.public_key}\n\nGive the public_key (and server_id) to the admin of the server that should believe this server's exports:\n  monomem trust attester-add --public-key ${i.public_key} --server-id ${i.server_id} --label "<name>"`);
        return;
      }
      case "probation": {
        const { probationList, probationSettings } = await import("../store/probation.js");
        const rows = probationList(store);
        const cfg = probationSettings(store);
        if (flags.json) return void console.log(JSON.stringify({ settings: cfg, writers: rows }, null, 2));
        console.log(cfg.notes === 0 ? "Writer probation: off (monomem settings set probation-notes 5 turns it on)." : `Writer probation: a new writer leaves it after ${cfg.notes} notes kept ${cfg.hours} hours without being replaced, archived or flagged, or when a person runs monomem trust confirm-writer <name>.`);
        const on = rows.filter((r) => r.on_probation);
        if (!on.length) return void console.log("No writer is on probation.");
        for (const r of on) console.log(`  ${printable(r.writer, 60)}: first seen ${r.first_seen_at.slice(0, 16).replace("T", " ")}, ${r.kept} of ${cfg.notes} notes kept`);
        return;
      }
      case "confirm-writer": {
        const writer = str(flags.writer) ?? rest[1];
        if (!writer) {
          console.error("Usage: monomem trust confirm-writer <name>   (the name monomem trust probation lists)");
          process.exit(1);
        }
        await requireOperator(`trust confirm-writer ${writer}`);
        const { confirmWriter } = await import("../store/probation.js");
        const r = confirmWriter(store, writer!, "cli");
        if (!r) {
          console.error(`Monomem has no record of a writer named "${printable(writer!, 60)}". monomem trust probation lists the new ones.`);
          process.exit(1);
        }
        show(r, `${printable(writer!, 60)} is no longer on probation: its notes lose the "new writer" label and it counts as a second source.`);
        return;
      }
      case "distrust":
      case "undistrust": {
        const writer = str(flags.writer) ?? rest[1];
        if (!writer) {
          console.error(`Usage: monomem trust ${action} <writer> --namespace <ns|*>   (writer: an app key's name or <server_id>/<label>; --writer <w> or -- <w> if it starts with "-")`);
          process.exit(1);
        }
        const ns = str(flags.namespace);
        if (!ns) {
          console.error('--namespace is required (use --namespace "*" for every namespace)');
          process.exit(1);
        }
        if (action === "distrust") {
          // "cursor" matches nothing while its notes say "stdio:cursor": refuse and suggest, never widen on our own
          // (a saved rule that hides nothing would leave the person believing the app is distrusted).
          // A near miss ("curser" for stdio:cursor) is refused the same way, like rollback's hint; --force saves it as typed.
          if (store.distrustMatchCount(ns!, writer) === 0 && !flags.force) {
            const { suggestWriter, nearWriter } = await import("../trust.js");
            const count = (w: string): number => store.distrustMatchCount(ns!, w);
            const hint = suggestWriter(writer.trim(), count) ?? nearWriter(writer.trim(), store.writerNames(), count);
            if (hint) {
              console.error(
                `No notes are written by "${printable(writer, 60)}", so nothing was saved. Did you mean "${hint.writer}" (${hint.notes} note${hint.notes === 1 ? "" : "s"})?\n` +
                  `Writer names must match exactly; \`monomem show <id>\` prints a note's "written by:".\n` +
                  `Run: monomem trust distrust ${hint.writer} --namespace ${ns === "*" ? "'*'" : printable(ns!, 100)}   (or add --force to save "${printable(writer, 60)}" as typed)`
              );
              process.exit(1);
            }
          }
          const r = store.distrustAdd(ns!, writer);
          const matched = store.distrustMatchCount(r.namespace, r.writer);
          show(
            { ...r, matched_notes: matched },
            `Distrusting "${r.writer}" in [${r.namespace}]: its notes are now left out of every read and never run (${matched} existing note(s) match` +
              `${matched === 0 ? ' - none yet: check the spelling against the "written by:" line of a note (`monomem show <id>`): labels are exact and case-sensitive' : ""}).`
          );
        } else {
          await requireOperator(`trust undistrust ${writer} [${ns}]`);
          const removed = store.distrustRemove(ns!, writer);
          show({ removed }, removed ? `No longer distrusting "${writer}" in [${ns}].` : `"${writer}" was not on the list for [${ns}].`);
        }
        return;
      }
      case "attester-add": {
        const key = str(flags["public-key"]) ?? rest[1];
        if (!key) {
          console.error("Usage: monomem trust attester-add <public-key> --server-id <id> [--label <text>] [--not-after <ISO time>] [--any-server]   (a key starting with \"-\": --public-key <key>)");
          process.exit(1);
        }
        await requireOperator("trust attester-add");
        const r = store.attesterAdd({
          public_key: key,
          server_id: str(flags["server-id"]),
          label: str(flags.label),
          any_server: flags["any-server"] === true,
          not_after: str(flags["not-after"]),
        });
        show(
          r,
          `Trusting key ${r.key_id}${r.server_id ? ` for server ${r.server_id}` : " for ANY server id (the key's holder can claim to be any peer)"}` +
            `${r.not_after ? `, until ${r.not_after} (afterwards for nothing, old exports included)` : ""}.` +
            (r.replaced ? ` (This replaced an earlier entry: pin ${r.replaced.server_id || "any"}, not_after ${r.replaced.not_after || "none"}.)` : "")
        );
        return;
      }
      case "attester-remove": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-remove <key-id>");
          process.exit(1);
        }
        const removed = store.attesterRemove(id);
        show({ removed }, removed ? `Removed key ${id}.` : `Key ${id} was not on the list (a key set in MONOMEM_TRUSTED_ATTESTERS is removed there).`);
        return;
      }
      case "attester-revoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-revoke <key-id> [--reason <text>]");
          process.exit(1);
        }
        const r = store.attesterRevoke(id, str(flags.reason) ?? "");
        show(r, r.already ? `Key ${r.key_id} was already revoked.` : `Revoked key ${r.key_id}: nothing signed by it is believed any more, whatever date the signature claims.`);
        return;
      }
      case "attester-unrevoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-unrevoke <key-id>");
          process.exit(1);
        }
        await requireOperator(`trust attester-unrevoke ${id}`);
        const removed = store.attesterUnrevoke(id);
        show({ removed }, removed ? `Key ${id} is no longer revoked (add it with attester-add if you want to trust it).` : `Key ${id} was not on the revocation list.`);
        return;
      }
      default:
        console.error(`Unknown trust action: ${action}`);
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem token add <name> --scope read|write|admin [--namespace ns] [--max public|internal|private | --no-limit] | list | remove <name> | new`:
// edits tokens.json. `--label <name>` is the same as the positional name. `add` hands out access, so it needs the operator gate;
// `list` and `remove` lower nothing. A running server notices the change within a couple of seconds (no restart).
export async function tokenCmd(): Promise<void> {
  const t = await import("../tokens-admin.js");
  const { envTokenLabels } = await import("../token-file.js");
  const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["label", "scope", "namespace", "max"], bools: ["admin", "json", "no-limit"] });
  const action = rest[0];
  const usageLine = "Usage: monomem keys add <name> [--scope read|write|admin] [--namespace ns] [--max public|internal|private | --no-limit] | keys list | keys remove <name> | keys harden";
  try {
    if (action === "new") {
      console.log(t.newTokenValue());
    } else if (action === "add") {
      const label = str(flags.label) ?? rest[1];
      if (!label) throw new t.TokenAdminError(usageLine);
      const scope = str(flags.scope);
      const asAdmin = scope === "admin" || flags.admin === true;
      const noLimit = flags["no-limit"] === true;
      await requireOperator(`keys add (${scope ?? "write"} app key "${label}"${noLimit ? ", with NO sensitivity limit" : ""})`);
      const made = t.addApp({
        label,
        ...(scope !== undefined && scope !== "admin" ? { scope } : {}),
        ...(str(flags.namespace) !== undefined ? { namespace: str(flags.namespace)! } : {}),
        ...(str(flags.max) !== undefined ? { max: str(flags.max)! } : {}),
        admin: asAdmin,
        noLimit,
      });
      console.log(t.addedReport(made, noLimit));
      console.log("Client setup (Claude Code, Cursor, Codex): INSTALL.md, section 'Connect to a shared server'.");
    } else if (action === "harden" && rest.length === 1) {
      // Raises protection (plain-text keys become hashes), so it is not operator-gated. Normally already done on first start.
      const r = t.hardenTokensFile();
      console.log(r.converted ? `Hashed ${r.converted} app key(s) in ${t.tokensPath()}. The apps keep working with the keys they already have.` : `Nothing to do: no app key is stored in plain text in ${t.tokensPath()}.`);
    } else if (action === "list" && rest.length === 1) {
      const apps = t.listApps().filter((a) => a.source === "file" || flags.json === true);
      if (flags.json === true) {
        console.log(JSON.stringify(apps, null, 2));
        return;
      }
      const fromEnv = envTokenLabels();
      if (!apps.length) console.log(`No app keys in ${t.tokensPath()} yet (the main key, which this computer uses, is not listed here).`);
      for (const a of apps) {
        const limit = a.max_sensitivity ?? "NO LIMIT (can read private notes)";
        console.log(`${printable(a.label)}  ${a.scope}${a.namespace ? `  namespace=${printable(a.namespace)}` : ""}  sees up to: ${limit}${a.source === "main" ? "  (the main key)" : ""}`);
      }
      if (fromEnv?.length) console.log(`${fromEnv.length} more app key(s) come from MONOMEM_TOKENS (labels: ${fromEnv.map((l) => printable(l, 40)).join(", ")}). They are not editable here.`);
    } else if ((action === "remove" || action === "rm") && rest.length === 2) {
      // Removing a token that is not there is not an error (the command stays scriptable), but it says so.
      console.log(
        t.removeApp(rest[1])
          ? `Removed app key "${printable(rest[1])}". A running server stops accepting it within a couple of seconds, with no restart.`
          : `No app key named "${printable(rest[1])}" in tokens.json. See the names with: monomem keys list (keys set in the environment must be removed there).`
      );
    } else {
      throw new t.TokenAdminError(usageLine);
    }
  } catch (e) {
    if (!(e instanceof t.TokenAdminError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

// `monomem quarantine [list | show <id> | approve <id> | keep-history <id> [--by <note id>] | reject <id>]`.
export async function quarantineCmd(): Promise<void> {
  const { DB_PATH } = await import("../config.js");
  const { Store, ValidationError, quarantineCasNote } = await import("../store.js");
  const { maybeEmbed } = await import("../search-service.js");
  const [action = "list", idRaw] = process.argv.slice(3);
  const store = new Store(DB_PATH);
  try {
    if (action === "list") {
      const items = store.listQuarantine({ limit: 500 });
      if (items.length === 0) {
        console.log("No held writes.");
        return;
      }
      for (const q of items) {
        const what = q.op === "update" ? `update of #${q.target_id}` : "new note";
        console.log(`#${q.id} [${printable(q.namespace, 100)}] ${what}: ${q.title == null ? "(title unchanged)" : printable(q.title)}  (${q.created_at})`);
        console.log(`    reasons: ${describeFindings(q.reasons)}`);
        if (q.body) {
          const preview = q.body.length > 200 ? q.body.slice(0, 200) + "…" : q.body;
          console.log(`    body: ${preview.replace(/\n/g, "\n          ")}`);
        }
      }
      console.log("\nTo decide: monomem review held show <id>, then approve <id> | keep-history <id> | reject <id>  (in a terminal)");
      return;
    }
    const id = Number(idRaw);
    if (!["show", "approve", "keep-history", "reject"].includes(action) || !Number.isInteger(id)) {
      console.error("Usage: monomem review held [list | show <id> | approve <id> | keep-history <id> [--by <note id>] | reject <id>]");
      process.exit(1);
    }
    if (action === "show") {
      showHeld(store, id, quarantineCasNote, (await import("../line-diff.js")).heldEditDiff);
      return;
    }
    if (action === "keep-history") {
      const byAt = process.argv.indexOf("--by");
      const by = byAt > 0 ? Number(process.argv[byAt + 1]) : undefined;
      if (by !== undefined && !Number.isInteger(by)) {
        console.error("--by takes a note id");
        process.exit(1);
      }
      await requireOperator(`review held keep-history ${id}`, () => {
        // Same checks keepQuarantineAsHistory makes, run before the typed yes: nobody confirms what cannot happen.
        const ctx = store.quarantineContext(id);
        const why = !ctx
          ? `no held write with id ${id}`
          : !ctx.notes.length
            ? `held write #${id}: nothing newer on the same topic was saved in "${printable(ctx.namespace, 100)}" since it was held, so there is nothing to keep it as history of. Approve or reject it instead.`
            : by !== undefined && !ctx.notes.some((n) => n.id === by)
              ? `note ${by} is not one of the newer related notes saved since held write #${id} was held`
              : "";
        if (!why) return;
        console.error(`Error: ${why}`);
        process.exit(1);
      });
      const kept = store.keepQuarantineAsHistory(id, by);
      await maybeEmbed(store, kept.note);
      console.log(`Kept #${id} as history -> note #${kept.note.id} "${printable(kept.note.title)}", replaced by note #${kept.superseded_by}.`);
      return;
    }
    if (action === "reject") {
      if (!store.rejectQuarantine(id)) {
        console.error(`No held write with id ${id}`);
        process.exit(1);
      }
      console.log(`Rejected held write #${id}.`);
      return;
    }
    await requireOperator(`review held approve ${id}`, () => {
      if (store.getQuarantine(id)) return;
      console.error(`no held write with id ${id}`);
      process.exit(1);
    });
    const note = store.approveQuarantine(id);
    await maybeEmbed(store, note);
    console.log(`Approved #${id} -> note #${note.id} "${printable(note.title)}"`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

/** `monomem quarantine show <id>`: the held write in full, plus what was saved in its namespace since it was held. */
function showHeld(store: import("../store.js").Store, id: number, casNote: (op: "create" | "update") => string, heldEditDiff: typeof import("../line-diff.js").heldEditDiff): void {
  const q = store.getQuarantine(id);
  const ctx = store.quarantineContext(id);
  if (!q || !ctx) {
    console.error(`No held write with id ${id}`);
    process.exit(1);
  }
  const what = q.op === "update" ? `update of #${q.target_id}` : "new note";
  console.log(`#${q.id} [${printable(q.namespace, 100)}] ${what}: ${q.title == null ? "(title unchanged)" : printable(q.title)}`);
  console.log(`    written ${q.created_at}${q.written_by ? ` by ${printable(q.written_by, 100)}` : ""}`);
  console.log(`    reasons: ${describeFindings(q.reasons)}`);
  if (q.body) console.log(`    body: ${q.body.replace(/\n/g, "\n          ")}`);
  const diff = heldEditDiff(store, q);
  if (diff.length) console.log(`    Change, line by line (- note #${q.target_id} now, + held edit):\n${diff.map((l) => "      " + l).join("\n")}`);
  if (ctx.target_changed) console.log(`    Note #${q.target_id} has changed since this edit was held, so approving it will fail.`);
  if (ctx.clears) console.log(`    Approving it also clears the note's ${ctx.clears.map((c) => (c === "forget_after" ? "forget date" : c)).join(" and ")}.`);
  const n = ctx.notes.length;
  if (n === 0) {
    console.log(`\nNothing on the same topic was saved in ${printable(q.namespace, 100)} since this was held.`);
  } else {
    console.log(`\nSince this was held, ${n} newer note${n === 1 ? "" : "s"} in ${printable(q.namespace, 100)}:`);
    for (const c of ctx.notes) console.log(`    #${c.id} "${printable(c.title)}" (${c.written_by ? `agent ${printable(c.written_by, 100)}, ` : ""}${c.updated_at.slice(0, 10)})`);
  }
  console.log(`\n${casNote(q.op)}`);
  console.log(`Decide: monomem review held approve ${id}${n ? ` | keep-history ${id}` : ""} | reject ${id}`);
}

// `monomem approve-first [<namespace> on|off]`: operator-only switch (no MCP tool sets it).
/** `monomem confirm <id> [--source <s>]`: a person's confirm (kind human), behind the operator gate. */
export async function confirmCmd(args: string[]): Promise<void> {
  const usage = 'Usage: monomem confirm <id> [--source "what you checked it against"]';
  const si = args.indexOf("--source");
  const source = si >= 0 ? args[si + 1] : undefined;
  const rest = args.filter((_, i) => si < 0 || (i !== si && i !== si + 1));
  const id = Number(rest[0]);
  if (rest.length !== 1 || !Number.isInteger(id) || id < 1 || (si >= 0 && (source === undefined || source.startsWith("--")))) {
    console.error(usage);
    process.exit(1);
  }
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const store = new Store(DB_PATH);
  try {
    const n = store.read(id); // gate-ok: the CLI is the operator
    if (!n) {
      console.error(`Error: no note with id ${id}`);
      process.exit(1);
    }
    await requireOperator(`confirm note #${id} ("${printable(n.title, 60)}")`, undefined, "person-confirm");
    const r = store.confirm(id, { source });
    if (!r) {
      console.error(`Error: no note with id ${id}`);
      process.exit(1);
    }
    console.log(printable(r.message, 400));
    if (!r.counted) process.exitCode = 1;
  } finally {
    store.close();
  }
}

/** R2-02: the notes agents flagged as looking wrong, with who flagged them and why (the operator reads this at a terminal). */
function printFlagged(list: Array<{ id: number; namespace: string; title: string; writer: string; flags: Array<{ by: string; reason: string }> }>): void {
  console.log(`${list.length} note${list.length === 1 ? "" : "s"} flagged by an agent as looking wrong:`);
  for (const f of list) {
    console.log(`  #${f.id} [${printable(f.namespace, 100)}] ${printable(f.title, 120)} (by ${printable(f.writer || "unknown", 100)})`);
    for (const x of f.flags.slice(0, 5)) console.log(`      flagged by ${printable(x.by, 60)}: "${printable(x.reason, 200)}"`);
  }
  console.log('  Keep one as it is: monomem review keep <id>. Replace it: monomem replace --old <id> --title "..." --body "..." (shows what changes, then asks).\n');
}

/** R2-03: notes whose files changed in git since they were written (the operator reads this at a terminal). */
export function printCodeChanged(list: Array<{ id: number; namespace: string; title: string; writer: string; pinned: boolean; changed: Array<{ path: string; since_commit: string }> }>): void {
  console.log(`${list.length} note${list.length === 1 ? "" : "s"} written about code that has changed since:`);
  for (const c of list) {
    console.log(`  #${c.id} [${printable(c.namespace, 100)}] ${printable(c.title, 120)} (by ${printable(c.writer || "unknown", 100)})${c.pinned ? " pinned" : ""}`);
    for (const f of c.changed.slice(0, 5)) console.log(`      ${printable(f.path, 200)} changed since commit ${printable(f.since_commit, 12)}`);
  }
  console.log('  Still right: monomem review keep <id>. Out of date: monomem replace --old <id> --title "..." --body "..." (shows what changes, then asks).\n');
}

/**
 * `monomem review [--ns <ns>] [--json] [--confirm-all [--source <s>]]`: the notes waiting for a person. Titles are shown
 * here because the reader is the operator at a terminal; they never go into session start or an MCP reply.
 */
export async function reviewCmd(args: string[]): Promise<void> {
  const { flags, rest } = parseFlags(args, { values: ["ns", "namespace", "source"], bools: ["json", "confirm-all", "step"] });
  // R2-02: `monomem review keep <id>`: a person keeps a flagged note as it is (the flags on this version are cleared).
  if (rest[0] === "keep") {
    const id = Number(rest[1]);
    if (rest.length !== 2 || !Number.isInteger(id) || id < 1) {
      console.error("Usage: monomem review keep <id>");
      process.exit(1);
    }
    await requireOperator(`keep #${id} as it is (clears the agents' flags on this version, and marks its files as checked against the code now)`, undefined, "person-confirm");
    const { DB_PATH } = await import("../config.js");
    const { Store } = await import("../store.js");
    const store = new Store(DB_PATH);
    try {
      const n = store.keepFlagged(id);
      const moved = store.refreshCodeAnchors(id); // R2-03
      if (n) console.log(`Kept #${id}: cleared ${n} flag${n === 1 ? "" : "s"}. It is back in session start unless something else holds it.`);
      if (moved) console.log(`Kept #${id}: ${moved} changed file${moved === 1 ? "" : "s"} now count as checked against the current commit.`);
      if (!n && !moved) console.log(`#${id} has no flags on its current version and no changed files. Nothing changed.`);
    } finally {
      store.close();
    }
    return;
  }
  if (rest.length ||(flags.step === true && (flags.json === true || flags["confirm-all"] === true))) {
    console.error('Usage: monomem review [--ns <namespace>] [--json] [--confirm-all [--source "what you checked"]]\n       monomem review --step [--ns <namespace>] [--source "what you checked"]   (one note at a time: y confirm, n skip, q stop)');
    process.exit(1);
  }
  const ns = typeof flags.ns === "string" ? flags.ns : typeof flags.namespace === "string" ? flags.namespace : undefined;
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const store = new Store(DB_PATH);
  try {
    const items = store.reviewList(ns !== undefined ? [ns] : undefined);
    // Held writes are decided in `monomem quarantine`, but "review" is where people look first: never a false all-clear.
    const held = store.listQuarantine({ ...(ns !== undefined ? { namespaces: [ns] } : {}), limit: 500 }).length;
    const heldLine = held ? `${held >= 500 ? "500 or more held writes wait" : held === 1 ? "1 held write waits" : `${held} held writes wait`} for your decision: monomem review held` : "";
    if (flags.step === true) {
      if (heldLine && flags.json !== true) console.log(heldLine);
      // --step walks the review list only; flagged and code-changed notes are named here, so it never gives a false all-clear.
      const scope = ns !== undefined ? [ns] : undefined;
      const nFlagged = store.flaggedList(scope).length;
      const nCode = store.codeChangedList(scope).length;
      const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
      if (nFlagged) console.log(`${plural(nFlagged, "flagged note waits", "flagged notes wait")}: monomem review`);
      if (nCode) console.log(`${plural(nCode, "note waits", "notes wait")} because the code it describes changed: monomem review`);
      if (!items.length) return void (heldLine || nFlagged || nCode || console.log("Nothing waits for review."));
      await requireOperator(`review ${items.length} note${items.length === 1 ? "" : "s"} one at a time: each y`, undefined, "person-confirm");
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let ended = false;
      rl.on("close", () => (ended = true));
      try {
        const { reviewSteps } = await import("../review-step.js");
        const source = typeof flags.source === "string" ? flags.source : undefined;
        await reviewSteps(store, items, { ask: async (q) => (ended ? null : rl.question(q).catch(() => null)), print: (l) => console.log(l) }, source);
      } finally {
        rl.close();
      }
      return;
    }
    const flagged = store.flaggedList(ns !== undefined ? [ns] : undefined);
    const codeChanged = store.codeChangedList(ns !== undefined ? [ns] : undefined);
    if (flags.json === true) {
      console.log(JSON.stringify({ notes: items, flagged, code_changed: codeChanged, held_writes: held }, null, 2));
      if (flags["confirm-all"] !== true) return;
    } else if (!items.length && !flagged.length && !codeChanged.length) {
      console.log(heldLine || "Nothing waits for review.");
      return;
    } else if (!items.length) {
      if (heldLine) console.log(heldLine);
      if (flagged.length) printFlagged(flagged);
      if (codeChanged.length) printCodeChanged(codeChanged);
      return;
    } else {
      if (heldLine) console.log(heldLine);
      if (flagged.length) printFlagged(flagged);
      if (codeChanged.length) printCodeChanged(codeChanged);
      console.log(`${items.length} note${items.length === 1 ? "" : "s"} wait for a person:`);
      for (const r of items) {
        console.log(`  #${r.id} [${printable(r.namespace, 100)}] ${printable(r.title, 120)} (by ${printable(r.writer || "unknown", 100)})`);
        console.log(`      ${printable(r.why, 300)}`);
      }
      if (flags["confirm-all"] !== true) {
        console.log("\nConfirm one after checking it: monomem confirm <id> --source \"what you checked\"");
        return;
      }
    }
    if (!items.length) return;
    const source = typeof flags.source === "string" ? flags.source : "reviewed with monomem review";
    await requireOperator(`confirm all ${items.length} notes listed above as checked ("${printable(source, 60)}")`, undefined, "person-confirm");
    let counted = 0;
    for (const r of items) {
      const res = store.confirm(r.id, { source });
      if (res?.counted) counted++;
      else if (res) console.log(`  #${r.id}: ${printable(res.message, 300)}`);
    }
    console.log(`Confirmed ${counted} of ${items.length} notes.`);
    if (counted < items.length) process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function approveFirstCmd(): Promise<void> {
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const [ns, state] = process.argv.slice(3);
  if (ns !== undefined && (!ns.trim() || (state !== "on" && state !== "off"))) {
    console.error("Usage: monomem approve-first [<namespace> on|off | --all on|off]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    if (ns === undefined) {
      const list = store.approveFirstNamespaces();
      const damaged = store.damagedTrustSettings().includes("approve_first");
      console.log(
        `All namespaces: ${damaged ? "on (the saved namespace list is damaged, so every namespace is held; set it again: monomem approve-first <namespace> on|off)" : store.approveFirstAll() ? "on (every namespace, including new ones)" : "off"}`
      );
      console.log(list.length ? `Approve-first for these namespaces: ${list.join(", ")}` : "Approve-first for individual namespaces: none.");
      return;
    }
    if (ns === "--all") {
      if (state === "off") await requireOperator("approve-first off for all namespaces");
      store.setApproveFirstAll(state === "on");
      console.log(
        state === "on"
          ? "Approve-first is on for every namespace, including ones created later: agent writes wait in `monomem review held`."
          : "Approve-first is off for all namespaces (any per-namespace setting still applies). Writes already held stay in `monomem review held`."
      );
      return;
    }
    if (state === "off") await requireOperator(`approve-first off for "${ns.trim()}"`);
    store.setApproveFirst(ns, state === "on");
    console.log(
      state === "on"
        ? `Approve-first is on for "${ns.trim()}": agent writes there now wait in \`monomem review held\`.`
        : `Approve-first is off for "${ns.trim()}". Writes already held stay in \`monomem review held\`.`
    );
  } finally {
    store.close();
  }
}
