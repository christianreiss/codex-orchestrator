import { describe, expect, it } from 'vitest';
import { compactContextAck } from '../../../src/services/agent-coordination/model.js';

const session = { id: 's1', hostId: 7, cwd: '/repo', workspace: null };
const room = (id: string, kind: string) => ({
  id,
  key: id,
  kind,
  title: id,
  cursor: 1,
  member_count: 3,
  members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  next_member_offset: null,
});

describe('compactContextAck', () => {
  const full = {
    enabled: true,
    protocol: 1,
    workspace: { cwd: '/repo' },
    rooms: [room('host', 'host'), room('repo', 'repository')],
    claims: [
      { id: 'own', session_id: 's1', scope_ids: ['host', 'repo'], resources: [{ kind: 'path' }] },
      { id: 'mate', session_id: 's2', scope_ids: ['host', 'repo'] },
      { id: 'foreign', session_id: 's3', scope_ids: ['host'] },
      { id: 'foreign2', session_id: 's4', scope_ids: ['host'] },
    ],
  };
  it('keeps own and repository-room claims, drops unrelated ones and counts them', () => {
    const ack = compactContextAck(full, session);
    expect(ack.claims.map((c) => c.id)).toEqual(['own', 'mate']);
    expect(ack.claims_total).toBe(4);
    expect(ack.claims_omitted).toBe(2);
    expect(ack.workspace).toEqual({ cwd: '/repo' });
    expect(ack.repository_key).toMatch(/^local:7:/);
    expect(ack.detail).toContain('agent_context_get');
  });
  it('drops member lists but keeps room headers', () => {
    const ack = compactContextAck(full, session);
    expect(ack.rooms.map((r) => r.id)).toEqual(['host', 'repo']);
    for (const r of ack.rooms) {
      expect(r).not.toHaveProperty('members');
      expect(r).not.toHaveProperty('next_member_offset');
      expect(r.member_count).toBe(3);
    }
  });
  it('stays far smaller than the full snapshot on a busy host', () => {
    const big = {
      ...full,
      claims: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        session_id: `x${i}`,
        scope_ids: ['host'],
        resources: Array.from({ length: 200 }, (_, j) => ({ kind: 'path', path: `/work/${i}/${j}` })),
      })),
    };
    expect(JSON.stringify(compactContextAck(big, session)).length).toBeLessThan(
      JSON.stringify(big).length / 20,
    );
  });
});
