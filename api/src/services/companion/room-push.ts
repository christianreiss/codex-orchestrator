import { compactSummary } from './summary.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { decrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';
import { eq, inArray } from 'drizzle-orm';
import { agentRoomEvents } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { AgentRoomChat } from '../agent-room-chat/index.js';
import type { Room } from '../agent-room-chat/contracts.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';

export const ROOM_PUSH_MODES = ['follow', 'default', 'mute'] as const;
export type RoomPushMode = (typeof ROOM_PUSH_MODES)[number];
/** `request` is reserved: rooms have no operator-addressed request primitive yet. */
export type RoomPushReason = 'mention' | 'reply' | 'request' | 'follow';
/** Push-eligible room event kinds; membership notes and legacy history never notify. */
const PUSH_KINDS = new Set(['chat', 'publication']);
/** Push jobs carry their reason in the source key: `room:<eventId>:<reason>`. */
export const ROOM_SOURCE = /^room:([0-9a-f-]{36}):(mention|reply|request|follow)$/;

export interface RoomPushEvent {
  actor: string;
  kind: string;
  content: string;
  /** Actor of the event this one replies to, if any. */
  replyToActor?: string | null;
}
export interface RoomPushOperator {
  /** `admin:<id>`, the operator's own room actor key. */
  key: string;
  name: string;
}

/** Device room pushes need both room metadata and private room content capabilities. */
export function roomPushAllowed(accessLevel: string): boolean {
  return (
    roleHasCapability(accessLevel, 'agent_messaging.read') &&
    roleHasCapability(accessLevel, 'agent_messaging.reveal_content')
  );
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
/** Word-boundary, case-insensitive mention of the operator's name or `@operator`. */
export function mentionsOperator(content: string, name: string): boolean {
  const names = [name.trim(), 'operator'].filter((n) => Array.from(n).length >= 2);
  return names.some((n) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])@?${escape(n)}(?![\\p{L}\\p{N}_])`, 'iu').test(content),
  );
}

/**
 * Pure classifier. `default` notifies for replies to the operator's messages and for
 * mentions of the operator; `follow` for every message by someone else; `mute` never.
 * The operator's own messages never notify.
 */
export function roomNotificationReason(
  event: RoomPushEvent,
  mode: RoomPushMode,
  operator: RoomPushOperator,
): RoomPushReason | null {
  if (event.actor === operator.key || !PUSH_KINDS.has(event.kind) || mode === 'mute') return null;
  if (event.replyToActor && event.replyToActor === operator.key) return 'reply';
  if (mentionsOperator(event.content, operator.name)) return 'mention';
  return mode === 'follow' ? 'follow' : null;
}

/** Room events carry no explicit summary today; never derive one from content. */
export function roomPushSummary(
  reason: RoomPushReason,
  sender: string,
  title: string,
  explicit?: unknown,
): string {
  return (
    compactSummary(explicit) ??
    compactSummary(
      reason === 'mention'
        ? `${sender} mentioned you in ${title}`
        : reason === 'reply'
          ? `${sender} replied to you in ${title}`
          : reason === 'request'
            ? `${sender} asked you in ${title}`
            : `New message from ${sender} in ${title}`,
    )!
  );
}

export function decodeRoomEventBody(
  row: Pick<typeof agentRoomEvents.$inferSelect, 'bodyEnc'>,
  keyring: Keyring,
): { name?: string; content?: string; kind?: string; reply_to?: string; summary?: unknown } {
  try {
    return JSON.parse(decrypt(row.bodyEnc, keyring)) as Record<string, never>;
  } catch {
    return {};
  }
}

/** FCM data for a room push. Values are strings; content is never included. */
export function roomPushData(input: {
  notificationId: string;
  deviceId: string;
  roomId: string;
  eventId: string;
  roomTitle: string;
  senderName: string;
  engine: string | null;
  reason: RoomPushReason;
  createdAt: string;
  summary?: unknown;
}): Record<string, string> {
  const title = Array.from(input.roomTitle).slice(0, 120).join('');
  const sender = Array.from(input.senderName).slice(0, 120).join('');
  return {
    notification_id: input.notificationId,
    device_id: input.deviceId,
    kind: 'room',
    target_id: input.roomId,
    room_id: input.roomId,
    event_id: input.eventId,
    conversation_key: `room:${input.roomId}`,
    room_title: title,
    sender_name: sender,
    engine: input.engine ?? '',
    reason: input.reason,
    summary: roomPushSummary(input.reason, sender, title, input.summary),
    ts: input.createdAt,
  };
}

/** Bounded answer buttons for a prompt push: at most six options, labels ≤ 60 characters. */
export function promptPushOptions(payload: Record<string, unknown>): string | null {
  const raw = Array.isArray(payload.choices)
    ? (payload.choices as Array<{ label?: unknown; value?: unknown }>)
    : Array.isArray(payload.options)
      ? (payload.options as unknown[]).map((label) => ({ label, value: label }))
      : [];
  const options = raw
    .filter((c) => typeof c?.label === 'string' && typeof c?.value === 'string' && c.value.length <= 200)
    .slice(0, 6)
    .map((c) => ({ id: c.value as string, label: Array.from(c.label as string).slice(0, 60).join('') }));
  if (!options.length) return null;
  const json = JSON.stringify(options);
  return json.length <= 1500 ? json : null;
}

/** C2 conversation metadata for agent pushes (strings only; summaries stay summary.ts-bounded). */
export function agentPushData(input: {
  targetId: string;
  agentName: string | null;
  engine: string | null;
  eventId: number;
  createdAt: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Record<string, string> {
  const name = Array.from(input.agentName ?? 'Agent').slice(0, 120).join('');
  const data: Record<string, string> = {
    conversation_key: `agent:${input.targetId}`,
    agent_id: input.targetId,
    agent_name: name,
    sender_name: name,
    engine: input.engine ?? '',
    event_id: String(input.eventId),
    ts: input.createdAt,
  };
  if (input.eventType === 'waiting_input' && typeof input.payload.prompt_id === 'string') {
    data.prompt_id = input.payload.prompt_id;
    if (typeof input.payload.answer_mode === 'string') data.answer_mode = input.payload.answer_mode;
    const options = promptPushOptions(input.payload);
    if (options) data.options = options;
  }
  return data;
}

type Reader = Pick<Database, 'select'>;
export interface RoomPushCandidate {
  sourceKey: string;
  roomId: string;
  expiresAt: string;
}
/**
 * Classify the room events among change rows for one device. Bodies are decrypted only to
 * classify (mention/reply); nothing from them is stored in the outbox. Events older than
 * one hour, and events in a room the device reports visible, never notify.
 */
export async function roomPushCandidates(
  db: Reader,
  keyring: Keyring,
  changes: ReadonlyArray<{ kind: string; refId: string | null }>,
  options: {
    operator: RoomPushOperator;
    mode(roomId: string): RoomPushMode;
    suppressed(roomId: string): boolean;
    now?: number;
  },
): Promise<RoomPushCandidate[]> {
  const ids = [...new Set(changes.flatMap((c) => (c.kind === 'event' && c.refId ? [c.refId] : [])))];
  if (!ids.length) return [];
  const rows = await db.select().from(agentRoomEvents).where(inArray(agentRoomEvents.id, ids));
  const byId = new Map(rows.map((r) => [r.id, { row: r, body: decodeRoomEventBody(r, keyring) }]));
  const parentIds = [
    ...new Set([...byId.values()].flatMap(({ body }) => (typeof body.reply_to === 'string' ? [body.reply_to] : []))),
  ];
  const parents = parentIds.length
    ? await db
        .select({ id: agentRoomEvents.id, actor: agentRoomEvents.actor })
        .from(agentRoomEvents)
        .where(inArray(agentRoomEvents.id, parentIds))
    : [];
  const parentActor = new Map(parents.map((p) => [p.id, p.actor]));
  const now = options.now ?? Date.now();
  const out: RoomPushCandidate[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (!found) continue;
    const { row, body } = found;
    if (Date.parse(row.createdAt) < now - 3600_000 || options.suppressed(row.roomId)) continue;
    const reason = roomNotificationReason(
      {
        actor: row.actor,
        kind: typeof body.kind === 'string' ? body.kind : 'chat',
        content: typeof body.content === 'string' ? body.content : '',
        replyToActor: typeof body.reply_to === 'string' ? (parentActor.get(body.reply_to) ?? null) : null,
      },
      options.mode(row.roomId),
      options.operator,
    );
    if (reason)
      out.push({
        sourceKey: `room:${row.id}:${reason}`,
        roomId: row.roomId,
        expiresAt: new Date(Date.parse(row.createdAt) + 3600_000).toISOString(),
      });
  }
  return out;
}

/** Resolve a room job's FCM data at send time; null cancels (event or room gone). */
export async function roomJobData(
  db: Reader,
  keyring: Keyring,
  rooms: Pick<AgentRoomChat, 'room'>,
  job: { id: string; deviceId: string; sourceKey: string; targetId: string },
): Promise<Record<string, string> | null> {
  const source = ROOM_SOURCE.exec(job.sourceKey);
  if (!source) return null;
  const [event] = await db.select().from(agentRoomEvents).where(eq(agentRoomEvents.id, source[1]!));
  if (!event || event.roomId !== job.targetId) return null;
  let room: Room;
  try {
    room = await rooms.room(db as AgentMessagingDb, event.roomId);
  } catch {
    return null;
  }
  const body = decodeRoomEventBody(event, keyring);
  return roomPushData({
    notificationId: job.id,
    deviceId: job.deviceId,
    roomId: event.roomId,
    eventId: event.id,
    roomTitle: room.title,
    senderName: typeof body.name === 'string' && body.name ? body.name : 'Participant',
    engine: event.actor.startsWith('agent:')
      ? (room.members.find((m) => `agent:${m.id}` === event.actor)?.engine ?? null)
      : null,
    reason: source[2] as RoomPushReason,
    createdAt: event.createdAt,
    summary: body.summary,
  });
}
