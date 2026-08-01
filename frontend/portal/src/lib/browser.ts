import type { EventRow } from "$lib/portal/types";
import { eventText } from "$lib/portal/grouping";

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

/* ── favicon badge ───────────────────────────────────────────────────────── */

let faviconLink: HTMLLinkElement | null = null;
let faviconKey = "";

function tokenColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
}

/**
 * Repaints the tab icon with an unread badge.
 *
 * A canvas data: URI is used because `img-src 'self' data:` permits it while
 * an injected <style> or external image would be blocked. Badge colour is read
 * from the live tokens so it tracks light/dark.
 */
export function paintFavicon(needsYou: number, unread: number): void {
  const key = `${needsYou}|${unread}|${matchMedia?.("(prefers-color-scheme: dark)").matches}`;
  if (key === faviconKey) return;
  faviconKey = key;

  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const gradient = ctx.createLinearGradient(8, 6, 56, 58);
  gradient.addColorStop(0, "#4f46e5");
  gradient.addColorStop(0.52, "#7c3aed");
  gradient.addColorStop(1, "#db2777");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(2, 2, 60, 60, 18);
  ctx.fill();

  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(18, 32);
  ctx.lineTo(27, 32);
  ctx.moveTo(27, 32);
  ctx.lineTo(46, 20);
  ctx.moveTo(27, 32);
  ctx.lineTo(46, 44);
  ctx.stroke();

  if (needsYou > 0 || unread > 0) {
    ctx.fillStyle = needsYou > 0 ? tokenColor("--destructive", "#dc2626") : tokenColor("--primary", "#2563eb");
    ctx.beginPath();
    ctx.arc(46, 46, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(needsYou > 0 ? "!" : unread > 99 ? "99" : String(unread), 46, 47);
  }

  if (!faviconLink) {
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon";
    document.head.appendChild(faviconLink);
  }
  faviconLink.href = canvas.toDataURL("image/png");
}

/* ── notifications ───────────────────────────────────────────────────────── */

let notifyBroken = false;
const lastNotifiedAt = new Map<string, number>();
const NOTIFY_THROTTLE_MS = 30_000;

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (notifyBroken || typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Must be called from a click handler; browsers reject a bare page-load ask. */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

/**
 * Fires only while the tab is hidden. Coalesced per session so a chatty agent
 * replaces its own notice instead of stacking a dozen.
 *
 * Nothing leaves the machine: this is window.Notification, with no push
 * service and no network call.
 */
export function notify(event: EventRow, title: string, onClick: () => void, now: number): void {
  if (notifyBroken || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState !== "hidden") return;
  const last = lastNotifiedAt.get(event.session_id) ?? 0;
  if (now - last < NOTIFY_THROTTLE_MS) return;
  lastNotifiedAt.set(event.session_id, now);

  try {
    // On some mobile browsers the constructor throws because notifications are
    // only available through a service worker registration. Disable for good.
    const notification = new Notification(title, {
      body: eventText(event).slice(0, 160),
      tag: `fleet:${event.session_id}`,
    });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    notifyBroken = true;
  }
}
