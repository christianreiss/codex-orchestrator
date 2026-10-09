/* ── motion ──────────────────────────────────────────────────────────────── */

const reduceMotion =
  typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

export function prefersReducedMotion(): boolean {
  return reduceMotion?.matches ?? false;
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/* ── time ────────────────────────────────────────────────────────────────── */

export function clockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "4m", "2h" — used for "still waiting 4m" and the last-heartbeat line. */
export function shortAge(from: string, now: number): string {
  const started = Date.parse(from);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

/* ── code copy ───────────────────────────────────────────────────────────── */

/**
 * Appends a copy button to each rendered code block. The class is styled in
 * styles.css rather than set inline, because the CSP blocks style attributes.
 */
export function attachCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre:not([data-copy])")) {
    pre.dataset.copy = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("click", () => {
      void navigator.clipboard?.writeText(pre.innerText.replace(/^Copy\n?/, ""));
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
    pre.appendChild(button);
  }
}

/* ── notifications ───────────────────────────────────────────────────────── */
