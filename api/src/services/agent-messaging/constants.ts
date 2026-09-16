/**
 * Tunables and wire constants for Agent Messaging.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

export const AGENT_MESSAGING_ENABLED_KEY = 'agent_messaging_enabled';
export const AGENT_MESSAGING_MAX_BODY_BYTES = 32 * 1024;
export const AGENT_MESSAGING_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_MESSAGING_MIN_TTL_SECONDS = 60;
export const AGENT_MESSAGING_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS = 12;
export const AGENT_MESSAGING_LEASE_SECONDS = 60;
export const AGENT_MESSAGING_RELAY_TOKEN_SECONDS = 15 * 60;
export const AGENT_MESSAGING_RECEIVE_FRESH_SECONDS = 45;
/**
 * Most addresses a single `agent_list` will return. Reachable peers are ranked
 * first, so this only ever truncates the dead tail; the reply carries `total`
 * and `truncated` so a caller is never quietly shown a partial fleet.
 */
export const AGENT_MESSAGING_LIST_LIMIT = 50;
export const AGENT_MESSAGING_WAIT_PAGE_SIZE = 100;
export const AGENT_MESSAGING_CALL_PIN_TTL_SECONDS = 10 * 60;
export const AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS = 60;
export const AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS = 60 * 60;
/** `0000`..`9999`. The PIN is read aloud off one terminal into another, so it stays four digits. */
export const AGENT_MESSAGING_CALL_PIN_SPACE = 10_000;
/** How far back a mailbox peek reports calls that expired unanswered. */
export const AGENT_MESSAGING_MISSED_WINDOW_SECONDS = 30 * 60;
export const AGENT_MESSAGING_CONFERENCE_TTL_SECONDS = 60 * 60;
export const AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS = 5 * 60;
export const AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS = 6 * 60 * 60;
/**
 * A room of eight is already 8 engine boots per broadcast round on the headless
 * path. The cap is about what a chair can actually run, not what the tables hold.
 */
export const AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS = 8;
/**
 * Messages one member may exchange with the chair before the room is out of
 * budget. The 1:1 call's sixteen-turn bound is meaningless here -- a single
 * broadcast round across five members is already ten-plus messages -- so the
 * budget is per member and the deadline is wall-clock.
 */
export const AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP = 12;
/** Shortest dispatch window. A headless task must survive at least one engine boot. */
export const AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS = 15 * 60;
export const AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS = 4 * 60 * 60;
/** Most rows a single mailbox peek will report. It runs on every turn boundary; keep it cheap. */
export const AGENT_MESSAGING_MAILBOX_PAGE_SIZE = 20;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CALL_PIN_RE = /^[0-9]{4}$/;
export const LIVE_MESSAGE_STATUSES = ['queued', 'leased', 'accepted'] as const;
export const CANCELABLE_MESSAGE_STATUSES = ['queued', 'leased'] as const;
export const TERMINAL_MESSAGE_STATUSES = ['completed', 'ambiguous', 'dead', 'expired', 'canceled'] as const;
