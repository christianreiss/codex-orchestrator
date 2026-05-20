/**
 * Theme store. Wraps mode-watcher's `setMode` API with a Svelte-idiomatic
 * writable that also persists the user's choice to localStorage so the
 * inline FOUC-prevention script in app.html can apply it before mount.
 */
import { writable, type Readable } from "svelte/store";
import { browser } from "$app/environment";
import { setMode, mode } from "mode-watcher";
import { getTheme } from "$lib/api/account";

export type ThemeChoice = "light" | "dark" | "system";
export type ThemePalette = "auto-pink" | "bright-pink" | "dark-pink";

const STORAGE_KEY = "codex.theme";
const PALETTE_STORAGE_KEY = "codex.theme.palette";

function isPalette(v: string | null | undefined): v is ThemePalette {
  return v === "auto-pink" || v === "bright-pink" || v === "dark-pink";
}

function applyPaletteAttr(value: ThemePalette | null): void {
  if (typeof document === "undefined") return;
  if (value) {
    document.body.setAttribute("data-theme", value);
  } else {
    document.body.removeAttribute("data-theme");
  }
}

/** Persist + apply the palette accent on top of the base light/dark mode. */
export function setPalette(value: ThemePalette | null): void {
  if (!browser) return;
  try {
    if (value) localStorage.setItem(PALETTE_STORAGE_KEY, value);
    else localStorage.removeItem(PALETTE_STORAGE_KEY);
  } catch {
    /* ignore quota errors */
  }
  applyPaletteAttr(value);
}

/**
 * Hydrate the palette accent from localStorage and reconcile against the
 * server-persisted preference. Called from the root layout once auth is
 * resolved so the colour applies from the first authenticated render.
 */
export async function hydratePalette(): Promise<void> {
  if (!browser) return;
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isPalette(stored)) applyPaletteAttr(stored);
  } catch {
    /* ignore storage errors */
  }
  try {
    const { theme } = await getTheme();
    if (isPalette(theme)) setPalette(theme);
    else setPalette(null);
  } catch {
    /* server fetch optional — keep whatever localStorage gave us */
  }
}

function readStored(): ThemeChoice {
  if (!browser) return "system";
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

const store = writable<ThemeChoice>(readStored());

if (browser) {
  // Apply current value on init.
  const initial = readStored();
  try {
    setMode(initial);
  } catch {
    /* ignore — mode-watcher needs ModeWatcher mounted; fallback handled below */
  }
}

export const themeStore: Readable<ThemeChoice> = { subscribe: store.subscribe };

/** Programmatically change the theme. Persists + applies via mode-watcher. */
export function setTheme(value: ThemeChoice): void {
  store.set(value);
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore quota errors */
  }
  try {
    setMode(value);
  } catch {
    // mode-watcher not mounted yet — apply class directly as a fallback.
    const root = document.documentElement;
    const isDark =
      value === "dark" ||
      (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
  }
}

/** Re-export mode-watcher's current resolved mode for consumers. */
export const resolvedMode = mode;
