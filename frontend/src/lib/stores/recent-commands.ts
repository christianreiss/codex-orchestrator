/**
 * Recently-invoked Cmd-K command ids, persisted to localStorage so the
 * palette can surface a "Recent" jump-back-in group on the empty-query
 * default view.
 */
import { browser } from "$app/environment";

const STORAGE_KEY = "codex:recent-commands";
const MAX_ENTRIES = 5;

/** Record that a command was invoked, moving it to the front of the list. */
export function recordRecentCommand(id: string): void {
  if (!browser) return;
  try {
    const next = [id, ...getRecentCommandIds().filter((existing) => existing !== id)].slice(
      0,
      MAX_ENTRIES,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore storage errors (e.g. private browsing) */
  }
}

/** Read the recently-invoked command ids, most recent first. */
export function getRecentCommandIds(): string[] {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
