// Notice apps installed later (PLAN I). While the server runs, once a day, look for the supported apps setup knows
// (setup.ts detectClients) and remember two things in <data>/app-detect.json:
//   new     apps installed since the first check that are not connected yet: "Connect / Not this one" in Settings
//   repair  connected apps whose Monomem entry would not start this version (setup.ts appEntryProblems): "Repair"
// The first check only records what is already there (setup and the Welcome screen offered those), so nobody is asked
// twice. "Not this one" (ui/settings.ts declined_apps) hides an app for good. Connect and Repair both run
// `monomem setup --only <app> --yes` (routes-ui.ts), which shows nothing here but keeps its backup and exact undo.
// Read only: this never changes an app's file. Counts and app names only reach the "Needs you" list.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// setup.ts is loaded only for a check: the "Needs you" count (also read by hooks) needs just the file below.
import type { SetupEnv } from "./setup.js";

export const APP_DETECT_FILE = "app-detect.json";
export const APP_CHECK_EVERY_MS = 86_400_000;

export interface AppItem {
  id: string;
  label: string;
  /** Repair only: why the entry would not start. */
  problem?: string;
}
export interface AppDetectState {
  checked_at: string;
  /** App ids present at the first check: never offered as new. */
  baseline: string[];
  new: AppItem[];
  repair: AppItem[];
}

export function readAppDetect(dataDir: string): AppDetectState | null {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, APP_DETECT_FILE), "utf8")) as Partial<AppDetectState>;
    if (typeof v.checked_at !== "string" || !Array.isArray(v.baseline)) return null;
    const items = (x: unknown): AppItem[] => (Array.isArray(x) ? x.filter((i): i is AppItem => !!i && typeof i.id === "string" && typeof i.label === "string") : []);
    return { checked_at: v.checked_at, baseline: v.baseline.filter((x): x is string => typeof x === "string"), new: items(v.new), repair: items(v.repair) };
  } catch {
    return null;
  }
}

/** One look at this computer's apps; writes and returns the new state. Cheap: a few dozen small file reads, no app runs. */
export async function checkApps(e: SetupEnv, dataDir: string, now: Date = new Date()): Promise<AppDetectState> {
  const { appEntryProblems, connectedApps, detectClients } = await import("./setup.js");
  const prev = readAppDetect(dataDir);
  const label = new Map<string, string>();
  for (const c of detectClients(e)) if (c.present && c.id !== "project" && !label.has(c.id)) label.set(c.id, c.label.replace(/ \(Microsoft Store\)$/, ""));
  const connected = new Set(connectedApps(e).connected.map((l) => l.replace(/ \(Microsoft Store\)$/, "")));
  const ids = [...label.keys()];
  const baseline = prev ? prev.baseline : ids;
  const fresh = ids.filter((id) => !baseline.includes(id) && !connected.has(label.get(id)!)).map((id) => ({ id, label: label.get(id)! }));
  const repair: AppItem[] = [];
  for (const line of appEntryProblems(e)) {
    // appEntryProblems names the raw label ("Claude Desktop (Microsoft Store)"); match that too.
    const m = /^(.+?)(?: \(Microsoft Store\))?: (.*)$/.exec(line);
    const id = m ? [...label].find(([, l]) => l === m[1])?.[0] : undefined;
    if (id && !repair.some((r) => r.id === id)) repair.push({ id, label: label.get(id)!, problem: m![2].trim() });
  }
  const state: AppDetectState = { checked_at: now.toISOString(), baseline, new: fresh, repair };
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${APP_DETECT_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, join(dataDir, APP_DETECT_FILE));
  return state;
}

/** The server timer's call: checks when the last check is a day old (or there is none); otherwise does nothing. */
export async function maybeCheckApps(e: SetupEnv, dataDir: string, now: Date = new Date()): Promise<AppDetectState | null> {
  const prev = readAppDetect(dataDir);
  if (prev && now.getTime() - Date.parse(prev.checked_at) < APP_CHECK_EVERY_MS) return null;
  return checkApps(e, dataDir, now);
}

/** What waits for a person, without the apps they said "Not this one" to. */
export function appsNeedingYou(dataDir: string, declined: readonly string[]): { new: AppItem[]; repair: AppItem[] } {
  const s = readAppDetect(dataDir);
  if (!s) return { new: [], repair: [] };
  return { new: s.new.filter((a) => !declined.includes(a.id)), repair: s.repair };
}
