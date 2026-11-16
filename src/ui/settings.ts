// The dashboard's own small settings file, <data dir>/ui-settings.json: what the Welcome screen asked and the person chose.
// Nothing here is a secret. Unknown keys are dropped and every value is checked on read, so a hand-edited file cannot
// switch anything on by accident.
//   welcome_done      the Welcome screen was finished (the dashboard opens on Notes after that)
//   prompt_recall     "on" | "off": notes added at each prompt (the session lane reads this when MONOMEM_PROMPT_RECALL is unset)
//   daily_backups     "on" | "off": automatic daily copies (the backup lane reads this)
//   declined_apps     app ids the person answered "Not this one" for (never offered again unless they ask)
// Also <data dir>/backup-status.json: the last automatic or manual backup ({ ok, at, dir?, error? }); a failed one counts
// toward "Needs you".
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

export type OnOff = "on" | "off";
export interface UiSettings {
  welcome_done: boolean;
  prompt_recall: OnOff;
  daily_backups: OnOff;
  declined_apps: string[];
}
export const UI_DEFAULTS: UiSettings = { welcome_done: false, prompt_recall: "off", daily_backups: "on", declined_apps: [] };

const settingsFile = (dir: string): string => join(dir, "ui-settings.json");
const statusFile = (dir: string): string => join(dir, "backup-status.json");
const onOff = (v: unknown, d: OnOff): OnOff => (v === "on" || v === "off" ? v : d);

function readJson(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function writeJson(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file); // whole-file swap: a reader never sees half a file
}

export function readUiSettings(dir: string = DATA_DIR): UiSettings {
  const raw = readJson(settingsFile(dir));
  const declined = Array.isArray(raw.declined_apps) ? raw.declined_apps.filter((x): x is string => typeof x === "string" && /^[a-z-]{1,40}$/.test(x)) : [];
  return {
    welcome_done: raw.welcome_done === true,
    prompt_recall: onOff(raw.prompt_recall, UI_DEFAULTS.prompt_recall),
    daily_backups: onOff(raw.daily_backups, UI_DEFAULTS.daily_backups),
    declined_apps: [...new Set(declined)].slice(0, 50),
  };
}

/** Checks a partial update from the page; returns the new settings, or throws with a plain message. */
export function updateUiSettings(patch: Record<string, unknown>, dir: string = DATA_DIR): UiSettings {
  const cur = readUiSettings(dir);
  const next: UiSettings = { ...cur, declined_apps: [...cur.declined_apps] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "welcome_done" && typeof v === "boolean") next.welcome_done = v;
    else if ((k === "prompt_recall" || k === "daily_backups") && (v === "on" || v === "off")) next[k] = v;
    else if (k === "declined_apps" && Array.isArray(v) && v.every((x) => typeof x === "string" && /^[a-z-]{1,40}$/.test(x))) next.declined_apps = [...new Set(v as string[])].slice(0, 50);
    else throw new Error(`Unknown setting or value: ${k.slice(0, 40)}`);
  }
  writeJson(dir, settingsFile(dir), next);
  return next;
}

/** The setting a hook reads: true only when the person switched it on here. */
export function uiSettingOn(key: "prompt_recall" | "daily_backups", dir: string = DATA_DIR): boolean {
  return readUiSettings(dir)[key] === "on";
}

export interface BackupStatus {
  ok: boolean;
  at: string;
  dir?: string;
  error?: string;
}
export function readBackupStatus(dir: string = DATA_DIR): BackupStatus | null {
  if (!existsSync(statusFile(dir))) return null;
  const raw = readJson(statusFile(dir));
  if (typeof raw.ok !== "boolean" || typeof raw.at !== "string") return null;
  return { ok: raw.ok, at: raw.at, ...(typeof raw.dir === "string" ? { dir: raw.dir } : {}), ...(typeof raw.error === "string" ? { error: raw.error.slice(0, 300) } : {}) };
}
/** Whoever makes a backup (the Settings button, the daily one) records how it went here. */
export function writeBackupStatus(s: BackupStatus, dir: string = DATA_DIR): void {
  writeJson(dir, statusFile(dir), s);
}
