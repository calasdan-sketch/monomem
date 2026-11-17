// `monomem stop`: end the background server `monomem open` started for this store. That server has no window (it runs
// detached and hidden, output in server.log), so without this the only way to end it was Task Manager.
// `open` records { pid, port } in server.pid beside the database (same folder as server.log); stop ends only that process,
// and only while it still answers /health on the recorded port.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function pidFile(dbPath: string): string {
  return join(dirname(resolve(dbPath)), "server.pid");
}

/** Called by `open` right after it starts the background server. */
export function recordServerPid(dbPath: string, pid: number, port: number): void {
  writeFileSync(pidFile(dbPath), JSON.stringify({ pid, port }), { mode: 0o600 });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

function readRecord(file: string): { pid: number; port: number } | undefined {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; port?: unknown };
    return Number.isInteger(r.pid) && Number(r.pid) > 0 && Number.isInteger(r.port) ? { pid: Number(r.pid), port: Number(r.port) } : undefined;
  } catch {
    return undefined;
  }
}

export async function stopCmd(): Promise<void> {
  const { DB_PATH, API_PORT } = await import("../config.js");
  const file = pidFile(DB_PATH);
  const rec = readRecord(file);
  if (!rec) {
    if (await answers(API_PORT)) {
      console.log(
        `A Monomem server is answering on port ${API_PORT}, but monomem open did not start it, so I am leaving it alone.\n` +
          "  Started in a terminal (monomem start): press Ctrl+C in that window.\n" +
          "  Running as a background service: monomem service uninstall"
      );
      process.exitCode = 1;
      return;
    }
    console.log("No Monomem server is running for this store. Nothing to stop.");
    return;
  }
  // ponytail: pid + "/health answers on its port" guards against a reused pid; a start-time check would be stricter.
  if (!alive(rec.pid) || !(await answers(rec.port))) {
    rmSync(file, { force: true });
    console.log("The server monomem open started is no longer running. Nothing to stop.");
    return;
  }
  try {
    process.kill(rec.pid);
  } catch (e) {
    console.error(`I could not stop the server (process ${rec.pid}): ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  for (let i = 0; i < 40 && alive(rec.pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(rec.pid)) {
    console.error(`The server (process ${rec.pid}) has not stopped yet. Run monomem stop again in a moment.`);
    process.exitCode = 1;
    return;
  }
  rmSync(file, { force: true });
  console.log("Stopped Monomem (the background server monomem open started). Apps connected over stdio keep working.");
}
