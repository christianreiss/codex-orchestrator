/**
 * Persisted open/collapsed state for the sidebar's nav sections, so a
 * user's manual toggles survive a reload instead of resetting to defaults.
 */
import { browser } from "$app/environment";

const STORAGE_KEY = "codex:sidebar-groups";

/** Read the persisted section open-state, or null if absent/invalid/SSR. */
export function getStoredOpenGroups(): Record<string, boolean> | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    );
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

/** Persist the current section open-state. */
export function setStoredOpenGroups(groups: Record<string, boolean>): void {
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    /* ignore storage errors (e.g. private browsing) */
  }
}
