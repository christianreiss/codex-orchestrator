import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import { createHash } from 'node:crypto';
import {
  hosts as hostsTable,
  versions as versionsTable,
  agentsDocuments,
  clientConfigDocuments,
  claudeArtifacts,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const env = {
  INSTALLATION_ID: 'inst',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://o.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function hostRow(apiKey: string, engines: string): Record<string, unknown> {
  return {
    id: 1,
    fqdn: 'host.example',
    apiKey,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    apiCalls: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    engines,
    vip: 0,
    scalingExempt: 0,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    configVersion: 0,
    wrapperTrack: 'v2',
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    insecureRequestedAt: null,
    lanePreference: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    autoUpdateOverride: 0,
    lastCronCheck: null,
    claudeLastRefresh: null,
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: null,
    claudeReasoningEffortOverride: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
  };
}

const bodyReviewer = '---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review.\n';
const bodyDeploy = '---\ndescription: Deploys\n---\n\nDeploy it.\n';
const shaReviewer = createHash('sha256').update(bodyReviewer).digest('hex');
const shaDeploy = createHash('sha256').update(bodyDeploy).digest('hex');

function seedArtifacts(db: ReturnType<typeof createDbShim>) {
  db.tables.set(claudeArtifacts, [
    { id: 1, kind: 'subagent', slug: 'reviewer', sha256: shaReviewer, body: bodyReviewer, displayName: 'reviewer', description: 'Reviews code', model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: null },
    { id: 2, kind: 'subagent', slug: 'old', sha256: createHash('sha256').update('x').digest('hex'), body: 'x', displayName: null, description: null, model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: 't-deleted' },
    { id: 3, kind: 'command', slug: 'deploy', sha256: shaDeploy, body: bodyDeploy, displayName: null, description: 'Deploys', model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: null },
  ]);
}

function baseTables(apiKey: string, engines: string) {
  const db = createDbShim();
  db.tables.set(hostsTable, [hostRow(apiKey, engines)]);
  db.tables.set(versionsTable, []);
  db.tables.set(agentsDocuments, []);
  db.tables.set(clientConfigDocuments, []);
  return db;
}

describe('POST /sync/bootstrap claude_artifacts bundle', () => {
  it('bundles the live set for claude hosts, omitting content on sha match and excluding deleted', async () => {
    const apiKey = 'sk-claude-artifacts';
    const db = baseTables(apiKey, 'claude');
    seedArtifacts(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        include_auth: false,
        artifacts: { subagent: { reviewer: shaReviewer } },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.claude_artifacts).toBeDefined();
    expect(body.claude_artifacts.subagent.map((e: { slug: string }) => e.slug)).toEqual(['reviewer']);
    expect(body.claude_artifacts.subagent[0]).toMatchObject({ status: 'unchanged' });
    expect(body.claude_artifacts.subagent[0].content).toBeUndefined();
    expect(body.claude_artifacts.command[0]).toMatchObject({ slug: 'deploy', status: 'updated', content: bodyDeploy });
    expect(body.claude_artifacts['output-style']).toEqual([]);
    await app.close();
  });

  it('does NOT include claude_artifacts for codex hosts', async () => {
    const apiKey = 'sk-codex-noartifacts';
    const db = baseTables(apiKey, 'codex');
    seedArtifacts(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ engine: 'codex', include_auth: false }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.claude_artifacts).toBeUndefined();
    await app.close();
  });
});
