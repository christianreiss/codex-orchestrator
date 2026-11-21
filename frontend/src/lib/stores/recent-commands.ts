/**
 * Recently-invoked Cmd-K command ids, persisted to localStorage so the
 * palette can surface a "Recent" jump-back-in group on the empty-query
 * default view.
 */
import { browser } from "$app/environment";

const STORAGE_KEY = "codex:recent-commands";
const MAX_ENTRIES = 5;

/** Record that a command was invoked, moving it to the front of the list. */
export function recordRecentCommand(user: number | string | undefined, id: string): void {
  if (!browser || user == null) return;
  try {
    const next = [id, ...getRecentCommandIds(user).filter((existing) => existing !== id)].slice(
      0,
      MAX_ENTRIES,
    );
    localStorage.setItem(`${STORAGE_KEY}:${user}`, JSON.stringify(next));
  } catch {
    /* ignore storage errors (e.g. private browsing) */
  }
}

/** Read the recently-invoked command ids, most recent first. */
export function getRecentCommandIds(user: number | string | undefined): string[] {
  if (!browser || user == null) return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${user}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
