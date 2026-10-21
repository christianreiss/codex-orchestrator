import { describe, expect, it } from 'vitest';
import type { AgentBusMessage } from '../../../../src/db/schema.js';
import { routineNoticeKind } from '../../../../src/services/agent-messaging/routine-notices.js';
import { SERVER_ADDRESS_ID } from '../../../../src/services/agent-messaging/groups.js';
import { encrypt } from '../../../../src/security/secret-box.js';
import { testKeyring } from '../../../helpers/test-keyring.js';
const keyring = testKeyring();
const scope = (events: unknown[] = [{ kind: 'presence' }, { kind: 'claim' }], extra = {}) =>
  `SCOPE/1\nInformational\n${JSON.stringify({ scope_id: 'scope', events, events_truncated: false, ...extra })}`;
function message(content = scope(), overrides: Partial<AgentBusMessage> = {}): AgentBusMessage {
  return {
    senderAddressId: SERVER_ADDRESS_ID,
    senderSessionId: null,
    workKind: null,
    executionContractVersion: 1,
    kind: 'presence_notice',
    targetSessionId: 'session',
    contentEnc: encrypt(content, keyring),
    contentBytes: Buffer.byteLength(content),
    ...overrides,
  } as AgentBusMessage;
}
describe('trusted routine notice classification', () => {
  it('recognizes complete server bookkeeping, including old own and peer presence', () => {
    expect(routineNoticeKind(message(), keyring)).toBe('scope');
    expect(
      routineNoticeKind(
        message(
          scope([
            { kind: 'presence', actor: 'self' },
            { kind: 'claim', actor: 'other' },
          ]),
        ),
        keyring,
      ),
    ).toBe('scope');
  });
  it.each([
    message(scope([{ kind: 'chat' }])),
    message(scope([{ kind: 'claim' }, { kind: 'chat' }])),
    message(scope([])),
    message(scope(undefined, { events_truncated: true })),
    message('SCOPE/1\n{bad'),
    message(scope(), { senderAddressId: 'peer' }),
    message(scope(), { senderSessionId: 'peer-session' }),
    message(scope(), { kind: 'message' }),
    message(scope(), { targetSessionId: null }),
    message(scope(), { workKind: 'request' }),
    message(scope(), { executionContractVersion: 2 }),
    message(scope(), { contentBytes: 262145 }),
    message(scope(), { contentEnc: 'unreadable' }),
  ])('preserves chat, malformed/truncated payloads, work and peer spoofing %#', (row) => {
    expect(routineNoticeKind(row, keyring)).toBeNull();
  });
  it('recognizes only proven routine automatic role publications', () => {
    for (const header of [
      'ROLE-UPDATE/1 role=test version=2 previous=1 sha=012345abcdef',
      'ROLE-PROPOSAL/1 role=test proposal_id=00000000-0000-4000-8000-000000000000 status=applied version=2',
    ]) {
      const content = header + '\nInformational; no reply required.\nDetails';
      expect(
        routineNoticeKind(message(content, { kind: 'publication', targetSessionId: null }), keyring),
      ).toBe('role');
      expect(
        routineNoticeKind(message(content, { kind: 'publication', senderAddressId: 'peer' }), keyring),
      ).toBeNull();
    }
    for (const header of [
      'ROLE-REVIEW/1 action required',
      'PUBLICATION/1\nROLE-UPDATE/1 data',
      'ROLE-UPDATE/1 role=test withdrawn=1 severity=withdrawn',
      'ROLE-UPDATE/1 role=test version=2 previous=1 sha=012345abcdef severity=unknown',
      'ROLE-PROPOSAL/1 role=test proposal_id=00000000-0000-4000-8000-000000000000 status=unknown',
      'ROLE-UPDATE/1 malformed',
    ])
      expect(
        routineNoticeKind(
          message(header + '\nInformational; no reply required.', { kind: 'publication' }),
          keyring,
        ),
      ).toBeNull();
  });
  it('recognizes only the two routine Director event types', () => {
    for (const kind of [
      'work_scope_changed',
      'merge_reported',
      'lease_expired',
      'binding_changed',
      'module_toggled',
    ]) {
      const content = `GIT-DIRECTOR/1\nInfo\n${JSON.stringify({ kind, clone_id: 'clone', event_id: 'event', observed_at: 'now' })}`;
      expect(routineNoticeKind(message(content), keyring)).toBe(
        ['work_scope_changed', 'merge_reported'].includes(kind) ? 'director' : null,
      );
    }
  });
});
