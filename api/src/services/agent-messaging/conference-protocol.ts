/**
 * The `CONF/1` wire envelope and the room-bounded message expiry.
 *
 * Part of the `agent-messaging` module; the public interface is the
 * `AgentMessagingService` facade in `../agent-messaging.ts`.
 */

import { type AgentBusConference } from '../../db/schema.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import {
  AGENT_MESSAGING_MAX_TTL_SECONDS,
  AGENT_MESSAGING_MIN_TTL_SECONDS,
} from './constants.js';

/**
 * The wire envelope: `CONF/1 <VERB> k=v ...` on the first line, free text below.
 *
 * Composed server-side so the conference id always travels with the message. A
 * relay-woken member is a fresh process whose entire context is the prompt it
 * was booted with -- if the id were left to the sender to remember to include,
 * a headless participant would have no way to call `agent_conf_join` and answer.
 *
 * Values are sanitised to a single line: the header is exactly the first line,
 * so a newline smuggled into a topic would push the body up into the header and
 * change how a peer parses the whole message.
 */
export function conferenceEnvelope(
  verb: string,
  headers: Record<string, string | number | null | undefined>,
  body: string,
): string {
  const parts = [`CONF/1 ${verb}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}=${String(value).replace(/[\r\n]+/g, ' ').trim()}`);
  }
  const header = parts.join(' ');
  const text = body.trim();
  return text ? `${header}\n${text}` : header;
}

export function conferenceInviteBody(conference: AgentBusConference, note: string): string {
  const lines = [
    `You are invited to a conference chaired by another agent.`,
    conference.topic ? `Topic: ${conference.topic}` : null,
    conference.purpose ? `Purpose: ${conference.purpose}` : null,
    '',
    `To accept, call agent_conf_join with conference_id="${conference.id}" and a short purpose`,
    `describing what you bring. The chair runs the room: it dispatches tasks and adjourns.`,
    `Reply to this message to decline.`,
    note ? `\n${note}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * A conference message must not outlive the room it belongs to, and must still
 * satisfy the bus's own TTL bounds.
 */
export function conferenceMessageExpiry(conference: AgentBusConference, now: string): string {
  const remaining = Math.ceil((Date.parse(conference.deadlineAt) - Date.parse(now)) / 1000);
  const ttl = Math.min(
    AGENT_MESSAGING_MAX_TTL_SECONDS,
    Math.max(AGENT_MESSAGING_MIN_TTL_SECONDS, Number.isFinite(remaining) ? remaining : AGENT_MESSAGING_MIN_TTL_SECONDS),
  );
  return isoOffsetSeconds(ttl);
}
