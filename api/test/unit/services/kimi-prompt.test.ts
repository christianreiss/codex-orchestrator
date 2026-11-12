import type { Database } from '../../../src/db/client.js';
import type { StateRow } from '../../../src/control-plane/state/catalog.js';
import { stageCoordinationNotice } from '../../../src/control-plane/state/coordination-notices.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { AgentSession } from '../../../src/db/schema.js';
import { describe, expect, it } from 'vitest';
import { assertHeadlessPrompt } from '../../../src/services/headless-prompt.js';

describe('Kimi argv prompt bound', () => {
  it.each(['a'.repeat(100_000), 'é'.repeat(50_000), '😀'.repeat(25_000)])(
    'accepts exactly 100000 bytes',
    (prompt) => {
      expect(() => assertHeadlessPrompt('kimi', prompt)).not.toThrow();
      expect(() => assertHeadlessPrompt('kimi', prompt + 'a')).toThrow('100000 UTF-8 bytes');
    },
  );
  it.each(['codex', 'claude', 'grok'])('preserves %s input semantics', (engine) => {
    expect(() => assertHeadlessPrompt(engine, '界'.repeat(100_000))).not.toThrow();
  });
});

it('rejects oversized Kimi workflow notices before staging queue entries in either backend', async () => {
  const session = { engine: 'kimi' } as AgentSession;
  const prompt = '界'.repeat(33_334);
  const fake = createDbFake(new Map());
  const bus = new AgentMessagingService(fake as unknown as Database, loadTestEnv(), testKeyring());
  await expect(
    bus.coordinationNotice(
      fake as unknown as Parameters<AgentMessagingService['coordinationNotice']>[0],
      session,
      prompt,
    ),
  ).rejects.toMatchObject({ status: 422, param: 'prompt' });
  expect(fake.inserts).toEqual([]);
  expect(() =>
    stageCoordinationNotice(
      {} as OwnerMutationContext,
      testKeyring(),
      session as unknown as StateRow<'agentSessions'>,
      prompt,
    ),
  ).toThrow('100000 UTF-8 bytes');
});
