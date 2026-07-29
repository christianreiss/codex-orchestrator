import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { createHash } from 'node:crypto';
import {
  hosts as hostsTable,
  versions as versionsTable,
  agentsDocuments,
  clientConfigDocuments,
  claudeArtifacts,
  skills as skillsTable,
  skillFiles,
} from '../../../src/db/schema.js';
import { renderSkillFile } from '../../../src/services/host-skills.js';
import { computeSkillBundleDigest } from '../../../src/services/skill-provenance.js';
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
  const db = createDbFake();
  db.tables.set(hostsTable, [hostRow(apiKey, engines)]);
  db.tables.set(versionsTable, []);
  db.tables.set(agentsDocuments, []);
  db.tables.set(clientConfigDocuments, []);
  db.tables.set(claudeArtifacts, []);
  db.tables.set(skillFiles, []);
  return db;
}

async function bootstrap(db: ReturnType<typeof createDbFake>, apiKey: string, engine: string, payload: Record<string, unknown> = {}) {
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
    // `context` is a MANAGED skill: derived from code, not a skills row, and
    // unconditionally bundled so every Claude host gets the memory-routing
    // instructions on disk without an admin ever storing it.
    expect(slugs).toEqual(['context', 'git-commit', 'reviewer']); // codex-only + deleted excluded

    const context = body.claude_skills.find((s: { slug: string }) => s.slug === 'context');
    expect(context.content).toContain('shared_memory_list');
    expect(context.content).toContain('~/.claude/projects');

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

  it('delivers the complete external skill directory and caches it by bundle digest', async () => {
    const apiKey = 'sk-claude-source-bundle';
    const db = baseTables(apiKey, 'claude');
    const manifest = '---\nname: tdd\ndescription: Test driven development\n---\n\nRead references/red-green.md.\n';
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    const guideContent = '# Red, green, refactor';
    const guideSha = createHash('sha256').update(guideContent).digest('hex');
    const licenseContent = 'MIT License';
    const licenseSha = createHash('sha256').update(licenseContent).digest('hex');
    const bundleSha = computeSkillBundleDigest([
      { path: 'SKILL.md', sha256: manifestSha },
      { path: 'references/red-green.md', sha256: guideSha },
      { path: 'LICENSE.mattpocock', sha256: licenseSha },
    ]);
    db.tables.set(skillsTable, [
      skillRow({
        id: 7,
        slug: 'tdd',
        manifest,
        engine: null,
        sourceType: 'github:mattpocock/skills',
        sourceRepository: 'https://github.com/mattpocock/skills',
        sourcePath: 'skills/engineering/tdd',
        sourceRevision: 'a'.repeat(40),
        sourceLicense: 'MIT',
        bundleSha256: bundleSha,
      }),
    ]);
    db.tables.set(skillFiles, [
      {
        id: 1,
        skillId: 7,
        path: 'references/red-green.md',
        sha256: guideSha,
        content: guideContent,
        createdAt: 't',
        updatedAt: 't',
      },
      {
        id: 2,
        skillId: 7,
        path: 'LICENSE.mattpocock',
        sha256: licenseSha,
        content: licenseContent,
        createdAt: 't',
        updatedAt: 't',
      },
    ]);

    const updated = await bootstrap(db, apiKey, 'claude');
    expect(updated.statusCode).toBe(200);
    expect(updated.json().claude_skills.find((item: { slug: string }) => item.slug === 'tdd')).toMatchObject({
      status: 'updated',
      sha256: bundleSha,
      manifest_sha256: manifestSha,
      content: expect.stringContaining('name: tdd'),
      files: [
        { path: 'references/red-green.md', content: '# Red, green, refactor' },
        { path: 'LICENSE.mattpocock', content: 'MIT License' },
      ],
    });

    const unchanged = await bootstrap(db, apiKey, 'claude', { skills: { tdd: bundleSha } });
    expect(unchanged.json().claude_skills.find((item: { slug: string }) => item.slug === 'tdd')).toEqual({
      slug: 'tdd',
      sha256: bundleSha,
      status: 'unchanged',
    });
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
