/** Neutral light, dark, and system theme state with legacy preference migration. */
import { writable } from "svelte/store";
import { browser } from "$app/environment";
import { setMode } from "mode-watcher";
import { getTheme } from "$lib/api/account";

export type ThemeChoice = "light" | "dark" | "system";
export type LegacyThemeChoice = "auto-pink" | "bright-pink" | "dark-pink";

const STORAGE_KEY = "codex.theme";
const LEGACY_PALETTE_KEY = "codex.theme.palette";

export function normalizeThemeChoice(value: string | null | undefined): ThemeChoice | null {
  if (value === "light" || value === "dark" || value === "system") return value;
  if (value === "auto" || value === "auto-pink") return "system";
  if (value === "bright-pink") return "light";
  if (value === "dark-pink") return "dark";
  return null;
}

function readStored(): ThemeChoice {
  if (!browser) return "system";
  try {
    const direct = normalizeThemeChoice(localStorage.getItem(STORAGE_KEY));
    const legacyPalette = normalizeThemeChoice(localStorage.getItem(LEGACY_PALETTE_KEY));
    const resolved = direct ?? legacyPalette ?? "system";
    if (localStorage.getItem(STORAGE_KEY) !== resolved) localStorage.setItem(STORAGE_KEY, resolved);
    if (localStorage.getItem(LEGACY_PALETTE_KEY) !== null) localStorage.removeItem(LEGACY_PALETTE_KEY);
    return resolved;
  } catch {
    return "system";
  }
}

const store = writable<ThemeChoice>(readStored());

if (browser) {
  try { setMode(readStored()); } catch { /* ModeWatcher mounts after module evaluation. */ }
}

export function setTheme(value: ThemeChoice): void {
  store.set(value);
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
    localStorage.removeItem(LEGACY_PALETTE_KEY);
  } catch { /* storage is optional */ }
  try {
    setMode(value);
  } catch {
    const dark = value === "dark" || (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }
}

/** Reconciles local state with the server while accepting legacy persisted values. */
export async function hydrateTheme(): Promise<void> {
  if (!browser) return;
  const local = readStored();
  setTheme(local);
  try {
    const remote = normalizeThemeChoice((await getTheme()).theme);
    if (remote) setTheme(remote);
  } catch {
    // Offline startup keeps the local choice.
  }
}

export { store as themeStore };
