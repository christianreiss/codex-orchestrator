import { tick } from "svelte";

/**
 * Hand keyboard focus back to a control that was re-created or briefly disabled while its
 * save settled (a switch keyed on its confirmed state, or disabled during a refresh).
 * Waits, for at most about a second, until the element exists and is enabled.
 */
export async function restoreFocus(id: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await tick();
    const el = document.getElementById(id) as (HTMLElement & { disabled?: boolean }) | null;
    if (el && !el.disabled) {
      el.focus();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** True when `id` currently holds keyboard focus; read it before the save starts. */
export const hasFocus = (id: string): boolean => typeof document !== "undefined" && document.activeElement?.id === id;
