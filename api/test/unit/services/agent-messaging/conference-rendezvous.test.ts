import { describe, expect, it } from 'vitest';

import { conferenceRendezvousKey, isRendezvousRaceError } from '../../../../src/services/agent-messaging/conference-protocol.js';
import { normalizeConferenceTopicKey } from '../../../../src/services/agent-messaging/normalize.js';
import { repositoryIdentity } from '../../../../src/services/agent-coordination/model.js';
import { buildManagedConferenceSkill } from '../../../../src/services/managed-conference-skill.js';

describe('conference rendezvous key', () => {
  it('treats case, outer space and whitespace runs as the same topic, and nothing else', () => {
    const key = normalizeConferenceTopicKey('Discuss together and agree');
    expect(normalizeConferenceTopicKey('  discuss   TOGETHER\tand agree\n')).toBe(key);
    expect(normalizeConferenceTopicKey('Discuss together')).not.toBe(key);
    expect(normalizeConferenceTopicKey('Discuss together and agree.')).not.toBe(key);
  });

  it('separates repositories and topics, and is a fixed-width hash', () => {
    const topic = normalizeConferenceTopicKey('plan');
    const here = conferenceRendezvousKey('repo:abc', topic);
    expect(here).toMatch(/^[0-9a-f]{64}$/);
    expect(conferenceRendezvousKey('repo:abc', topic)).toBe(here);
    expect(conferenceRendezvousKey('repo:def', topic)).not.toBe(here);
    expect(conferenceRendezvousKey('repo:abc', normalizeConferenceTopicKey('plan b'))).not.toBe(here);
    // The separator makes ("a","bc") and ("ab","c") different keys.
    expect(conferenceRendezvousKey('a', 'bc')).not.toBe(conferenceRendezvousKey('ab', 'c'));
  });

  it('derives the repository part from the same identity the scope rooms use', () => {
    const base = { hostId: 7, cwd: '/work/a', workspace: null };
    expect(repositoryIdentity(base)).toBe(repositoryIdentity({ ...base }));
    expect(repositoryIdentity({ ...base, cwd: '/work/b' })).not.toBe(repositoryIdentity(base));
    expect(repositoryIdentity({ ...base, hostId: 8 })).not.toBe(repositoryIdentity(base));
  });

  it('recognizes lost races, including through a driver wrapper', () => {
    expect(isRendezvousRaceError({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isRendezvousRaceError({ errno: 1213 })).toBe(true);
    expect(isRendezvousRaceError(Object.assign(new Error('Failed query'), { cause: { errno: 1062 } }))).toBe(true);
    expect(isRendezvousRaceError(new Error('boom'))).toBe(false);
    expect(isRendezvousRaceError(null)).toBe(false);
  });

  it('teaches the skill to use the atomic form instead of check-then-open', () => {
    const { manifest } = buildManagedConferenceSkill('2026-10-08T00:00:00Z');
    expect(manifest).toContain('`join_existing: true`');
    expect(manifest).toContain('joined: true');
  });
});
