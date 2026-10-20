import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisorSessions, agentBusAddresses, agentBusMessages, hosts, versions } from '../../../src/db/schema.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import { AdvisorService } from '../../../src/services/advisor.js';
import { advisorTurnCompleted, parseAdvisorVerdict } from '../../../src/services/advisor-delivery.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { buildModelPolicy } from '../../../src/services/model-policy.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
afterEach(() => vi.restoreAllMocks());

describe('Advisor role prompt', () => {
  it.each([
    ['codex', 'gpt-6-astra'], ['claude', 'claude-opus-5-5'], ['grok', 'grok-4.7'],
  ] as const)('%s demonstrates evidence objects accepted by the verdict parser', async (engine, model) => {
    const callerId = randomUUID();
    const db = createDbFake(new Map([[agentBusAddresses, [{ id: callerId, launchName: 'Caller', engine }]]]));
    const service = new AdvisorService({ db, env: loadTestEnv(), keyring } as never);
    vi.spyOn(service, 'availability').mockResolvedValue({ enabled: true, reason: 'ok', host_id: 264, engines: [engine], models: [{ engine, model, tier: 4 }], default: { engine, model } });
    vi.spyOn(HostDaemonService.prototype, 'settings').mockResolvedValue({ settings: { max_parallel: 8 } } as never);
    const start = vi.spyOn(HostDaemonService.prototype, 'start').mockResolvedValue({ session_id: randomUUID(), operation_id: randomUUID() });
    await service.ask({ session: { agentBusAddressId: callerId }, host: { fqdn: 'caller.test' } } as never, { question: 'Review the supplied task', kind: 'tier_check', client_message_id: randomUUID() });
    const prompt = start.mock.calls[0]![0].prompt;
    expect(prompt).toContain(`Your concrete session model: ${engine}/${model}`);
    expect(parseAdvisorVerdict(prompt)?.evidence?.[0]).toMatchObject({ description: expect.any(String), reference: expect.any(String) });
    expect(prompt).toContain('never a bare string');
  });
});

describe('Advisor availability', () => {
  it('reports unavailable when the only ready engine has every model disabled', async () => {
    const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
      [hosts, [{ id: 264, internalRole: 'advisor', status: 'active', engines: 'claude' }]],
      [versions, [
        { name: 'agent_messaging_enabled', version: '1' },
        { name: 'claude_models_latest_only', version: '1' },
        { name: 'claude_models_disabled', version: buildModelPolicy('claude').latest_models.join(',') },
      ]],
    ]));
    vi.spyOn(HostDaemonService.prototype, 'view').mockResolvedValue({ enabled: true, health: { state: 'green' }, engines: ['claude'] } as never);
    const service = new AdvisorService({ db, env: loadTestEnv(), keyring } as never);
    expect(await service.availability()).toMatchObject({ enabled: false, reason: 'advisor_model_unavailable', engines: [], models: [], default: null });
  });
});

describe('Advisor turn delivery', () => {
  function fixture() {
    const caller = randomUUID(), sender = randomUUID(), session = randomUUID();
    const row = {
      id: randomUUID(), callerAddressId: caller, daemonSessionId: session, status: 'open', turns: 1,
      kind: 'verify', conversationId: null, closeReason: null,
      verdictEnc: encrypt(JSON.stringify({ verdict: 'agree', summary: 'Previous answer' }), keyring),
    };
    const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
      [advisorSessions, [row]],
      [agentBusAddresses, [
        { id: caller, enabled: 1, archivedAt: null },
        { id: sender, enabled: 1, currentSessionId: null },
      ]],
    ]));
    const complete = (result: { status: string; reply: string }, nextStatus = 'idle') =>
      advisorTurnCompleted(db as never, keyring, { id: session, addressId: sender } as never, result, nextStatus, 60);
    const message = () => decrypt(String(db.tables.get(agentBusMessages)![0]!.contentEnc), keyring);
    return { row, complete, message };
  }

  it('clears the old verdict when the latest answer has no valid verdict', async () => {
    const f = fixture();
    await f.complete({ status: 'completed', reply: 'More information required, but no JSON verdict.' });
    expect(f.row.verdictEnc).toBeNull();
    expect(f.row.turns).toBe(2);
    expect(f.message()).toContain('More information required');
    expect(f.message()).toContain('client_message_id');
  });

  it('delivers failure diagnostics and clears the preceding verdict', async () => {
    const f = fixture();
    await f.complete({ status: 'failed', reply: 'Provider rejected the configured model.' }, 'failed');
    expect(f.message()).toContain('Provider rejected the configured model.');
    expect(f.message()).toContain('status "failed"');
    expect(f.row.verdictEnc).toBeNull();
    expect(f.row.status).toBe('failed');
  });
});
