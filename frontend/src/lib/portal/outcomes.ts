/**
 * How the portal turns a failed request into something a person can act on.
 *
 * This lives beside the other pure helpers rather than inside
 * portal-state.svelte.ts because that file is written in runes and `npm test`
 * (plain `node --test`) cannot execute it. Keeping the decisions here is what
 * makes them testable at all — and they are decisions worth pinning: each one
 * exists because the old behaviour left the operator with a dead end.
 */

export interface FailureLike {
  code?: string;
  message?: string;
}

/** Codes meaning "the agent cannot be reached", whatever the reason. */
const UNREACHABLE_CODES = new Set(["agent_relay_unavailable", "agent_session_finished"]);

export type CloseOutcome = "closed" | "unreachable" | "failed";

/**
 * A cooperative close asks the agent to wrap up, which is meaningless if
 * nothing is listening. Distinguishing "unreachable" from a generic failure is
 * what lets the caller escalate to a force end instead of reporting an error
 * against which there was no next step — the force button used to live only in
 * a bar that a refused close never created.
 */
export function closeOutcome(failure: FailureLike): CloseOutcome {
  return UNREACHABLE_CODES.has(failure.code ?? "") ? "unreachable" : "failed";
}

/** The sentence shown inside the reopened force dialog. */
export function closeReasonFor(failure: FailureLike): string {
  if (failure.code === "agent_session_finished") return "This session has already ended.";
  return "This agent is not reachable, so it cannot be asked to wrap up.";
}

/**
 * A rejected fetch is not an API failure, so its `message` is whatever the
 * browser produced — "Failed to fetch", or an empty statusText under HTTP/2
 * that rendered as a blank paragraph under a "Portal unavailable" heading.
 */
export function describeFailure(failure: FailureLike, fallback: string, isApiFailure = true): string {
  if (!isApiFailure) return "Could not reach the portal. Check your connection and try again.";
  return failure.message?.trim() || fallback;
}

/**
 * Every send failure names what happened to the text. The draft is restored in
 * all cases, so saying so is accurate and removes the "did I lose it?" beat.
 */
export function sendFailureMessage(failure: FailureLike, isApiFailure = true): string {
  switch (failure.code) {
    case "already_answered":
      return "Another user already answered this prompt.";
    case "agent_relay_unavailable":
      return "This agent stopped accepting instructions before the message was queued. Your text is back in the box — or end the session from the header.";
    case "agent_session_finished":
      return "This session has ended, so nothing can be sent to it. Your text is back in the box.";
    default:
      return describeFailure(failure, "The message could not be sent.", isApiFailure);
  }
}

/** What the polite live region says, so screen readers are not left out. */
export function announcementFor(eventType: string, label: string): string {
  if (eventType === "message_canceled") return `${label}: a message you sent was not delivered.`;
  if (eventType === "waiting_input" || eventType === "attention") return `${label} needs you.`;
  return `New message from ${label}.`;
}

/** `/go#/a/<id>`, so a conversation can be bookmarked, shared and backed into. */
export function threadIdFromHash(hash: string): string {
  const match = /^#\/a\/([^/?]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]!) : "";
}

export function threadHash(id: string): string {
  return id ? `#/a/${encodeURIComponent(id)}` : "";
}
