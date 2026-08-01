import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  agentsDocuments,
  agentsDocumentState,
  clientConfigDocuments,
  logs,
  mcpSessionTokens,
  secrets,
  versions,
} from '../../../src/db/schema.js';
import type { Host } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { HostAgentsService } from '../../../src/services/host-agents.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

// Trailing slash on purpose: the constructor strips it, so every managed MCP
// url below must come out as `<base>/mcp` with a single slash.
const BASE_URL = 'https://api.example/';
const PLAIN_KEY = 'plain-host-key';
const LEGACY_HASHED_KEY = 'a'.repeat(64);

function sha(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function makeHost(overrides: Record<string, unknown> = {}): Host {
  return {
    id: 7,
    fqdn: 'host.example',
    apiKey: PLAIN_KEY,
    apiKeyHash: null,
    apiKeyEnc: null,
    secure: 1,
    agentsDocumentIdOverride: null,
    ...overrides,
  } as unknown as Host;
}

function agentsRow(id: number, body: string, engine: string = ENGINE_CODEX): Record<string, unknown> {
  return {
    id,
    sha256: sha(body),
    body,
    sourceHostId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    engine,
  };
}

function configRow(
  id: number,
  engine: string,
  settings: Record<string, unknown>,
  body = 'raw body\n',
): Record<string, unknown> {
  return {
    id,
    sha256: sha(body),
    body,
    settings,
    sourceHostId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    engine,
  };
}

/**
 * The db-fake resolves `.orderBy(desc(id)).limit(1)` as "first matching row",
 * so every table below is seeded newest-first to stand in for `ORDER BY id DESC`.
 */
function makeDb(rows: Array<[unknown, Record<string, unknown>[]]>): DbFake {
  const db = createDbFake();
  for (const [table, list] of rows) db.tables.set(table, list);
  return db;
}

function makeService(db: DbFake, deps: { keyring?: Keyring | null; publicBaseUrl?: string | null } = {}): HostAgentsService {
  return new HostAgentsService(db as never, {
    publicBaseUrl: deps.publicBaseUrl === undefined ? BASE_URL : deps.publicBaseUrl,
    keyring: deps.keyring ?? null,
  });
}

function logDetails(db: DbFake, action: string): Array<Record<string, unknown>> {
  return db.inserts
    .filter((entry) => entry.table === logs && !Array.isArray(entry.values) && entry.values['action'] === action)
    .map((entry) => JSON.parse(String((entry.values as Record<string, unknown>)['details'])) as Record<string, unknown>);
}

function bearerFrom(content: string): string {
  return /Bearer ([^"\s\\]+)/.exec(content)?.[1] ?? '';
}

function issuedTokenHashes(db: DbFake): string[] {
  return db.inserts
    .filter((entry) => entry.table === mcpSessionTokens && !Array.isArray(entry.values))
    .map((entry) => String((entry.values as Record<string, unknown>)['token']));
}

function clxAuthHeader(partial: Record<string, unknown>): string {
  const servers = partial['mcpServers'] as Record<string, { url?: string; headers?: Record<string, string> }> | undefined;
  return servers?.['clx']?.headers?.['Authorization'] ?? '';
}

describe('HostAgentsService.retrieve', () => {
  it('returns missing and logs agents.retrieve when no document exists', async () => {
    const db = makeDb([[agentsDocuments, []]]);

    const out = await makeService(db).retrieve(null, makeHost());

    expect(out).toEqual({ status: 'missing' });
    expect(logDetails(db, 'agents.retrieve')).toEqual([{ status: 'missing' }]);
  });

  it('serves the canonical body plus enabled Codex feature guidance', async () => {
    const body = 'Canonical AGENTS body\n';
    const db = makeDb([
      [agentsDocuments, [agentsRow(4, body)]],
      [clientConfigDocuments, [configRow(1, ENGINE_CODEX, { orchestrator_mcp_enabled: true })]],
      [versions, [{ name: 'projects_module_enabled', version: '1' }]],
    ]);

    const out = await makeService(db).retrieve(null, makeHost({ browserosMcpEnabled: 1 }));

    const served = String(out['content']);
    expect(out['status']).toBe('updated');
    expect(served).toContain(body.trim());
    expect(served).toContain('<!-- cxx:managed-features:start -->');
    expect(served).toContain('skill_list');
    expect(served).toContain('shared_memory_list');
    expect(served).toContain('#coco');
    expect(served).toContain('BrowserOS');
    expect(out['version_id']).toBe(4);
    expect(out['sha256']).toBe(sha(served));
    expect(out['base_sha256']).toBe(sha(body));
    expect(out['managed_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(out['sections']).toMatchObject({
      skills: { present: true, transport: 'mcp' },
      memories: { present: true },
      memory_routing: { present: true },
      projects: { present: true },
      browseros: { present: true },
    });
    expect(out['sha256']).not.toBe(out['base_sha256']);
    expect(out['sha256']).not.toBe(out['managed_sha256']);
    expect(out['size_bytes']).toBe(Buffer.byteLength(served, 'utf8'));
    expect(logDetails(db, 'agents.retrieve')).toEqual([{ status: 'updated', engine: ENGINE_CODEX }]);
  });

  it('reports unchanged only for the sha of the effective rendered document', async () => {
    const body = 'Canonical AGENTS body\n';
    const row = agentsRow(4, body);
    const rows: Array<[unknown, Record<string, unknown>[]]> = [
      [agentsDocuments, [row]],
      [clientConfigDocuments, [configRow(1, ENGINE_CODEX, { orchestrator_mcp_enabled: true })]],
    ];
    const first = await makeService(makeDb(rows)).retrieve(null, makeHost());
    const servedSha = String(first['sha256']);

    const unchanged = await makeService(makeDb(rows)).retrieve(servedSha, makeHost());
    expect(unchanged['status']).toBe('unchanged');
    expect(unchanged).not.toHaveProperty('content');

    // A host whose on-disk copy predates the managed feature block holds the bare
    // canonical sha and must be told to update.
    const stale = await makeService(makeDb(rows)).retrieve(String(row['sha256']), makeHost());
    expect(stale['status']).toBe('updated');
    expect(stale['sha256']).toBe(servedSha);
  });

  it('uses Claude-native skills and omits Codex-only BrowserOS guidance', async () => {
    const body = 'Canonical CLAUDE body\n';
    const db = makeDb([
      [agentsDocuments, [agentsRow(4, body, ENGINE_CLAUDE)]],
      [clientConfigDocuments, [configRow(1, ENGINE_CLAUDE, { orchestrator_mcp_enabled: true })]],
    ]);

    const out = await makeService(db).retrieve(null, makeHost({ browserosMcpEnabled: 1 }), ENGINE_CLAUDE);

    expect(out['content']).toContain('~/.claude/skills/<slug>/SKILL.md');
    expect(out['content']).not.toContain('skill_list');
    expect(out['content']).not.toContain('BrowserOS');
    expect(out['sections']).toMatchObject({
      skills: { present: true, transport: 'native' },
      memories: { present: true },
      browseros: { present: false, reason: 'unsupported_engine' },
    });
  });

  it('removes stale managed guidance when MCP is disabled', async () => {
    const old = `Canonical AGENTS body\n\n<!-- cxx:managed-features:start -->\nold\n<!-- cxx:managed-features:end -->\n`;
    const db = makeDb([
      [agentsDocuments, [agentsRow(4, old)]],
      [clientConfigDocuments, [configRow(1, ENGINE_CODEX, { orchestrator_mcp_enabled: false })]],
      [versions, [{ name: 'projects_module_enabled', version: '1' }]],
    ]);

    const out = await makeService(db).retrieve(null, makeHost({ browserosMcpEnabled: 1 }));

    expect(out['content']).toBe('Canonical AGENTS body\n');
    expect(out['managed_sha256']).toBeNull();
    expect(out['sections']).toMatchObject({
      skills: { present: false, reason: 'mcp_disabled' },
      memories: { present: false, reason: 'mcp_disabled' },
      projects: { present: false, reason: 'mcp_disabled' },
      browseros: { present: false, reason: 'mcp_disabled' },
    });
  });
});

describe('HostAgentsService document resolution', () => {
  const docs = [agentsRow(9, 'newest codex'), agentsRow(5, 'newest claude', ENGINE_CLAUDE), agentsRow(3, 'pinned')];

  it('prefers a valid agentsDocumentIdOverride over the latest row', async () => {
    const db = makeDb([[agentsDocuments, docs]]);

    const out = await makeService(db).retrieve(null, makeHost({ agentsDocumentIdOverride: 3 }));

    expect(out['version_id']).toBe(3);
    expect(logDetails(db, 'agents.host_override_missing')).toEqual([]);
  });

  it('falls back to latest and logs agents.host_override_missing for a dangling override', async () => {
    const db = makeDb([[agentsDocuments, docs]]);

    const out = await makeService(db).retrieve(null, makeHost({ agentsDocumentIdOverride: 404 }));

    expect(out['version_id']).toBe(9);
    expect(logDetails(db, 'agents.host_override_missing')).toEqual([
      { status: 'fallback_latest', override_id: 404 },
    ]);
  });

  it('serves the locked document per engine state and the newest row otherwise', async () => {
    const state = [
      { id: 1, mode: 'locked', activeDocumentId: 3, createdAt: 'x', updatedAt: 'x', engine: ENGINE_CODEX },
      { id: 2, mode: 'latest', activeDocumentId: null, createdAt: 'x', updatedAt: 'x', engine: ENGINE_CLAUDE },
    ];
    const db = makeDb([[agentsDocuments, docs], [agentsDocumentState, state]]);
    const service = makeService(db);

    expect((await service.retrieve(null, makeHost()))['version_id']).toBe(3);
    // The claude state row (id 2) is on `latest`, so the codex lock must not
    // bleed across engines.
    expect((await service.retrieve(null, makeHost(), ENGINE_CLAUDE))['version_id']).toBe(5);
  });

  it('falls back to latest when the locked document is gone', async () => {
    const state = [{ id: 1, mode: 'locked', activeDocumentId: 77, createdAt: 'x', updatedAt: 'x', engine: ENGINE_CODEX }];
    const db = makeDb([[agentsDocuments, docs], [agentsDocumentState, state]]);

    expect((await makeService(db).retrieve(null, makeHost()))['version_id']).toBe(9);
  });

  it('falls back to any engine when no document matches the requested one', async () => {
    const db = makeDb([[agentsDocuments, [agentsRow(5, 'newest claude', ENGINE_CLAUDE)]]]);

    const out = await makeService(db).retrieve(null, makeHost());

    expect(out['version_id']).toBe(5);
  });
});

describe('HostAgentsService config surfaces', () => {
  const codexConfig = configRow(1, ENGINE_CODEX, { model: 'gpt-5.6-terra' });

  it('falls back to the codex client_config for a non-codex engine', async () => {
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);

    const out = await makeService(db).retrieveConfig(null, makeHost(), ENGINE_CLAUDE);

    expect(out['status']).toBe('updated');
    expect(out['version_id']).toBe(1);
    expect(String(out['content'])).toContain('gpt-5.6-terra');
  });

  it('never borrows the codex model for the Claude settings partial', async () => {
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);

    const out = await makeService(db).retrieveClaudeSettings(makeHost());

    const partial = out['partial'] as Record<string, unknown>;
    const ownedPaths = out['owned_paths'] as string[];
    expect(out['status']).toBe('updated');
    expect(JSON.stringify(partial)).not.toContain('gpt-5.6-terra');
    expect(partial).not.toHaveProperty('model');
    expect(ownedPaths).not.toContain('model');
    // Rendered from an EMPTY base, so the managed clx block still lands.
    expect(ownedPaths).toContain('mcpServers.clx');
    expect(clxAuthHeader(partial)).toBe(`Bearer ${PLAIN_KEY}`);
    expect(logDetails(db, 'claude_settings.retrieve')).toHaveLength(1);
  });

  it('uses the claude client_config when one exists', async () => {
    const db = makeDb([[clientConfigDocuments, [configRow(2, ENGINE_CLAUDE, { model: 'claude-opus-5' }), codexConfig]]]);

    const out = await makeService(db).retrieveClaudeSettings(makeHost());

    expect(out['partial']).toMatchObject({ model: 'claude-opus-5' });
    expect(out['owned_paths']).toContain('model');
  });

  it('reports missing config when no client_config row exists', async () => {
    const db = makeDb([[clientConfigDocuments, []]]);

    const out = await makeService(db).retrieveConfig(null, makeHost());

    expect(out).toEqual({ status: 'missing' });
    expect(logDetails(db, 'config.retrieve')).toEqual([{ status: 'missing' }]);
  });
});

describe('HostAgentsService api key resolution', () => {
  const codexConfig = configRow(1, ENGINE_CODEX, { model: 'gpt-5.6-terra' });

  it('treats a 64-char api_key equal to its hash as absent', async () => {
    const host = makeHost({ apiKey: LEGACY_HASHED_KEY, apiKeyHash: LEGACY_HASHED_KEY });
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);
    const service = makeService(db);

    const config = await service.retrieveConfig(null, host);
    expect(config['content']).toBe(codexConfig['body']);
    expect(config['sha256']).toBe(codexConfig['sha256']);

    const settings = await service.retrieveClaudeSettings(host);
    expect(settings).toEqual({ status: 'missing', owned_paths: [], partial: {} });
  });

  it('resolves the keyring-encrypted key', async () => {
    const keyring = Keyring.fromEnv({
      ENCRYPTION_ACTIVE_KEY: randomBytes(32).toString('base64'),
    } as unknown as Env);
    const host = makeHost({
      apiKey: LEGACY_HASHED_KEY,
      apiKeyHash: LEGACY_HASHED_KEY,
      apiKeyEnc: encrypt('keyring-key', keyring),
    });
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);

    const out = await makeService(db, { keyring }).retrieveConfig(null, host);

    expect(bearerFrom(String(out['content']))).toBe('keyring-key');
  });

  it('leaves the config unrendered without a public base url', async () => {
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);

    const out = await makeService(db, { publicBaseUrl: null }).retrieveConfig(null, makeHost());

    expect(out['content']).toBe(codexConfig['body']);
  });
});

describe('HostAgentsService managed MCP token', () => {
  const codexConfig = configRow(1, ENGINE_CODEX, { model: 'gpt-5.6-terra' });

  it('bakes the api key and issues no session token for a secure host', async () => {
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);

    const out = await makeService(db).retrieveConfig(null, makeHost({ secure: 1 }));

    expect(bearerFrom(String(out['content']))).toBe(PLAIN_KEY);
    expect(issuedTokenHashes(db)).toEqual([]);
  });

  it('issues a session token for an insecure host on both surfaces', async () => {
    const db = makeDb([[clientConfigDocuments, [codexConfig]]]);
    const host = makeHost({ secure: 0 });
    const service = makeService(db);

    const config = await service.retrieveConfig(null, host);
    const token = bearerFrom(String(config['content']));
    expect(token).not.toBe(PLAIN_KEY);
    expect(issuedTokenHashes(db)).toEqual([sha(token)]);

    const settings = await service.retrieveClaudeSettings(host);
    const claudeToken = clxAuthHeader(settings['partial'] as Record<string, unknown>).replace('Bearer ', '');
    expect(claudeToken).not.toBe(PLAIN_KEY);
    expect(issuedTokenHashes(db)).toEqual([sha(token), sha(claudeToken)]);
  });

  it('points the managed server at a single-slash /mcp url', async () => {
    const db = makeDb([[clientConfigDocuments, []]]);

    const out = await makeService(db).retrieveClaudeSettings(makeHost());
    const servers = (out['partial'] as Record<string, unknown>)['mcpServers'] as Record<string, { url?: string }>;

    expect(servers['clx']?.url).toBe('https://api.example/mcp');
  });
});

/**
 * The Secrets guidance gate. `resolveManagedFeatureContext` runs on every host
 * bootstrap, so two things matter beyond "does the text appear": the served
 * digest has to cover the augmented body (or hosts are told `unchanged` and
 * never write the block), and a failing secrets read has to degrade to a missing
 * section rather than a 500 on every sync in the fleet.
 */
describe('HostAgentsService secrets guidance', () => {
  const body = 'Canonical AGENTS body\n';
  const rowsFor = (
    versionRows: Array<Record<string, unknown>>,
    secretRows: Array<Record<string, unknown>>,
    engine: string = ENGINE_CODEX,
  ): Array<[unknown, Record<string, unknown>[]]> => [
    [agentsDocuments, [agentsRow(4, body, engine)]],
    [clientConfigDocuments, [configRow(1, engine, { orchestrator_mcp_enabled: true })]],
    [versions, versionRows],
    [secrets, secretRows],
  ];

  const liveSecret = {
    id: 1,
    slug: 'gh-pat',
    name: 'GitHub PAT',
    description: null,
    valueEnc: 'sbox:v1:kid=legacy:aaaa',
    engine: null,
    tags: null,
    tagsText: null,
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    lastRotatedAt: null,
    deletedAt: null,
  };
  const ON = { name: 'secrets_module_enabled', version: '1' };

  it('serves the block and covers it with the served digest', async () => {
    const db = makeDb(rowsFor([ON], [liveSecret]));
    const out = await makeService(db).retrieve(null, makeHost());
    const served = String(out['content']);

    expect(served).toContain('## Secrets');
    expect(served).toContain('secret_list');
    // The digest must be of the augmented body, not the canonical one, or a
    // host holding the canonical sha would be told `unchanged` forever.
    expect(out['sha256']).toBe(sha(served));
    expect(out['sha256']).not.toBe(out['base_sha256']);
    expect(out['size_bytes']).toBe(Buffer.byteLength(served, 'utf8'));
    expect(out['sections']).toMatchObject({ secrets: { present: true, reason: 'ok', count: 1 } });
  });

  it('serves the identical block to Claude', async () => {
    const db = makeDb(rowsFor([ON], [liveSecret], ENGINE_CLAUDE));
    const out = await makeService(db).retrieve(null, makeHost(), ENGINE_CLAUDE);

    expect(out['content']).toContain('## Secrets');
    expect(out['sections']).toMatchObject({ secrets: { present: true, reason: 'ok', count: 1 } });
  });

  it('serves the block for an empty enabled store so an agent can create the first secret', async () => {
    const db = makeDb(rowsFor([ON], []));
    const out = await makeService(db).retrieve(null, makeHost());

    expect(out['content']).toContain('secret_store');
    expect(out['sections']).toMatchObject({ secrets: { present: true, reason: 'ok', count: 0 } });
  });

  it.each([
    ['the flag row is absent entirely', [] as Array<Record<string, unknown>>, [liveSecret], 'secrets_disabled'],
    ['the flag is off', [{ name: 'secrets_module_enabled', version: '0' }], [liveSecret], 'secrets_disabled'],
  ])('withholds the block when %s', async (_label, versionRows, secretRows, reason) => {
    const db = makeDb(rowsFor(versionRows, secretRows));
    const out = await makeService(db).retrieve(null, makeHost());

    expect(String(out['content'])).not.toContain('## Secrets');
    expect(String(out['content'])).not.toContain('secret_get');
    expect(out['sections']).toMatchObject({ secrets: { present: false, reason } });
  });

  it('withholds the block when MCP itself is off, since the tools are unreachable', async () => {
    const db = makeDb([
      [agentsDocuments, [agentsRow(4, body)]],
      [clientConfigDocuments, [configRow(1, ENGINE_CODEX, { orchestrator_mcp_enabled: false })]],
      [versions, [ON]],
      [secrets, [liveSecret]],
    ]);
    const out = await makeService(db).retrieve(null, makeHost());
    expect(out['sections']).toMatchObject({ secrets: { present: false, reason: 'mcp_disabled' } });
  });

  it('still serves the document when the secrets table cannot be read', async () => {
    // A box mid-deploy whose `secrets` table does not exist yet must not 500
    // every host's bootstrap over a guidance paragraph.
    const db = makeDb(rowsFor([ON], [liveSecret]));
    const broken = {
      ...db,
      select: (...args: unknown[]) => {
        const builder = (db.select as (...a: unknown[]) => Record<string, unknown>)(...args);
        const from = builder['from'] as (table: unknown) => unknown;
        builder['from'] = (table: unknown) => {
          if (table === secrets) throw new Error("Table 'secrets' doesn't exist");
          return from.call(builder, table);
        };
        return builder;
      },
    };

    const out = await makeService(broken as unknown as DbFake).retrieve(null, makeHost());
    expect(out['status']).toBe('updated');
    expect(String(out['content'])).toContain('Canonical AGENTS body');
    expect(out['sections']).toMatchObject({
      secrets: { present: false, reason: 'service_unavailable' },
    });
  });
});
