import { writable } from "svelte/store";

function createSearchModalStore() {
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

export const searchModal = createSearchModalStore();
