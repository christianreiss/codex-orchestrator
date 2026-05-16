/**
 * Svelte action: scans the target element for `pre > code` blocks and
 * overlays a copy button in the top-right of each `<pre>`. The button
 * copies the code text to the clipboard and flips its label briefly
 * to indicate success.
 *
 * Re-runs whenever `update(html)` is called with a new content string.
 */

import type { Action } from "svelte/action";

interface CopyButtonState {
  button: HTMLButtonElement;
  cleanup: () => void;
}

const ICON_COPY = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`.trim();

const ICON_CHECK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
  <polyline points="20 6 9 17 4 12"/>
</svg>`.trim();

function createButton(getText: () => string): CopyButtonState {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "copy-btn absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground opacity-0 backdrop-blur transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:opacity-100 group-hover:opacity-100";
  button.setAttribute("aria-label", "Copy code");
  button.innerHTML = `${ICON_COPY}<span>Copy</span>`;

  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const onClick = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = getText();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      button.innerHTML = `${ICON_CHECK}<span>Copied</span>`;
      button.classList.add("text-foreground");
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.innerHTML = `${ICON_COPY}<span>Copy</span>`;
        button.classList.remove("text-foreground");
      }, 1500);
    } catch {
      button.innerHTML = `${ICON_COPY}<span>Failed</span>`;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.innerHTML = `${ICON_COPY}<span>Copy</span>`;
      }, 1500);
    }
  };

  button.addEventListener("click", onClick);

  return {
    button,
    cleanup: () => {
      if (resetTimer) clearTimeout(resetTimer);
      button.removeEventListener("click", onClick);
      button.remove();
    },
  };
}

function decorate(node: HTMLElement): CopyButtonState[] {
  const states: CopyButtonState[] = [];
  const blocks = node.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    // Ensure pre is positioned for our absolute button.
    if (getComputedStyle(pre).position === "static") {
      pre.style.position = "relative";
    }
    pre.classList.add("group");
    const state = createButton(() => code.textContent ?? "");
    pre.appendChild(state.button);
    states.push(state);
  });
  return states;
}

export const copyCodeBlocks: Action<HTMLElement, unknown> = (node) => {
  let states: CopyButtonState[] = [];

  const apply = () => {
    for (const s of states) s.cleanup();
    states = decorate(node);
  };

  // Initial pass after the parent finishes inserting children.
  queueMicrotask(apply);

  return {
    update() {
      // Re-run after the new {@html ...} content lands in the DOM.
      queueMicrotask(apply);
    },
    destroy() {
      for (const s of states) s.cleanup();
      states = [];
    },
  };
};
