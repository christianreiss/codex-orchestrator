import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { createHash } from 'node:crypto';
import { registerMcpRoutes } from '../../../src/routes/mcp/index.js';
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

type HostApiTestApp = Awaited<ReturnType<typeof buildHostApiTestApp>>;

async function callSkillTool(
  app: HostApiTestApp,
  apiKey: string,
  engine: 'codex' | 'claude',
  name: 'skill_list' | 'skill_retrieve' | 'skill_store' | 'skill_delete' | 'resource_read',
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-engine': engine,
    },
    payload: {
      jsonrpc: '2.0',
      id: `${engine}-${name}`,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const rpc = response.json() as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ text?: unknown }> };
  };
  expect(rpc.error).toBeUndefined();
  expect(rpc.result?.isError).toBe(false);
  const text = rpc.result?.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

async function listedSkillSlugs(
  app: HostApiTestApp,
  apiKey: string,
  engine: 'codex' | 'claude',
): Promise<string[]> {
  const result = await callSkillTool(app, apiKey, engine, 'skill_list', {});
  expect(result['engine']).toBe(engine);
  expect(Array.isArray(result['skills'])).toBe(true);
  return (result['skills'] as Array<{ slug?: unknown }>)
    .map((skill) => skill.slug)
    .filter((slug): slug is string => typeof slug === 'string');
}

async function readSkillResource(
  app: HostApiTestApp,
  apiKey: string,
  engine: 'codex' | 'claude',
  slug: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-engine': engine,
    },
    payload: {
      jsonrpc: '2.0',
      id: `${engine}-resource-read`,
      method: 'resources/read',
      params: { uri: `skill://${slug}` },
    },
  });
  expect(response.statusCode).toBe(200);
  const rpc = response.json() as {
    error?: unknown;
    result?: { contents?: Array<{ text?: unknown }> };
  };
  expect(rpc.error).toBeUndefined();
  const text = rpc.result?.contents?.[0]?.text;
  expect(typeof text).toBe('string');
  return text as string;
}

async function bootstrapClaudeSkills(
  app: HostApiTestApp,
  apiKey: string,
): Promise<Array<{ slug: string; status: string; content?: string }>> {
  const response = await app.inject({
    method: 'POST',
    url: '/sync/bootstrap',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ engine: 'claude', include_auth: false }),
  });
  expect(response.statusCode).toBe(200);
  return response.json().claude_skills as Array<{ slug: string; status: string; content?: string }>;
}

describe('fresh Codex Skill bootstrap', () => {
  it('routes zero-knowledge agents to authoritative MCP Skill management first', async () => {
    const apiKey = 'sk-codex-mcp-first';
    const agentsBody = '# Fleet rules\n';
    const configBody = 'model = "gpt-5.6-terra"\n';
    const db = baseTables(apiKey, 'codex');
    db.tables.set(skillsTable, []);
    db.tables.set(agentsDocuments, [{
      id: 7,
      engine: 'codex',
      slug: 'main',
      body: agentsBody,
      sha256: createHash('sha256').update(agentsBody).digest('hex'),
      size: agentsBody.length,
      createdAt: '2026-07-31T00:00:00Z',
      updatedAt: '2026-07-31T00:00:00Z',
    }]);
    db.tables.set(clientConfigDocuments, [{
      id: 9,
      engine: 'codex',
      slug: 'main',
      body: configBody,
      sha256: createHash('sha256').update(configBody).digest('hex'),
      size: configBody.length,
      settings: { orchestrator_mcp_enabled: true, mcp_servers: [] },
      createdAt: '2026-07-31T00:00:00Z',
      updatedAt: '2026-07-31T00:00:00Z',
    }]);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as never, env, keyring });
    await registerMcpRoutes(app, { db: db as never, env, keyring });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/sync/bootstrap',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ engine: 'codex', include_auth: false }),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      const agents = String((body['agents'] as Record<string, unknown>)['content']);
      const config = String((body['config'] as Record<string, unknown>)['content']);

      expect((body['agents'] as Record<string, unknown>)['status']).toBe('updated');
      expect(agents).toMatch(/orchestrator MCP is authoritative/i);
      expect(agents).toMatch(/call `skill_list` first/i);
      expect(agents).toMatch(/before reading any host-local or system/i);
      expect(agents).toContain('skill://skill-manager');
      expect(agents).toContain('built-in `skill-creator`');
      expect((body['config'] as Record<string, unknown>)['status']).toBe('updated');
      expect(config).toContain('[mcp_servers.cdx]');
      expect(config).toContain('url = "https://o.example/mcp"');
      expect(config).toContain('X-Engine = "codex"');
      expect(config).toContain('[[skills.config]]');
      expect(config).toContain('name = "skill-creator"');
      expect(config).toContain('enabled = false');
      expect(body['claude_skills']).toBeUndefined();

      const list = await callSkillTool(app, apiKey, 'codex', 'skill_list', {});
      expect(list['skills']).toEqual(expect.arrayContaining([
        expect.objectContaining({
          slug: 'skill-manager',
          managed: true,
          uri: 'skill://skill-manager',
        }),
      ]));
      expect(
        (list['skills'] as Array<{ slug: string }>).some((skill) => skill.slug === 'skill-creator'),
      ).toBe(false);

      const resource = await callSkillTool(app, apiKey, 'codex', 'resource_read', {
        uri: 'skill://skill-manager',
      });
      const manifest = String(
        (resource['contents'] as Array<Record<string, unknown>>)[0]?.['text'],
      );
      expect(manifest).toContain('name: skill-manager');
      expect(manifest).toMatch(/how Skill management works/i);
      expect(manifest).toContain('built-in `skill-creator`');
      expect(manifest.indexOf('skill_list')).toBeLessThan(manifest.indexOf('skill_retrieve'));
      expect(manifest.indexOf('skill_retrieve')).toBeLessThan(manifest.indexOf('skill_store'));
    } finally {
      await app.close();
    }
  });
});

describe('POST /sync/bootstrap claude_skills bundle', () => {
  it('keeps one Skill lifecycle interoperable across Codex MCP and Claude bootstrap', async () => {
    const apiKey = 'sk-dual-engine-skill-crud';
    const slug = 'dual-engine-crud';
    const manifestHeader = `---
name: ${slug}
description: Shared lifecycle integration fixture
---

`;
    const manifestV1 = `${manifestHeader}Version one.\n`;
    const manifestV2 = `${manifestHeader}Version two.\n`;
    const db = baseTables(apiKey, 'codex,claude');
    db.tables.set(skillsTable, []);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as never, env, keyring });
    await registerMcpRoutes(app, { db: db as never, env, keyring });

    try {
      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'missing', slug });

      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_store', {
          slug,
          manifest: manifestV1,
          display_name: 'Dual-engine CRUD',
        }),
      ).resolves.toMatchObject({ status: 'created', slug });

      await expect(
        callSkillTool(app, apiKey, 'claude', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'updated', slug, manifest: manifestV1 });
      await expect(listedSkillSlugs(app, apiKey, 'codex')).resolves.toContain(slug);
      await expect(listedSkillSlugs(app, apiKey, 'claude')).resolves.toContain(slug);
      await expect(readSkillResource(app, apiKey, 'codex', slug)).resolves.toContain(manifestV1);
      expect(await bootstrapClaudeSkills(app, apiKey)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug, status: 'updated', content: expect.stringContaining('Version one.') }),
        ]),
      );

      await expect(
        callSkillTool(app, apiKey, 'claude', 'skill_store', { slug, manifest: manifestV2 }),
      ).resolves.toMatchObject({ status: 'updated', slug });
      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'updated', slug, manifest: manifestV2 });
      expect(await bootstrapClaudeSkills(app, apiKey)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug, status: 'updated', content: expect.stringContaining('Version two.') }),
        ]),
      );

      await expect(
        callSkillTool(app, apiKey, 'claude', 'skill_delete', { slug }),
      ).resolves.toMatchObject({ status: 'deleted', slug });
      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'deleted', slug });
      await expect(listedSkillSlugs(app, apiKey, 'codex')).resolves.not.toContain(slug);
      await expect(listedSkillSlugs(app, apiKey, 'claude')).resolves.not.toContain(slug);
      expect((await bootstrapClaudeSkills(app, apiKey)).some((skill) => skill.slug === slug)).toBe(false);

      await expect(
        callSkillTool(app, apiKey, 'claude', 'skill_store', { slug, manifest: manifestV1 }),
      ).resolves.toMatchObject({ status: 'updated', slug });
      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'updated', slug, manifest: manifestV1 });
      await expect(listedSkillSlugs(app, apiKey, 'codex')).resolves.toContain(slug);
      await expect(listedSkillSlugs(app, apiKey, 'claude')).resolves.toContain(slug);

      await expect(
        callSkillTool(app, apiKey, 'codex', 'skill_delete', { slug }),
      ).resolves.toMatchObject({ status: 'deleted', slug });
      await expect(
        callSkillTool(app, apiKey, 'claude', 'skill_retrieve', { slug }),
      ).resolves.toMatchObject({ status: 'deleted', slug });
    } finally {
      await app.close();
    }
  });

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
    // These are MANAGED skills: derived from code, not skills rows, and
    // unconditionally bundled to every Claude host.
    expect(slugs).toEqual(['afk', 'context', 'git-commit', 'reviewer', 'skill-manager']); // codex-only + deleted excluded

    const context = body.claude_skills.find((s: { slug: string }) => s.slug === 'context');
    expect(context.content).toContain('shared_memory_list');
    expect(context.content).toContain('~/.claude/projects');

    const skillManager = body.claude_skills.find((s: { slug: string }) => s.slug === 'skill-manager');
    expect(skillManager.content).toContain('skill_store');
    expect(skillManager.content).toContain('skill_delete');

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
