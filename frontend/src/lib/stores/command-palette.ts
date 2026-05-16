/**
 * Cmd-K command palette open-state store.
 */
import { writable } from "svelte/store";

function createPaletteStore() {
  const { subscribe, set, update } = writable<{ open: boolean }>({ open: false });
  return {
    subscribe,
    open(): void {
      set({ open: true });
    },
    close(): void {
      set({ open: false });
    },
    toggle(): void {
      update((s) => ({ open: !s.open }));
    },
  };
}

export const commandPalette = createPaletteStore();
