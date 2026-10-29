import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentPushData,
  mentionsOperator,
  promptPushOptions,
  roomJobData,
  roomNotificationReason,
  roomPushAllowed,
  roomPushCandidates,
  roomPushData,
  roomPushSummary,
} from '../../../src/services/companion/room-push.js';
import { OwnerCompanionPush } from '../../../src/services/companion/push-owner.js';
import { observeCompanion } from '../../../src/services/companion/presence.js';
import { roomReadSchema } from '../../../src/services/agent-room-chat/contracts.js';
import { roomCursorExpired } from '../../../src/services/agent-room-chat/changes.js';
import { ROOM_CHANGE_HEAD_SETTING, stageRoomChange } from '../../../src/control-plane/state/room-heads.js';
import { stageRoomReadSync } from '../../../src/services/companion/room-reads.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { ownerWorkerFixture } from '../../helpers/owner-worker.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { RouteContext } from '../../../src/routes/index.js';

const operator = { key: 'admin:7', name: 'Chris' };
const ROOM = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const PARENT = '44444444-4444-4444-8444-444444444444';
const chat = (content: string, extra: Record<string, unknown> = {}) => ({
  actor: 'agent:a1',
  kind: 'chat',
  content,
  ...extra,
});

afterEach(() => vi.useRealTimers());

describe('room push classifier', () => {
  it('default mode notifies only for replies to and mentions of the operator', () => {
    expect(roomNotificationReason(chat('status update'), 'default', operator)).toBeNull();
    expect(roomNotificationReason(chat('done', { replyToActor: 'admin:7' }), 'default', operator)).toBe('reply');
    expect(roomNotificationReason(chat('done', { replyToActor: 'agent:a2' }), 'default', operator)).toBeNull();
    expect(roomNotificationReason(chat('Chris, please review'), 'default', operator)).toBe('mention');
    expect(roomNotificationReason(chat('ping @operator'), 'default', operator)).toBe('mention');
  });
  it('matches mentions on word boundaries only', () => {
    expect(mentionsOperator('Christmas build is green', 'Chris')).toBe(false);
    expect(mentionsOperator('ask chris.', 'Chris')).toBe(true);
    expect(mentionsOperator('@Chris done', 'Chris')).toBe(true);
    expect(mentionsOperator('cooperator mode', 'X')).toBe(false);
  });
  it('follow notifies every message by someone else; mute and own messages never notify', () => {
    expect(roomNotificationReason(chat('status update'), 'follow', operator)).toBe('follow');
    expect(roomNotificationReason(chat('Chris!', { replyToActor: 'admin:7' }), 'mute', operator)).toBeNull();
    expect(roomNotificationReason({ ...chat('Chris'), actor: 'admin:7' }, 'follow', operator)).toBeNull();
    expect(roomNotificationReason({ ...chat('Added X.'), kind: 'membership' }, 'follow', operator)).toBeNull();
    expect(roomNotificationReason({ ...chat('published'), kind: 'publication' }, 'follow', operator)).toBe('follow');
  });
  it('requires room metadata and private-content capabilities', () => {
    expect(roomPushAllowed('owner')).toBe(true);
    expect(roomPushAllowed('viewer')).toBe(false);
  });
});

describe('room push payload', () => {
  it('never carries message content and caps the summary at 160 characters', () => {
    const data = roomPushData({
      notificationId: 'n',
      deviceId: 'd',
      roomId: ROOM,
      eventId: EVENT,
      roomTitle: 'Release room',
      senderName: 'Agent Smith',
      engine: 'claude',
      reason: 'mention',
      createdAt: '2026-10-29T10:00:00.123Z',
    });
    expect(data).toEqual({
      notification_id: 'n',
      device_id: 'd',
      kind: 'room',
      target_id: ROOM,
      room_id: ROOM,
      event_id: EVENT,
      conversation_key: `room:${ROOM}`,
      room_title: 'Release room',
      sender_name: 'Agent Smith',
      engine: 'claude',
      reason: 'mention',
      summary: 'Agent Smith mentioned you in Release room',
      ts: '2026-10-29T10:00:00.123Z',
    });
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
    expect(Array.from(roomPushSummary('follow', 'x'.repeat(120), 'y'.repeat(120))).length).toBeLessThanOrEqual(160);
    expect(roomPushSummary('reply', 'A', 'R', ' explicit  summary ')).toBe('explicit summary');
  });
  it('bounds prompt answer buttons and adds agent conversation metadata', () => {
    expect(promptPushOptions({ choices: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] })).toBe(
      JSON.stringify([
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ]),
    );
    expect(promptPushOptions({ options: ['A', 'B'] })).toBe(JSON.stringify([{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }]));
    expect(JSON.parse(promptPushOptions({ choices: Array.from({ length: 9 }, (_, i) => ({ label: 'L'.repeat(90), value: `v${i}` })) })!)).toHaveLength(6);
    expect(promptPushOptions({})).toBeNull();
    const data = agentPushData({
      targetId: ROOM,
      agentName: 'Builder',
      engine: 'codex',
      eventId: 42,
      createdAt: '2026-10-29T10:00:00.000Z',
      eventType: 'waiting_input',
      payload: { prompt_id: EVENT, answer_mode: 'buttons', choices: [{ label: 'Ship', value: 'ship' }], question: 'secret?' },
    });
    expect(data).toEqual({
      conversation_key: `agent:${ROOM}`,
      agent_id: ROOM,
      agent_name: 'Builder',
      sender_name: 'Builder',
      engine: 'codex',
      event_id: '42',
      ts: '2026-10-29T10:00:00.000Z',
      prompt_id: EVENT,
      answer_mode: 'buttons',
      options: JSON.stringify([{ id: 'ship', label: 'Ship' }]),
    });
    expect(JSON.stringify(data)).not.toContain('secret?');
  });
});

/** Minimal select fake: resolves queued result sets in call order. */
function selects(...results: unknown[][]) {
  const queue = [...results];
  const chain = { from: () => chain, where: () => Promise.resolve(queue.shift() ?? []) };
  return { select: () => chain } as never;
}

describe('room push candidates and send data', () => {
  const keyring = testKeyring();
  const row = (id: string, actor: string, body: Record<string, unknown>, createdAt = new Date().toISOString()) => ({
    id,
    roomId: ROOM,
    actor,
    requestId: id,
    payloadHash: 'h',
    bodyEnc: encrypt(JSON.stringify(body), keyring),
    createdAt,
  });
  it('classifies only event changes, resolves reply parents, honors suppression and age', async () => {
    const events = [row(EVENT, 'agent:a1', { name: 'A', content: 'done', kind: 'chat', reply_to: PARENT })];
    const out = await roomPushCandidates(
      selects(events, [{ id: PARENT, actor: 'admin:7' }]),
      keyring,
      [
        { kind: 'receipt', refId: PARENT },
        { kind: 'event', refId: EVENT },
      ],
      { operator, mode: () => 'default', suppressed: () => false },
    );
    expect(out).toEqual([
      { sourceKey: `room:${EVENT}:reply`, roomId: ROOM, expiresAt: expect.any(String) },
    ]);
    expect(
      await roomPushCandidates(selects(events, [{ id: PARENT, actor: 'admin:7' }]), keyring, [{ kind: 'event', refId: EVENT }], {
        operator,
        mode: () => 'default',
        suppressed: (room) => room === ROOM,
      }),
    ).toEqual([]);
    const old = [row(EVENT, 'agent:a1', { content: 'Chris', kind: 'chat' }, '2020-01-01T00:00:00.000Z')];
    expect(
      await roomPushCandidates(selects(old), keyring, [{ kind: 'event', refId: EVENT }], {
        operator,
        mode: () => 'follow',
        suppressed: () => false,
      }),
    ).toEqual([]);
  });
  it('resolves send data from the source event and cancels when the room is gone', async () => {
    const event = row(EVENT, 'agent:a1', { name: 'Agent', content: 'private text', kind: 'chat' });
    const rooms = {
      room: vi.fn().mockResolvedValue({ id: ROOM, title: 'Ops', members: [{ id: 'a1', engine: 'grok' }] }),
    };
    const job = { id: 'job', deviceId: 'dev', sourceKey: `room:${EVENT}:follow`, targetId: ROOM };
    const data = await roomJobData(selects([event]), keyring, rooms as never, job);
    expect(data).toMatchObject({ kind: 'room', room_title: 'Ops', sender_name: 'Agent', engine: 'grok', reason: 'follow' });
    expect(JSON.stringify(data)).not.toContain('private text');
    rooms.room.mockRejectedValue(new Error('Conversation not found'));
    expect(await roomJobData(selects([event]), keyring, rooms as never, job)).toBeNull();
    expect(await roomJobData(selects([event]), keyring, rooms as never, { ...job, targetId: PARENT })).toBeNull();
  });
});

describe('room delta contracts', () => {
  it('accepts a numeric or digit-string delta cursor, never together with a history cursor', () => {
    expect(roomReadSchema.parse({ room_id: ROOM, after: 12 }).after).toBe(12);
    expect(roomReadSchema.parse({ room_id: ROOM, after: '12' }).after).toBe(12);
    expect(() => roomReadSchema.parse({ room_id: ROOM, after: -1 })).toThrow();
    expect(() => roomReadSchema.parse({ room_id: ROOM, after: 1, before: 'x' })).toThrow();
  });
  it('flags a cursor older than the oldest retained change', () => {
    expect(roomCursorExpired(0, { min: 50, max: 90 })).toBe(false);
    expect(roomCursorExpired(49, { min: 50, max: 90 })).toBe(false);
    expect(roomCursorExpired(10, { min: 50, max: 90 })).toBe(true);
    expect(roomCursorExpired(10, { min: 0, max: 0 })).toBe(false);
  });
});

describe('owner room change and read-sync staging', () => {
  it('advances the RAM change head only after the cold insert returns its sequence', async () => {
    const f = await ownerWorkerFixture({});
    const draft = f.state.begin();
    const writes: Array<(tx: never) => Promise<unknown>> = [];
    stageRoomChange({ draft, write: (op) => writes.push(op as never) }, ROOM, 'event', EVENT, '2026-10-29T10:00:00.000Z');
    expect(draft.view().setting(ROOM_CHANGE_HEAD_SETTING)).toBeNull();
    const values = vi.fn().mockResolvedValue([{ insertId: 17 }]);
    await writes[0]!({ insert: () => ({ values }) } as never);
    expect(values).toHaveBeenCalledWith({ roomId: ROOM, kind: 'event', refId: EVENT, createdAt: '2026-10-29T10:00:00.000Z' });
    expect(draft.view().setting(ROOM_CHANGE_HEAD_SETTING)).toBe('17');
    await f.close();
  });
  it('stages silent room read jobs for sibling devices on read-sync protocol 1 only', async () => {
    const device = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      userId: 7,
      readSyncProtocol: 1,
      notifications: 1,
      revokedAt: null,
      expiresAt: '2999-01-01T00:00:00.000Z',
      pushTokenDigest: 'digest',
      ...extra,
    });
    const f = await ownerWorkerFixture({
      companionDevices: [device('self'), device('sibling'), device('legacy', { readSyncProtocol: 0 }), device('silent', { pushTokenDigest: null })],
    } as unknown as StateSeed);
    const draft = f.state.begin();
    const write = vi.fn();
    stageRoomReadSync({ draft, write }, { adminId: 7, deviceId: 'self' }, ROOM, '2026-10-29T10:00:00.123Z');
    const jobs = draft.view().table('companionNotifications').all();
    expect(jobs.map((j) => [j.deviceId, j.kind, j.targetId, j.sourceKey])).toEqual([
      ['sibling', 'room_read', ROOM, `room_read:${ROOM}:2026-10-29T10:00:00.123Z`],
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    await f.close();
  });
});

describe('owner room push obligations and eligibility', () => {
  const env = { ...loadTestEnv(), COMPANION_FIREBASE_PROJECT_ID: 'test', COMPANION_FIREBASE_CREDENTIAL_FILE: '/not-read' };
  const seed = (accessLevel = 'owner') =>
    ({
      adminUsers: [{ id: 7, active: 1, accessLevel, name: 'Chris' }],
      companionDevices: [
        {
          id: 'device',
          userId: 7,
          eventCursor: 0,
          roomChangeCursor: 3,
          readSyncProtocol: 1,
          notifications: 1,
          revokedAt: null,
          expiresAt: '2999-01-01T00:00:00.000Z',
          pushTokenDigest: 'digest',
        },
      ],
      companionRoomPrefs: [{ deviceId: 'device', roomId: PARENT, mode: 'mute', updatedAt: '2026-10-29T00:00:00.000Z' }],
      agentRoomReads: [{ roomId: ROOM, adminId: 7, readAt: '2026-10-29T00:00:00.000Z', unreadCount: 0 }],
      versions: [
        { name: 'owner_portal_event_id', version: '0', updatedAt: '2026-10-29T00:00:00.000Z' },
        { name: ROOM_CHANGE_HEAD_SETTING, version: '5', updatedAt: '2026-10-29T00:00:00.000Z' },
        { name: 'agent_messaging_enabled', version: '1', updatedAt: '2026-10-29T00:00:00.000Z' },
      ],
    }) as unknown as StateSeed;
  it('wakes a device only while its room cursor is behind the change head', async () => {
    const f = await ownerWorkerFixture(seed());
    const push = new OwnerCompanionPush({ db: f.db, env, keyring: testKeyring() } as RouteContext);
    expect(push.obligations(f.state.snapshot())).toEqual([{ key: 'rooms:device', dueAt: 0, revision: '3:5' }]);
    const draft = f.state.begin();
    draft.upsert('companionDevices', { ...draft.table('companionDevices').get('device')!, roomChangeCursor: 5 });
    f.state.publish(draft.seal({ ...f.state.revision(), sequence: 1n }));
    expect(push.obligations(f.state.snapshot())).toEqual([]);
    await f.close();
  });
  it('rechecks capabilities, mute, visibility and read sync at send time', async () => {
    const job = (kind: string, targetId: string) => ({
      id: 'job',
      deviceId: 'device',
      sourceKey: kind === 'room' ? `room:${EVENT}:follow` : `room_read:${targetId}:x`,
      kind,
      targetId,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-10-29T00:00:00.000Z',
      createdAt: '2026-10-29T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const f = await ownerWorkerFixture(seed());
    const push = new OwnerCompanionPush({ db: f.db, env, keyring: testKeyring() } as RouteContext);
    const eligible = (j: ReturnType<typeof job>) =>
      (push as unknown as { eligible(s: unknown, j: unknown): unknown }).eligible(f.state.snapshot(), j);
    expect(eligible(job('room', ROOM))).toBeTruthy();
    expect(eligible(job('room', PARENT))).toBeUndefined();
    expect(eligible(job('room_read', ROOM))).toBeTruthy();
    expect(eligible(job('room_read', PARENT))).toBeUndefined();
    observeCompanion(f.runtime, 'device', ROOM);
    expect(eligible(job('room', ROOM))).toBeUndefined();
    await f.close();
    const viewer = await ownerWorkerFixture(seed('viewer'));
    const limited = new OwnerCompanionPush({ db: viewer.db, env, keyring: testKeyring() } as RouteContext);
    expect(
      (limited as unknown as { eligible(s: unknown, j: unknown): unknown }).eligible(viewer.state.snapshot(), job('room', ROOM)),
    ).toBeUndefined();
    await viewer.close();
  });
});
