// `monomem setup --verify`: for each app setup wrote an entry into, start THAT entry's real command line over stdio (read back from
// the app's own config file), do the MCP handshake, list the tools, then save, search and archive one probe note.
//
// Safety: the child runs against a THROWAWAY store. Its environment is the SDK's small default one plus the entry's own env, minus
// every MONOMEM_* / ONEMEMORY_* variable except MONOMEM_CLIENT and MONOMEM_TOOLS, plus a temp MONOMEM_HOME, ONEMEMORY_HOME,
// MONOMEM_DB_PATH and MONOMEM_AUDIT_LOG. The real store is never opened. The temp folder is deleted afterwards.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { classifyEntry, detectClients, findServers, readTextFile, readTomlEntry, safeParseEntry, serversKey, type SetupEnv, type SetupIO } from "../setup.js";
import { findTable } from "../toml-table.js";
import { stdView } from "./targets.js";

export interface VerifyResult {
  client: string;
  label: string;
  file: string;
  command: string;
  status: "PASS" | "FAIL" | "SKIP";
  /** The step that failed (or the last one that passed). */
  step: string;
  detail: string;
  /** Plain words: what to do. */
  hint: string;
}

const KEEP_ENV = new Set(["MONOMEM_CLIENT", "MONOMEM_TOOLS"]);
const NAMES = { save: ["memory_save", "state_write"], search: ["memory_search", "state_search"], archive: ["memory_archive", "state_delete"] } as const;
const STEP_MS = 30_000;
const NPX_MS = 120_000;

/** The Monomem stdio entries an app's config holds: {command, args, env}, or an HTTP one (no command). */
export function monomemEntries(text: string, id: string): Array<Record<string, unknown>> {
  if (id === "codex") {
    const table = findTable(text, ["mcp_servers", "monomem"]);
    return table ? [readTomlEntry(text.slice(table.start, table.end))] : [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const s of findServers(text, id === "claude-code", serversKey(id as never, text))) {
    const raw = safeParseEntry(text, s);
    const entry = raw && stdView(raw);
    if (entry && classifyEntry(s.name, entry) === "monomem") out.push(entry);
  }
  return out;
}

/** The environment the probe server gets (exported for the tests): the entry's env without any real data location. */
export function probeEnv(entryEnv: unknown, dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (entryEnv && typeof entryEnv === "object") {
    for (const [k, v] of Object.entries(entryEnv as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      if (/^(MONOMEM|ONEMEMORY)_/i.test(k) && !KEEP_ENV.has(k)) continue;
      env[k] = v;
    }
  }
  return { ...env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), MONOMEM_AUDIT_LOG: join(dir, "audit.log") };
}

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(text.slice(text.indexOf("{")));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function fix(file: string, why: string): string {
  return `${why} Run \`monomem setup\` again to rewrite the entry, or fix it by hand in ${file}; \`monomem check --setup\` says what is wrong.`;
}

/** Probe one entry. Never throws. */
async function probe(entry: Record<string, unknown>, file: string, timeoutMs?: number): Promise<Pick<VerifyResult, "status" | "step" | "detail" | "hint">> {
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const fail = (step: string, detail: string, hint: string) => ({ status: "FAIL" as const, step, detail, hint });
  if (!command) return { status: "SKIP", step: "start", detail: "this entry connects over HTTP with a key, not a command", hint: "Start the server (`monomem start`) and check the app's MCP panel." };
  if (isAbsolute(command) && !existsSync(command)) return fail("start", `the program ${command} does not exist`, fix(file, "The app points at a program that is gone (node moved or uninstalled?)."));
  const script = args.find((a) => isAbsolute(a) && /\.(c|m)?js$/i.test(a));
  if (script && !existsSync(script)) return fail("start", `the file ${script} does not exist`, fix(file, "The app points at an old Monomem install."));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = mkdtempSync(join(tmpdir(), "monomem-verify-"));
  const slow = /(^|[\\/])(npx|cmd)(\.cmd|\.exe)?$/i.test(command) || args.includes("npx");
  const ms = timeoutMs ?? (slow ? NPX_MS : STEP_MS);
  const transport = new StdioClientTransport({ command, args, env: probeEnv(entry.env, dir), cwd: dir, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-400)));
  const client = new Client({ name: "monomem-setup-verify", version: "1.0.0" });
  let step = "start (initialize)";
  const tail = (): string => (stderr.trim() ? ` The program said: ${stderr.trim().split(/\r?\n/).slice(-2).join(" / ")}` : "");
  try {
    await client.connect(transport, { timeout: ms });
    step = "tools/list";
    const names = (await client.listTools(undefined, { timeout: ms })).tools.map((t) => t.name);
    const pick = (k: keyof typeof NAMES): string | undefined => NAMES[k].find((n) => names.includes(n));
    const [save, search, archive] = [pick("save"), pick("search"), pick("archive")];
    if (!save || !search || !archive) return fail(step, `the server lists ${names.length} tools but not ${[!save && "save", !search && "search", !archive && "archive"].filter(Boolean).join("/")}`, fix(file, "The server started but does not offer the memory tools (MONOMEM_TOOLS in the entry?)."));
    const token = `verify-${randomBytes(6).toString("hex")}`;
    const call = async (name: string, a: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: a }, undefined, { timeout: ms })) as { isError?: boolean; content?: Array<{ text?: string }> };
      const text = r.content?.[0]?.text ?? "";
      if (r.isError) throw new Error(`${name} answered: ${text.slice(0, 200)}`);
      return text;
    };
    step = `${save} (a probe note)`;
    const saved = parseJson(await call(save, { title: `setup verify ${token}`, body: `Probe note ${token}. Safe to delete; it lives in a throwaway store.`, namespace: "setup-verify" }));
    const noteId = (saved?.note as { id?: unknown } | undefined)?.id ?? saved?.id;
    const id = Number(noteId);
    if (!Number.isInteger(id)) throw new Error(`${save} gave no note id`);
    step = `${search}`;
    const found = await call(search, { query: token, namespace: "setup-verify" });
    if (!found.includes(token)) throw new Error(`${search} did not find the note just saved`);
    step = `${archive}`;
    await call(archive, { id });
    return { status: "PASS", step: "initialize, tools/list, save, search, archive", detail: `${names.length} tools; probe note saved, found and archived in a throwaway store`, hint: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /timed out|timeout/i.test(msg);
    return fail(
      step,
      `${msg.slice(0, 200)}${tail()}`,
      timedOut ? fix(file, `No answer within ${Math.round(ms / 1000)} seconds${slow ? " (npx may be downloading Monomem: run `npx -y monomem --version` once, then verify again)" : ""}.`) : /ENOENT|not recognized|not found/i.test(msg + stderr) ? fix(file, `The command \`${command}\` was not found.`) : fix(file, "The server started or tried to, then stopped or refused.")
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Probe every Monomem entry in every detected app's config. `only` limits it to those client ids. */
export async function verifyClients(e: SetupEnv, only?: string[], timeoutMs?: number): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const seen = new Set<string>();
  for (const t of detectClients(e)) {
    if (!t.exists || (only?.length && !only.includes(t.id))) continue;
    let entries: Array<Record<string, unknown>> = [];
    try {
      const text = readTextFile(t.file);
      entries = text ? monomemEntries(text, t.id) : [];
    } catch (err) {
      out.push({ client: t.id, label: t.label, file: t.file, command: "", status: "FAIL", step: "read the config", detail: (err as Error).message, hint: `Open ${t.file}, fix the error above, then run \`monomem setup\`.` });
      continue;
    }
    for (const entry of entries) {
      const command = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((x) => typeof x === "string").join(" ");
      const key = `${t.file}\0${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ client: t.id, label: t.label, file: t.file, command, ...(await probe(entry, t.file, timeoutMs)) });
    }
  }
  return out;
}

/** Print the results; 0 when nothing failed (and something ran or was skipped on purpose), else 1. */
export async function runVerify(e: SetupEnv, io: SetupIO, only?: string[], timeoutMs?: number): Promise<number> {
  io.out("\nVerifying each connected app by starting the command in its own config (a throwaway store; your notes are not touched):");
  const results = await verifyClients(e, only, timeoutMs);
  if (!results.length) {
    io.err("Nothing to verify: no app config holds a Monomem entry. Run `monomem setup` first.");
    return 1;
  }
  for (const r of results) {
    io.out(`  ${r.status}  ${r.label}  ${r.file}`);
    io.out(`        ${r.status === "PASS" ? r.detail : `${r.step}: ${r.detail}`}`);
    if (r.hint) io.out(`        Fix: ${r.hint}`);
  }
  const bad = results.filter((r) => r.status === "FAIL").length;
  io.out(bad ? `\n${bad} of ${results.length} failed.` : `\nAll ${results.length} checked entries work.`);
  return bad ? 1 : 0;
}
