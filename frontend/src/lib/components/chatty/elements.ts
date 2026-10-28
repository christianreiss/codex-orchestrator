/**
 * Pure helpers for Chatty's rich reply elements. The API resolves and verifies
 * every element; these checks only refuse anything that is not a console path
 * a current server could have built, so a tampered or stale payload cannot
 * turn into an external, scheme or traversal link.
 */

/** A base-relative console path (`/hosts/7`), or null. `paths.base` is added by the caller. */
export function chattyPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  if (!/^\/[A-Za-z0-9._~%/-]*(?:\?type=[a-z-]+)?(?:#[a-z-]+)?$/.test(path)) return null;
  if (path.includes("//") || /(^|\/)\.\.?(\/|$|\?|#)/.test(path)) return null;
  // The server emits base-relative paths; an already-prefixed path would double the base.
  if (/^\/admin(?:[/?#]|$)/.test(path)) return null;
  return path;
}

interface EventLike {
  id: number;
  kind: string;
}

/**
 * Suggestions are follow-ups to the latest reply only: a chip under an older
 * answer must not send a message into a conversation that has moved on.
 */
export function latestAnswerId(events: readonly EventLike[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "answer") return event.id;
    if (event.kind === "user" || event.kind === "question" || event.kind === "action") return null;
  }
  return null;
}

/** Ordinary clicks navigate in place; modified clicks keep the browser's own behavior (new tab, window). */
export function isPlainClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
