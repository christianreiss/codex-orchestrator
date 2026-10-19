import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentBusAddresses,
  agentBusMessages,
  agentEvents,
  agentNameLeases,
  agentNamePool,
  agentRoleAssignments,
  agentRoleProposalEvents,
  agentRoleProposals,
  agentRoleVersionFiles,
  agentRoleVersions,
  agentRoles,
  agentSessions,
  hosts,
} from '../../../src/db/schema.js';
import { runMigrations } from '../../../src/db/migrator.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { RolesService } from '../../../src/services/roles.js';
import type { RoleJudgeResult, RoleProposalBrief, RoleProposalJudge } from '../../../src/services/roles/judge.js';
import { SettingsService } from '../../../src/services/settings.js';
import { nowIso } from '../../../src/util/timestamp.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();

const MANIFEST = (body = 'Review user interfaces against the project standard.', extra = '') => `---
name: ztest-design
label: Designer
summary: Test design role
boundaries:
  - Never claims approval authority.
tools:
  recommended:
    - capability: browser-screenshot
      candidates: [mcp__playwright__browser_take_screenshot]
collaboration:
  finding_classes: [defect, deviation, recommendation, preference]
${extra}---
${body}
`;

/** A judge whose next verdicts the test scripts; null means "declined". */
class ScriptedJudge implements RoleProposalJudge {
  model = 'test-judge';
  verdicts: Array<RoleJudgeResult | null> = [];
  briefs: RoleProposalBrief[] = [];
  async judge(brief: RoleProposalBrief) {
    this.briefs.push(brief);
    return this.verdicts.length ? this.verdicts.shift()! : { verdict: 'accept' as const, reason: 'cites the added path', model: this.model };
  }
}

describe.skipIf(!handle)('agent roles on MySQL', { timeout: 120_000 }, () => {
  const db = handle?.db;
  const keyring = testKeyring();
  const admin = { kind: 'admin' as const, admin_user_id: 1 };
  let messaging: AgentMessagingService;
  let roles: RolesService;
  let judge: ScriptedJudge;
  let host: typeof hosts.$inferSelect;

  async function cleanup() {
    const roleRows = await db!.select().from(agentRoles).where(sql`${agentRoles.slug} LIKE 'ztest-%'`);
    const roleIds = roleRows.map((role) => role.id);
    if (roleIds.length) {
      const versions = await db!.select({ id: agentRoleVersions.id }).from(agentRoleVersions).where(inArray(agentRoleVersions.roleId, roleIds));
      if (versions.length) await db!.delete(agentRoleVersionFiles).where(inArray(agentRoleVersionFiles.versionId, versions.map((v) => v.id)));
      await db!.delete(agentRoleVersions).where(inArray(agentRoleVersions.roleId, roleIds));
      const proposals = await db!.select({ id: agentRoleProposals.id }).from(agentRoleProposals).where(inArray(agentRoleProposals.roleId, roleIds));
      if (proposals.length) await db!.delete(agentRoleProposalEvents).where(inArray(agentRoleProposalEvents.proposalId, proposals.map((p) => p.id)));
      await db!.delete(agentRoleProposals).where(inArray(agentRoleProposals.roleId, roleIds));
      await db!.delete(agentRoleAssignments).where(inArray(agentRoleAssignments.roleId, roleIds));
      await db!.delete(agentRoles).where(inArray(agentRoles.id, roleIds));
    }
    if (!host) return;
    const sessions = (await db!.select().from(agentSessions).where(eq(agentSessions.hostId, host.id))).map((s) => s.id);
    if (sessions.length) {
      await db!.update(agentNamePool).set({ currentSessionId: null }).where(inArray(agentNamePool.currentSessionId, sessions));
      await db!.delete(agentNameLeases).where(inArray(agentNameLeases.sessionId, sessions));
      await db!.delete(agentEvents).where(inArray(agentEvents.sessionId, sessions));
    }
    const addresses = (await db!.select().from(agentBusAddresses).where(eq(agentBusAddresses.hostId, host.id))).map((a) => a.id);
    if (addresses.length) await db!.delete(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, addresses));
    await db!.delete(agentSessions).where(eq(agentSessions.hostId, host.id));
    await db!.delete(agentBusAddresses).where(eq(agentBusAddresses.hostId, host.id));
  }

  beforeAll(async () => {
    await runMigrations(handle!.pool);
    messaging = new AgentMessagingService(db!, loadTestEnv(), keyring);
    const fqdn = `ztest-roles-${randomUUID()}.example`;
    await db!.insert(hosts).values({ fqdn, apiKey: randomBytes(32).toString('hex'), secure: 1, status: 'active', engines: 'codex,claude,grok', createdAt: nowIso(), updatedAt: nowIso() });
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await db!.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${nowIso()}) ON DUPLICATE KEY UPDATE version='1'`);
  }, 120_000);
  beforeEach(async () => {
    await cleanup();
    judge = new ScriptedJudge();
    roles = new RolesService({
      db: db!,
      settings: new SettingsService(db!),
      judge,
      authenticateBridge: (id, token) => messaging.authenticateBridge(id, token),
      notify: async (ids, body) => {
        await messaging.noticeAddresses(ids, body);
      },
    });
    await roles.setEnabled(true);
  });
  afterAll(async () => {
    await cleanup();
    if (host) await db!.delete(hosts).where(eq(hosts.id, host.id));
    await new SettingsService(db!).set('roles_enabled', '0');
    await handle?.pool.end();
  });

  async function launch(engine: 'codex' | 'claude' | 'grok' = 'claude', upstream = randomUUID(), resumed = false) {
    const input = {
      sessionId: randomUUID(),
      bridgeToken: randomBytes(32).toString('base64url'),
      engine,
      username: 'role-user',
      cwd: '/repo',
      invocationKind: 'interactive' as const,
      upstreamSessionId: upstream,
      ...(resumed ? { resumed: true } : {}),
    };
    const result = await messaging.registerSession(host, input);
    return { id: input.sessionId, token: input.bridgeToken, upstream, address: (result.address as { id: string }).id };
  }
  async function publishedRole(manifest = MANIFEST(), files: Array<Record<string, unknown>> = []) {
    await roles.createRole({ slug: 'ztest-design', display_name: 'Design-Agent', summary: 'Designs and reviews UI' }, admin);
    await roles.saveDraft('ztest-design', { manifest, files, changelog: 'first' }, admin);
    return roles.publishDraft('ztest-design', {}, admin);
  }
  const activate = (agent: { id: string; token: string }, extra: Record<string, unknown> = {}) =>
    roles.activate(agent.id, agent.token, { role: 'ztest-design', reason: 'operator: "Du bist der Design-Agent"', client_request_id: randomUUID(), ...extra });
  async function notices(addressId: string) {
    const rows = await db!.select().from(agentBusMessages).where(eq(agentBusMessages.targetAddressId, addressId));
    return rows.map((row) => decrypt(row.contentEnc, keyring));
  }

  it('activates a pinned version with its core, shows it in agent_self and agent_list, and refuses silent switches', async () => {
    await publishedRole(MANIFEST(), [
      { path: 'checklists/review.md', content: '- check focus order\n', load: 'core' },
      { path: 'refs/hero.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), encoding: 'base64', mime_type: 'image/png' },
    ]);
    const designer = await launch();
    const peer = await launch('codex');

    expect((await roles.catalog()).roles.map((role) => role.slug)).toContain('ztest-design');
    const requestId = randomUUID();
    const first = await activate(designer, { client_request_id: requestId });
    expect(first.created).toBe(true);
    expect(first.role.version).toBe(1);
    expect(first.core_files).toEqual([{ path: 'checklists/review.md', text: '- check focus order\n' }]);
    expect(first.files_index?.map((file) => file.uri)).toEqual(['role://ztest-design@1/refs/hero.png']);
    expect(first.tools?.recommended[0]?.capability).toBe('browser-screenshot');
    expect((await activate(designer, { client_request_id: requestId })).created).toBe(false);

    const self = (await messaging.self(designer.id, designer.token)) as { role: { slug: string; label: string; version: number }; role_labels: string[] };
    expect(self.role).toMatchObject({ slug: 'ztest-design', label: 'Designer', version: 1 });
    expect(self.role_labels).toEqual(['Designer']);
    const listed = (await messaging.listAddresses(peer.id, peer.token, { role: 'ztest-design' })) as { addresses: Array<{ id: string; role: { slug: string } }> };
    expect(listed.addresses.map((a) => a.id)).toEqual([designer.address]);
    expect(((await messaging.listAddresses(peer.id, peer.token, { role: 'ztest-nothing' })) as { addresses: unknown[] }).addresses).toEqual([]);

    // A peer may hand a role to an agent without one, never replace one; nor may the agent itself.
    await roles.createRole({ slug: 'ztest-other', display_name: 'Tester', summary: 'Tests things' }, admin);
    await roles.saveDraft('ztest-other', { manifest: MANIFEST().replace('name: ztest-design', 'name: ztest-other') }, admin);
    await roles.publishDraft('ztest-other', {}, admin);
    const other = (extra: Record<string, unknown>) => roles.activate(designer.id, designer.token, { role: 'ztest-other', reason: 'x', client_request_id: randomUUID(), ...extra });
    await expect(other({ activated_by: 'peer', replace: true })).rejects.toMatchObject({ code: 'role_already_active' });
    await expect(other({})).rejects.toMatchObject({ code: 'role_already_active' });
    expect((await activate(designer, { activated_by: 'peer' })).created).toBe(false);

    // role:// serves text as text and binary as an MCP blob.
    const text = await roles.readResource('role://ztest-design@1/checklists/review.md');
    expect(text.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '- check focus order\n' });
    const blob = await roles.readResource('role://ztest-design@1/refs/hero.png');
    expect(blob.contents[0]).toMatchObject({ mimeType: 'image/png', blob: 'iVBORw==' });

    // Unknown roles answer with candidates, not a guess.
    await expect(roles.activate(peer.id, peer.token, { role: 'ztest-desig', reason: 'x', client_request_id: randomUUID() })).rejects.toMatchObject({ code: 'role_not_found' });
  });

  it('keeps the pinned version across a resume and a newer publish, then upgrades only explicitly', async () => {
    await publishedRole();
    const designer = await launch('claude');
    await activate(designer);
    await roles.saveDraft('ztest-design', { manifest: MANIFEST('Second version of the prompt.') }, admin);
    await roles.publishDraft('ztest-design', { changelog: 'tightened prompt' }, admin);

    const update = (await notices(designer.address)).find((body) => body.startsWith('ROLE-UPDATE/1'));
    expect(update).toContain('version=2 previous=1');
    expect(update).toContain('activated_by:"self_upgrade"');

    // Resume of the same native transcript: same address, same pinned version.
    await messaging.registerSession(host, { sessionId: randomUUID(), bridgeToken: 'x'.repeat(43), engine: 'claude', username: 'role-user', cwd: '/repo', invocationKind: 'interactive', upstreamSessionId: designer.upstream, resumed: true }).catch(() => undefined);
    const current = await roles.current(designer.id, designer.token, { include_core: true });
    expect(current).toMatchObject({ active: true, role: { version: 1 }, newer_version: 2 });
    expect((current as { manifest?: string }).manifest).toContain('Review user interfaces');

    const upgraded = await activate(designer, { version: 'latest', activated_by: 'self_upgrade' });
    expect(upgraded.role.version).toBe(2);
    expect(upgraded.assignment.previous_assignment_id).toBeTruthy();
    await expect(activate(designer, { version: 1, activated_by: 'self_upgrade' })).rejects.toMatchObject({ code: 'role_upgrade_not_newer' });

    // A fresh launch in the same directory has no role.
    const fresh = await launch('claude');
    expect(await roles.current(fresh.id, fresh.token, {})).toMatchObject({ active: null });

    // manual policy refuses self-upgrades.
    const detail = await roles.detailAdmin('ztest-design');
    await roles.updateRole('ztest-design', { policy: { holder_upgrade: 'manual' }, expected_version: detail.role.version });
    await roles.saveDraft('ztest-design', { manifest: MANIFEST('Third.') }, admin);
    await roles.publishDraft('ztest-design', {}, admin);
    await expect(activate(designer, { version: 'latest', activated_by: 'self_upgrade' })).rejects.toMatchObject({ code: 'role_upgrade_manual' });
  });

  it('publishes an additive proposal on its own after gates and judge', async () => {
    await publishedRole();
    const designer = await launch();
    await activate(designer);
    const { proposal } = await roles.propose(designer.id, designer.token, {
      kind: 'file_add', title: 'Add focus checklist', rationale: 'Missed twice in reviews', client_request_id: randomUUID(),
      ops: [{ op: 'put', path: 'checklists/focus.md', content: '- visible focus on every control\n' }],
    });
    expect(proposal).toMatchObject({ risk: 'additive', status: 'checking' });
    await roles.processDue();
    const [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposal.id));
    expect(row!.status).toBe('applied');
    expect((await roles.readResource('role://ztest-design@2/checklists/focus.md')).contents[0]!.text).toContain('visible focus');
    expect((await notices(designer.address)).some((body) => body.startsWith('ROLE-PROPOSAL/1') && body.includes('status=applied'))).toBe(true);
    expect(judge.briefs[0]!.title).toBe('Add focus checklist');
  });

  it('never publishes without a judge verdict and rejects what the judge or the gates refuse', async () => {
    await publishedRole();
    const designer = await launch();
    await activate(designer);
    const propose = (content: string) =>
      roles.propose(designer.id, designer.token, { kind: 'note', title: 'A note', rationale: 'r', client_request_id: randomUUID(), ops: [{ op: 'put', path: `notes/${randomUUID()}.md`, content }] });

    judge.verdicts = [null];
    const declined = await propose('useful');
    await roles.processDue();
    let [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, declined.proposal.id));
    expect(row).toMatchObject({ status: 'checking', attempts: 1 });

    judge.verdicts = [{ verdict: 'revise', reason: 'one case is not a rule', model: 'test-judge' }];
    await db!.update(agentRoleProposals).set({ nextAttemptAt: nowIso() }).where(eq(agentRoleProposals.id, declined.proposal.id));
    await roles.processDue();
    [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, declined.proposal.id));
    expect(row!.status).toBe('rejected');

    const secret = await propose('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(secret.proposal).toMatchObject({ status: 'rejected' });
    expect((secret.proposal.gate_results as { checks: Array<{ gate: string; ok: boolean }> }).checks).toContainEqual(expect.objectContaining({ gate: 'no_secrets', ok: false }));
  });

  it('needs an independent holder for a core change; the author cannot review it', async () => {
    await publishedRole();
    const author = await launch('claude');
    const other = await launch('codex');
    await activate(author);
    const { proposal } = await roles.propose(author.id, author.token, {
      kind: 'manifest_change', title: 'Sharper prompt', rationale: 'r', client_request_id: randomUUID(),
      ops: [{ op: 'put', path: 'ROLE.md', content: MANIFEST('A sharper role prompt.') }],
    });
    expect(proposal.risk).toBe('core');
    await roles.processDue();
    let [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposal.id));
    expect(row).toMatchObject({ status: 'in_review', reviewerAddressId: null });

    await activate(other);
    await roles.processDue();
    [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposal.id));
    expect(row!.reviewerAddressId).toBe(other.address);
    expect((await notices(other.address)).some((body) => body.startsWith('ROLE-REVIEW/1'))).toBe(true);

    await expect(roles.review(author.id, author.token, { proposal_id: proposal.id, verdict: 'accept', reason: 'mine', expected_version: row!.version })).rejects.toMatchObject({ code: 'review_self_forbidden' });
    await roles.review(other.id, other.token, { proposal_id: proposal.id, verdict: 'accept', reason: 'the new prompt keeps the boundaries', expected_version: row!.version });
    [row] = await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, proposal.id));
    expect(row!.status).toBe('applied');
    expect((await roles.readResource('role://ztest-design@2/ROLE.md')).contents[0]!.text).toContain('A sharper role prompt.');
  });

  it('supersedes the loser of two proposals to the same file and lets the operator steer', async () => {
    await publishedRole(MANIFEST(), [{ path: 'notes/a.md', content: 'v1\n' }]);
    const one = await launch('claude');
    const two = await launch('grok');
    await activate(one);
    await activate(two);
    const change = (agent: { id: string; token: string }, content: string) =>
      roles.propose(agent.id, agent.token, { kind: 'file_change', title: content, rationale: 'r', client_request_id: randomUUID(), ops: [{ op: 'put', path: 'notes/a.md', content }] });
    const first = await change(one, 'first\n');
    const second = await change(two, 'second\n');
    expect(first.proposal.risk).toBe('modifying');
    await roles.processDue(); // both judged and sent to review: each other's reviewer
    const view = async (id: string) => (await db!.select().from(agentRoleProposals).where(eq(agentRoleProposals.id, id)))[0]!;
    await roles.review(two.id, two.token, { proposal_id: first.proposal.id, verdict: 'accept', reason: 'fine', expected_version: (await view(first.proposal.id)).version });
    expect((await view(first.proposal.id)).status).toBe('applied');
    await roles.review(one.id, one.token, { proposal_id: second.proposal.id, verdict: 'accept', reason: 'fine', expected_version: (await view(second.proposal.id)).version });
    const loser = await view(second.proposal.id);
    expect(loser.status).toBe('superseded');
    expect(loser.decisionNote).toContain('proposal_base_stale');

    // Frozen: nothing publishes. The operator veto reverts an applied proposal.
    const detail = await roles.detailAdmin('ztest-design');
    await roles.updateRole('ztest-design', { policy: { mutation: 'frozen' }, expected_version: detail.role.version });
    const frozen = await roles.propose(one.id, one.token, { kind: 'note', title: 'n', rationale: 'r', client_request_id: randomUUID(), ops: [{ op: 'put', path: 'notes/new.md', content: 'x' }] });
    expect(frozen.proposal.status).toBe('held');
    const applied = await view(first.proposal.id);
    const veto = await roles.decide(applied.id, { verdict: 'reject', reason: 'regressed reviews', expected_version: applied.version }, admin);
    expect(veto).toMatchObject({ vetoed: true, version: 3 });
    expect((await roles.readResource('role://ztest-design@3/notes/a.md')).contents[0]!.text).toBe('v1\n');
    const held = await view(frozen.proposal.id);
    await roles.decide(held.id, { verdict: 'accept', reason: 'operator steer', expected_version: held.version }, admin);
    expect((await view(held.id)).status).toBe('applied');
  });

  it('ends a role when the address is rebound without its transcript, and withdraws a faulty version', async () => {
    await publishedRole();
    const designer = await launch();
    await activate(designer);
    await roles.saveDraft('ztest-design', { manifest: MANIFEST('v2') }, admin);
    await roles.publishDraft('ztest-design', {}, admin);
    await roles.withdraw('ztest-design', 2, { reason: 'bad advice' });
    expect((await roles.catalog()).roles.find((role) => role.slug === 'ztest-design')?.current_version).toBe(1);
    await expect(activate(await launch(), { version: 2 })).rejects.toMatchObject({ code: 'role_version_withdrawn' });

    await db!.update(agentSessions).set({ endedAt: nowIso() }).where(eq(agentSessions.id, designer.id));
    await db!.update(agentBusAddresses).set({ currentSessionId: null }).where(eq(agentBusAddresses.id, designer.address));
    await messaging.registerSession(host, {
      sessionId: randomUUID(), bridgeToken: randomBytes(32).toString('base64url'), engine: 'claude', username: 'role-user', cwd: '/repo',
      invocationKind: 'interactive', requestedAddress: `agent:${designer.address}`, continuity: 'reset',
    });
    const [assignment] = await db!.select().from(agentRoleAssignments).where(eq(agentRoleAssignments.addressId, designer.address));
    expect(assignment).toMatchObject({ status: 'ended', endReason: 'continuity_reset', activeAddressId: null });
  });
});
