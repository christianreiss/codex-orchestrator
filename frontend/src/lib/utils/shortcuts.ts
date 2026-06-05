/**
 * Single-key shortcut handler. Chord-style shortcuts are intentionally
 * removed in the new WebUI — the Cmd-K palette covers their function.
 *
 * Supported keys: '?' (shortcuts modal), '/' (focus Cmd-K), 'Escape' (close
 * overlays). Modifier-combinations (Cmd-K / Ctrl-K) are handled inline by
 * +layout.svelte rather than here.
 */
export type ShortcutHandler = (event: KeyboardEvent) => void;

export interface ShortcutMap {
  "?"?: ShortcutHandler;
  "/"?: ShortcutHandler;
  n?: ShortcutHandler;
  Escape?: ShortcutHandler;
}

function isTypingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function bindGlobalShortcuts(map: ShortcutMap): () => void {
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // '?' should still trigger even when not typing — but skip when modifier-held.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      map.Escape?.(event);
      return;
    }
    if (isTypingInField(event.target)) return;
    if (event.key === "?" && map["?"]) {
      event.preventDefault();
      map["?"](event);
      return;
    }
    if (event.key === "/" && map["/"]) {
      event.preventDefault();
      map["/"](event);
      return;
    }
    if (event.key.toLowerCase() === "n" && map.n) {
      event.preventDefault();
      map.n(event);
      return;
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
