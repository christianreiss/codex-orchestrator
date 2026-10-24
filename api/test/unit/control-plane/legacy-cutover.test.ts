import { mkdtemp, writeFile, chmod, symlink, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readLegacyCutoverManifest,
  filterLegacyCutoverManifest,
  legacyCutoverSessionIdentity,
  type LegacyCutoverManifest,
} from '../../../src/control-plane/legacy-cutover.js';
import { legacyResourceIdentity, legacyGitIdentity } from '../../../src/control-plane/legacy-drain.js';
import { OwnerStateSnapshot } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { sha256 } from '../../../src/security/hash.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function fixture() {
  const now = Date.now(),
    capturedAt = now - 120000,
    id = randomUUID(),
    claimId = randomUUID(),
    gitId = randomUUID();
  const seed: Record<string, Array<Record<string, unknown>>> = {
    hosts: [
      {
        id: 1,
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        apiKey: 'fixture',
        apiKeyHash: null,
        expiresAt: null,
        ip4: null,
        ip6: null,
        allowRoamingIps: 0,
        reverseDnsMode: null,
      },
    ],
    agentSessions: [
      {
        id,
        hostId: 1,
        username: 'user',
        engine: 'codex',
        bindingGeneration: 1,
        bridgeTokenHash: sha256('bridge'),
        hostAuthFingerprint: sha256('fixture'),
        expiresAt: new Date(now + 600000).toISOString(),
        endedAt: null,
        adapterCapabilities: {},
      },
    ],
    agentNativeControls: [
      {
        sessionId: id,
        instanceId: randomUUID(),
        bindingGeneration: 1,
        status: 'ready',
        updatedAt: new Date(capturedAt).toISOString(),
      },
    ],
    agentResourceClaims: [
      {
        id: claimId,
        sessionId: id,
        generation: 1,
        nativeInstanceId: null,
        ownershipMode: 'timed',
        requestId: randomUUID(),
        resources: [],
        createdAt: new Date(capturedAt - 1000).toISOString(),
        expiresAt: new Date(capturedAt + 60000).toISOString(),
        state: 'uncertain',
        uncertaintyReason: 'owner_restart',
      },
    ],
    gitWorktrees: [
      {
        id: gitId,
        agentSessionId: id,
        agentBindingGeneration: 1,
        nativeInstanceId: null,
        ownershipMode: 'timed',
        hostId: 1,
        username: 'user',
        engine: 'codex',
        cloneId: randomUUID(),
        worktreePath: '/repo',
        worktreeHash: sha256('/repo'),
        registeredAt: new Date(capturedAt - 1000).toISOString(),
        expiresAt: new Date(capturedAt + 60000).toISOString(),
        status: 'uncertain',
        uncertaintyReason: 'owner_restart',
        releasedAt: null,
      },
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
  };
  const snapshot = () =>
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed);
  const state = snapshot(),
    session = JSON.parse(JSON.stringify(legacyCutoverSessionIdentity(state, id))) as unknown[];
  const manifest: LegacyCutoverManifest = {
    version: 1,
    database: 'test',
    capturedAt: new Date(capturedAt).toISOString(),
    entries: [
      {
        kind: 'resource',
        id: claimId,
        identity: JSON.parse(legacyResourceIdentity(state.claims.get(claimId)!)) as unknown[],
        session,
        securityDeadline: now + 300000,
      },
      {
        kind: 'git',
        id: gitId,
        identity: JSON.parse(legacyGitIdentity(state.table('gitWorktrees').get(gitId)!)) as unknown[],
        session,
        securityDeadline: now + 300000,
      },
    ],
  };
  return { now, id, claimId, gitId, seed, snapshot, manifest };
}
async function file(manifest: LegacyCutoverManifest) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-cutover-'));
  roots.push(root);
  const path = join(root, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  return { root, path };
}
describe('private quiescent legacy drain manifest', () => {
  it('loads a private exact-database manifest and treats only missing files as empty', async () => {
    const h = fixture(),
      { path, root } = await file(h.manifest);
    expect(await readLegacyCutoverManifest(path, 'test', h.now)).toEqual(h.manifest);
    expect(await readLegacyCutoverManifest(join(root, 'absent'), 'test', h.now)).toBeNull();
    await expect(readLegacyCutoverManifest(path, 'other', h.now)).rejects.toThrow('database');
  });
  it('rejects public permissions, symlinks and oversized files', async () => {
    const h = fixture(),
      { path, root } = await file(h.manifest);
    await chmod(path, 0o644);
    await expect(readLegacyCutoverManifest(path, 'test', h.now)).rejects.toThrow('private');
    await chmod(path, 0o600);
    const link = join(root, 'link');
    await symlink(path, link);
    await expect(readLegacyCutoverManifest(link, 'test', h.now)).rejects.toThrow();
    await truncate(path, 32 * 1024 * 1024 + 1);
    await expect(readLegacyCutoverManifest(path, 'test', h.now)).rejects.toThrow('size');
  });
  it.each(['malformed', 'future', 'duplicate', 'count'] as const)(
    'rejects %s manifest without leaking its content',
    async (kind) => {
      const h = fixture(),
        { path } = await file(h.manifest);
      if (kind === 'malformed') await writeFile(path, '{"secret":"do-not-echo",');
      else {
        if (kind === 'future') h.manifest.capturedAt = new Date(h.now + 100000).toISOString();
        if (kind === 'duplicate') h.manifest.entries.push(h.manifest.entries[0]!);
        if (kind === 'count')
          h.manifest.entries = Array.from({ length: 100001 }, () => ({
            ...h.manifest.entries[0]!,
            identity: Array.from({ length: 7 }, () => null),
            session: Array.from({ length: 16 }, () => null),
          }));
        await writeFile(path, JSON.stringify(h.manifest));
      }
      await expect(readLegacyCutoverManifest(path, 'test', h.now)).rejects.toThrow(
        kind === 'count' ? /schema/ : /Legacy|legacy|Invalid/,
      );
    },
  );
  it('filters exact grants valid at quiescence even after old heartbeat TTL, retaining the original cap', () => {
    const h = fixture(),
      result = filterLegacyCutoverManifest(h.manifest, h.snapshot(), h.now);
    expect(result.resourceClaimIds).toEqual([h.claimId]);
    expect(result.gitRegistrationIds).toEqual([h.gitId]);
    expect(result.securityDeadlines?.[h.id]).toBe(h.now + 300000);
    expect(filterLegacyCutoverManifest(null, h.snapshot(), h.now)).toEqual({});
  });
  it.each([
    'instance',
    'binding',
    'host-policy',
    'resource',
    'uncertain',
    'expired-before-capture',
    'security-expired',
  ] as const)('does not adopt %s evidence', (kind) => {
    const h = fixture();
    if (kind === 'instance') h.seed.agentNativeControls![0]!.instanceId = randomUUID();
    if (kind === 'binding') h.seed.agentSessions![0]!.bindingGeneration = 2;
    if (kind === 'host-policy') h.seed.hosts![0]!.allowRoamingIps = 1;
    if (kind === 'resource') {
      h.seed.agentResourceClaims![0]!.resources = ['different'];
      h.seed.gitWorktrees![0]!.worktreePath = '/other';
    }
    if (kind === 'uncertain') {
      h.seed.agentResourceClaims![0]!.uncertaintyReason = 'reported_unknown';
      h.seed.gitWorktrees![0]!.uncertaintyReason = 'disconnected';
    }
    if (kind === 'expired-before-capture') {
      h.seed.agentResourceClaims![0]!.expiresAt = new Date(
        Date.parse(h.manifest.capturedAt) - 1,
      ).toISOString();
      h.seed.gitWorktrees![0]!.expiresAt = h.seed.agentResourceClaims![0]!.expiresAt;
    }
    if (kind === 'security-expired')
      for (const entry of h.manifest.entries) entry.securityDeadline = h.now - 1;
    const result = filterLegacyCutoverManifest(h.manifest, h.snapshot(), h.now);
    expect(result.resourceClaimIds).toEqual([]);
    expect(result.gitRegistrationIds).toEqual([]);
  });
});
