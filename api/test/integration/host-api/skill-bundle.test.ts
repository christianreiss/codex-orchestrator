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
  skills as skillsTable,
} from '../../../src/db/schema.js';
import { renderSkillFile } from '../../../src/services/host-skills.js';
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
    id: 1, fqdn: 'host.example', apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyEnc: null,
    status: 'active', secure: 1, allowRoamingIps: 0, reverseDnsMode: null, apiCalls: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', engines, vip: 0,
    scalingExempt: 0, curlInsecure: 0, browserosMcpEnabled: 0, configVersion: 0, wrapperTrack: 'v2',
    lastRefresh: null, authDigest: null, ip4: null, ip6: null, insecureEnabledUntil: null,
    insecureGraceUntil: null, insecureWindowMinutes: null, insecureRequestedAt: null, lanePreference: null,
    modelOverride: null, reasoningEffortOverride: null, autoUpdateOverride: 0, lastCronCheck: null,
    claudeLastRefresh: null, claudeClientVersion: null, claudeClientVersionOverride: null,
    claudeWrapperVersion: null, claudeAuthDigest: null, claudeModelOverride: null,
    claudeReasoningEffortOverride: null, clientVersion: null, clientVersionOverride: null,
    wrapperVersion: null, agentsDocumentIdOverride: null,
  };
}

function skillRow(over: Record<string, unknown>): Record<string, unknown> {
  const manifest = String(over.manifest ?? '');
  return {
    id: 0, slug: 'x', sha256: createHash('sha256').update(manifest).digest('hex'),
    displayName: null, description: null, manifest, sourceHostId: null,
    createdAt: 't', updatedAt: 't', deletedAt: null, engine: null, ...over,
  };
}

function baseTables(apiKey: string, engines: string) {
  const db = createDbShim();
  db.tables.set(hostsTable, [hostRow(apiKey, engines)]);
  db.tables.set(versionsTable, []);
  db.tables.set(agentsDocuments, []);
  db.tables.set(clientConfigDocuments, []);
  db.tables.set(claudeArtifacts, []);
  return db;
}

async function bootstrap(db: ReturnType<typeof createDbShim>, apiKey: string, engine: string, payload: Record<string, unknown> = {}) {
  const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
  const r = await app.inject({
    method: 'POST',
    url: '/sync/bootstrap',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ engine, include_auth: false, ...payload }),
  });
  await app.close();
  return r;
}

describe('POST /sync/bootstrap claude_skills bundle', () => {
  it('renders claude-visible skills as SKILL.md, coerces name to slug, excludes codex-only + deleted', async () => {
    const apiKey = 'sk-claude-skills';
    const db = baseTables(apiKey, 'claude');
    db.tables.set(skillsTable, [
      skillRow({ id: 1, slug: 'git-commit', manifest: 'Run a tidy git commit.', engine: null }), // raw, no frontmatter
      skillRow({ id: 2, slug: 'reviewer', manifest: '---\nname: "Code Reviewer"\ndescription: Reviews code\n---\n\nReview.\n', engine: 'claude' }),
      skillRow({ id: 3, slug: 'codex-only', manifest: 'codex thing', engine: 'codex' }),
      skillRow({ id: 4, slug: 'gone', manifest: 'deleted', engine: null, deletedAt: 't-del' }),
    ]);
    const r = await bootstrap(db, apiKey, 'claude');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.claude_skills).toBeDefined();
    const slugs = body.claude_skills.map((s: { slug: string }) => s.slug).sort();
    expect(slugs).toEqual(['git-commit', 'reviewer']); // codex-only + deleted excluded

    const git = body.claude_skills.find((s: { slug: string }) => s.slug === 'git-commit');
    expect(git.content.startsWith('---\n')).toBe(true);
    expect(git.content).toContain('name: git-commit'); // slug, with frontmatter synthesised

    const reviewer = body.claude_skills.find((s: { slug: string }) => s.slug === 'reviewer');
    expect(reviewer.content).toContain('name: reviewer'); // rewritten to slug
    expect(reviewer.content).not.toContain('Code Reviewer'); // human display name NOT used as name
    expect(reviewer.content).toContain('description: Reviews code'); // preserved
  });

  it('omits content when the wrapper digest matches the rendered SKILL.md sha', async () => {
    const apiKey = 'sk-claude-skills-inm';
    const db = baseTables(apiKey, 'claude');
    const row = skillRow({ id: 1, slug: 'noop', manifest: 'does nothing', engine: null });
    db.tables.set(skillsTable, [row]);
    const renderedSha = createHash('sha256').update(renderSkillFile(row as never)).digest('hex');
    const r = await bootstrap(db, apiKey, 'claude', { skills: { noop: renderedSha } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    const noop = body.claude_skills.find((s: { slug: string }) => s.slug === 'noop');
    expect(noop.status).toBe('unchanged');
    expect(noop.content).toBeUndefined();
  });

  it('does NOT include claude_skills for codex hosts', async () => {
    const apiKey = 'sk-codex-noskills';
    const db = baseTables(apiKey, 'codex');
    db.tables.set(skillsTable, [skillRow({ id: 1, slug: 'git-commit', manifest: 'x', engine: null })]);
    const r = await bootstrap(db, apiKey, 'codex');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.claude_skills).toBeUndefined();
  });
});
