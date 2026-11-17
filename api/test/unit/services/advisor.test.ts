import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisorSessions, agentBusAddresses, agentBusMessages, hostDaemonSessions, hostDaemonOperations, hosts, versions } from '../../../src/db/schema.js';
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
    ['codex', 'gpt-6-astra'], ['claude', 'claude-opus-5-5'], ['grok', 'grok-4.7'], ['kimi', 'k3.1-pro'],
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
    expect(prompt).toContain('fetching a transfer needs no resource claim');
    expect(prompt).toContain('5 open-ended diagnosis and frontier review');
    expect(prompt).toContain('"tier" (integer 1-5)');
  });
});

describe('Advisor fleet tiers', () => {
  it.each([1, 2, 3, 4, 5])('retains a valid Tier %s verdict', (tier) => {
    expect(parseAdvisorVerdict('```json\n' + JSON.stringify({ verdict: 'agree', summary: 'Supported rating.', tier }) + '\n```')?.tier).toBe(tier);
  });
  it.each([0, 6, 1.5])('rejects an unsupported tier %s', (tier) => {
    expect(parseAdvisorVerdict('```json\n' + JSON.stringify({ verdict: 'agree', summary: 'Invalid rating.', tier }) + '\n```')).toBeNull();
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

describe('Advisor terminal diagnostics', () => {
  function fixture(reply: string, resultStatus = 'failed') {
    const callerId = randomUUID(), id = randomUUID(), sessionId = randomUUID();
    const db = createDbFake(new Map<unknown, Record<string, unknown>[]>([
      [advisorSessions, [{ id, callerAddressId: callerId, daemonSessionId: sessionId, status: 'failed', turns: 1, verdictEnc: null, closeReason: 'error' }]],
      [hostDaemonSessions, [{ id: sessionId, status: 'failed' }]],
      [hostDaemonOperations, [{ id: randomUUID(), sessionId, createdAt: '2026-10-21T14:00:00.000Z', status: resultStatus, resultEnc: encrypt(JSON.stringify({ status: resultStatus, reply }), keyring) }]],
    ]));
    const service = new AdvisorService({ db, env: loadTestEnv(), keyring } as never);
    const status = (owner = callerId) => service.status({ session: { agentBusAddressId: owner } } as never, { advisor_session_id: id });
    return { status, db };
  }
  it('exposes only bounded terminal evidence to the owner without fabricating a verdict', async () => {
    const f = fixture('Native process exited unsuccessfully; exit_status=1; startup stage=registration code=agent_messaging_lease_lost http=409');
    expect(await f.status()).toMatchObject({ status: 'failed', verdict: null,
      diagnostic: { code: 'native_exit', exit_status: 1, startup_stage: 'registration', startup_code: 'agent_messaging_lease_lost', http_status: 409 } });
    await expect(f.status(randomUUID())).rejects.toMatchObject({ status: 403 });
  });
  it.each(['agent_name_pool_exhausted', 'agent_messaging_address_busy', 'agent_messaging_binding_stale', 'agent_session_conflict', 'session_housekeeping_busy'])('preserves the safe registration refusal %s', async (code) => {
    const f = fixture(`Native process exited unsuccessfully; exit_status=1; startup stage=registration code=${code} http=409`);
    expect(await f.status()).toMatchObject({ status: 'failed', verdict: null,
      diagnostic: { code: 'native_exit', exit_status: 1, startup_stage: 'registration', startup_code: code, http_status: 409 } });
  });
  it.each([
    'Native process exited unsuccessfully; inspect the native session on the host',
    'Provider refused private-account-data',
    'Native process exited unsuccessfully; exit_status=999',
    'Native process exited unsuccessfully; exit_status=1; startup stage=registration code=failed http=200',
    'Native process exited unsuccessfully; exit_status=1; startup stage=registration code=private-token http=409',
    'Native process exited unsuccessfully; exit_status=1\nprivate-account-data',
    'Native process exited unsuccessfully; exit_status=1' + 'x'.repeat(257),
  ])('leaves legacy or unsafe diagnostics null: %s', async (reply) => {
    expect(await fixture(reply).status()).toMatchObject({ verdict: null, diagnostic: null });
  });
  it('does not promote successful model text into failure evidence', async () => {
    expect(await fixture('Native process exited unsuccessfully; exit_status=1', 'completed').status()).toMatchObject({ diagnostic: null });
  });
  it.each([null, 'legacy-unreadable-result'])('keeps missing or unreadable legacy result evidence null: %s', async (resultEnc) => {
    const f = fixture('Native process exited unsuccessfully; exit_status=1');
    f.db.tables.get(hostDaemonOperations)![0]!.resultEnc = resultEnc;
    expect(await f.status()).toMatchObject({ diagnostic: null, verdict: null });
  });
  it('does not infer the newest turn from random UUIDs at tied timestamps', async () => {
    const f = fixture('Native process exited unsuccessfully; exit_status=1');
    const operations = f.db.tables.get(hostDaemonOperations)!;
    operations.push({ ...operations[0], id: randomUUID(), resultEnc: encrypt(JSON.stringify({ status: 'failed', reply: 'Native process exited unsuccessfully; exit_status=7' }), keyring) });
    expect(await f.status()).toMatchObject({ diagnostic: null });
  });
  it('reports an expired unstarted offer even when no native result exists', async () => {
    const f = fixture('unused');
    Object.assign(f.db.tables.get(advisorSessions)![0]!, { status: 'starting', turns: 0 });
    Object.assign(f.db.tables.get(hostDaemonOperations)![0]!, { status: 'expired', resultEnc: null });
    expect(await f.status()).toMatchObject({ status: 'failed', verdict: null, diagnostic: {
      code: 'advisor_startup_timeout', phase: 'expired', offer_timeout_seconds: 600,
      action: expect.stringContaining('Do not disable TLS verification'),
    } });
  });
  it('distinguishes a queued launch from a running reviewer without exposing native errors', async () => {
    const f = fixture('private stderr must stay private');
    Object.assign(f.db.tables.get(advisorSessions)![0]!, { status: 'starting', turns: 0 });
    Object.assign(f.db.tables.get(hostDaemonSessions)![0]!, { status: 'queued' });
    Object.assign(f.db.tables.get(hostDaemonOperations)![0]!, { status: 'queued' });
    const result = await f.status();
    expect(result).toMatchObject({ status: 'starting', diagnostic: { code: 'advisor_startup_pending', phase: 'queued' } });
    expect(JSON.stringify(result)).not.toContain('private stderr');
    Object.assign(f.db.tables.get(hostDaemonSessions)![0]!, { status: 'running', addressId: randomUUID() });
    expect(await f.status()).toMatchObject({ diagnostic: null });
  });
  it('does not retain an older failure while the latest operation has no result', async () => {
    const f = fixture('Native process exited unsuccessfully; exit_status=1');
    const operations = f.db.tables.get(hostDaemonOperations)!;
    // DbFake preserves seeded ordering; put the newest operation first.
    operations.unshift({ ...operations[0], id: randomUUID(), createdAt: '2026-10-21T14:00:01.000Z', status: 'queued', resultEnc: null });
    expect(await f.status()).toMatchObject({ diagnostic: null });
  });
});
