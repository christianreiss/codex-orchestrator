/**
 * Theme store. Wraps mode-watcher's `setMode` API with a Svelte-idiomatic
 * writable that also persists the user's choice to localStorage so the
 * inline FOUC-prevention script in app.html can apply it before mount.
 */
import { writable, type Readable } from "svelte/store";
import { browser } from "$app/environment";
import { setMode, mode } from "mode-watcher";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "codex.theme";

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
