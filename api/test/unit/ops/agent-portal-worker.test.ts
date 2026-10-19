import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { Env } from '../../../src/env.js';
import type { Keyring } from '../../../src/security/keyring.js';

const mocks = vi.hoisted(() => ({ portal: vi.fn(), history: vi.fn(), hosts: vi.fn(), attachments: vi.fn() }));
vi.mock('../../../src/services/agent-portal.js', () => ({ createAgentPortalService: () => ({ purgeExpired: mocks.portal }) }));
vi.mock('../../../src/services/server-retention/index.js', () => ({ ServerRetentionService: class { purge = mocks.history; } }));
vi.mock('../../../src/services/host-lifecycle.js', () => ({ pruneHosts: mocks.hosts }));
vi.mock('../../../src/services/agent-chat/attachments.js', () => ({ ChatAttachments: class { purge = mocks.attachments; } }));
import { startAgentPortalWorker } from '../../../src/ops/agent-portal-worker.js';

describe('periodic server retention', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
  it('runs without host traffic and continues other phases after a failure', async () => {
    vi.useFakeTimers();
    mocks.portal.mockRejectedValue(new Error('temporary portal failure'));
    mocks.history.mockResolvedValue({ credentials: 1 });
    mocks.hosts.mockResolvedValue(0);
    mocks.attachments.mockResolvedValue(0);
    const log = { info: vi.fn(), error: vi.fn() };
    let close!: () => Promise<void>;
    const app = { log, addHook: (_: string, callback: () => Promise<void>) => { close = callback; } };
    startAgentPortalWorker(app as unknown as FastifyInstance, {} as Database, { AGENT_PORTAL_PURGE_INTERVAL_SECONDS: 300 } as Env, {} as Keyring);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ phase: 'portal' }), 'server retention phase failed');
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(mocks.attachments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(mocks.history).toHaveBeenCalledTimes(2);
    await close();
    await vi.advanceTimersByTimeAsync(300000);
    expect(mocks.history).toHaveBeenCalledTimes(2);
  });
});
