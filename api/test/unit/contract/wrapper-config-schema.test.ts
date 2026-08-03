import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableName, type Table } from 'drizzle-orm';

import type { Host } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { Keyring } from '../../../src/security/keyring.js';
import type { Engine } from '../../../src/util/engine.js';
import {
  createWrapperConfigService,
  type WrapperConfigPayload,
} from '../../../src/services/wrapper-config.js';
import type { WrapperSigner, WrapperSigningKeyService } from '../../../src/services/wrapper-signing-key.js';
import type {
  WrapperBinRegistry,
  BinaryBuild,
  PlatformManifest,
} from '../../../src/services/wrapper-bin-registry.js';

/**
 * `wrappers/schemas/host-config-v1.json` is the declared contract for the
 * per-host config blob — `docs/interface-cdx.md` tells anyone adding a field to
 * update it first — but nothing served or verified the baked payload against
 * it, so `host.engines`/`host.engines_list` shipped fleet-wide for months while
 * the schema's `additionalProperties: false` said they could not exist.
 *
 * So the payload `wrapper-config.ts` actually bakes is diffed against the
 * schema: for the root object and every nested object the schema closes with
 * `additionalProperties: false`, an emitted key with no declared property and a
 * `required` key with nothing emitted both fail with the offending `path.key`.
 * The next field baked without a schema entry fails here, not in the fleet.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const schema = JSON.parse(
  readFileSync(resolve(ROOT, 'wrappers/schemas/host-config-v1.json'), 'utf8'),
) as SchemaNode;

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
}

interface SchemaDiff {
  /** Emitted keys with no declared property, as `path.key`. */
  undeclared: string[];
  /** Declared-`required` keys the payload omits, as `path.key`. */
  missing: string[];
  /** Closed objects the walk reached, so a walk that checks nothing is visible. */
  visited: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Walks payload and schema in lockstep, collecting both halves of the contract. */
function diffAgainstSchema(value: unknown, node: SchemaNode = schema): SchemaDiff {
  const diff: SchemaDiff = { undeclared: [], missing: [], visited: [] };

  const walk = (current: unknown, at: SchemaNode, path: string): void => {
    if (Array.isArray(current)) {
      if (!at.items) return;
      current.forEach((item, index) => walk(item, at.items!, `${path}[${index}]`));
      return;
    }
    if (!isObject(current) || !at.properties) return;
    if (at.additionalProperties === false) {
      diff.visited.push(path || '(root)');
      const key = (name: string): string => (path ? `${path}.${name}` : name);
      for (const name of Object.keys(current)) {
        if (!(name in at.properties)) diff.undeclared.push(key(name));
      }
      for (const name of at.required ?? []) {
        if (!(name in current)) diff.missing.push(key(name));
      }
    }
    for (const [name, child] of Object.entries(at.properties)) {
      if (name in current) walk(current[name], child, path ? `${path}.${name}` : name);
    }
  };

  walk(value, node, '');
  return diff;
}

function fakeHost(): Host {
  return {
    id: 7,
    fqdn: 'host01.example.com',
    apiKey: 'sk-codex-fakekey1234',
    apiKeyHash: null,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
    apiCalls: 0,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    curlInsecure: 0,
    browserosMcpEnabled: 1,
    agentMessagingEnabled: 0,
    expiresAt: null,
    vip: 0,
    lanePreference: null,
    modelOverride: 'gpt-5.4',
    reasoningEffortOverride: 'high',
    autoUpdateOverride: null,
    lastCronCheck: null,
    scalingExempt: 0,
    engines: 'codex,claude',
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: 'claude-3-opus',
    claudeReasoningEffortOverride: null,
    claudeLastRefresh: null,
    configVersion: 4,
    configBakedAt: null,
    wrapperTrack: 'v2',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-15T00:00:00Z',
  };
}

/**
 * Fake DB that dispatches on the queried table, so the bake reaches its
 * fully-populated shape: both `documents` blocks non-null and a skill per
 * engine, otherwise the nested objects never get checked.
 */
function fakeDb(): Database {
  const rowsFor: Record<string, unknown[]> = {
    hosts: [{ configVersion: 4 }],
    agents_document_state: [{ id: 1, mode: 'active', activeDocumentId: 10, engine: 'codex' }],
    agents_documents: [{ id: 10, sha256: 'b'.repeat(64), updatedAt: '2026-05-01T00:00:00Z' }],
    client_config_documents: [{ id: 3, sha256: 'c'.repeat(64), updatedAt: '2026-05-01T00:00:00Z' }],
    skills: [
      { slug: 'codex-skill', sha256: 'd'.repeat(64), deletedAt: null, engine: 'codex' },
      { slug: 'claude-skill', sha256: 'e'.repeat(64), deletedAt: null, engine: 'claude' },
    ],
  };

  const chain = () => {
    let rows: unknown[] = [];
    const self = {
      from(table: unknown) {
        rows = rowsFor[getTableName(table as Table)] ?? [];
        return self;
      },
      where() {
        return self;
      },
      orderBy() {
        return self;
      },
      for() {
        return self;
      },
      async limit(n: number) {
        return rows.slice(0, n);
      },
    };
    return self;
  };

  const db = {
    select: () => chain(),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(db as unknown as Database),
  };
  return db as unknown as Database;
}

function fakeBinaries(): WrapperBinRegistry {
  const build: BinaryBuild = { version: '1.0.1', sha256: 'a'.repeat(64), size_bytes: 100 };
  return {
    async manifestForPlatform(): Promise<PlatformManifest | null> {
      return null;
    },
    async currentBuild() {
      return build;
    },
    async resolveCurrentBuild() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async resolveVersion() {
      return { ...build, artifact: 'cxx', path: '/fixtures/cxx' };
    },
    async latestVersion() {
      return '1.0.1';
    },
    async engineManifest() {
      return { engine: 'codex', platforms: {} };
    },
    async binaryDescriptor() {
      return null;
    },
    async openBinary() {
      throw new Error('not implemented');
    },
    invalidate() {},
  };
}

function fakeSigning(): WrapperSigningKeyService {
  const signer: WrapperSigner = {
    kid: '1',
    fingerprint: 'f'.repeat(64),
    publicKey: 'pk',
    sign: () => Buffer.alloc(64),
  };
  return {
    async active() {
      return signer;
    },
    async allActive() {
      return [signer];
    },
    async available() {
      return true;
    },
    invalidate() {},
  };
}

async function bake(engine: Engine): Promise<WrapperConfigPayload> {
  const svc = createWrapperConfigService({
    db: fakeDb(),
    // The host row carries a plaintext api_key, so nothing decrypts.
    keyring: {} as Keyring,
    binaries: fakeBinaries(),
    signing: fakeSigning(),
    installationId: 'inst-1',
  });
  const result = await svc.bakeForHost(fakeHost(), engine, 'https://api.example.com');
  return result.payload;
}

/** Every closed object the schema declares must be reached by a full bake. */
const CLOSED = [
  '(root)',
  'orchestrator',
  'host',
  'engine_options',
  'agent_messaging',
  'wrapper',
  'documents',
  'documents.agents',
  'documents.client_config',
  'skills[0]',
];

describe('baked wrapper config against host-config-v1.json', () => {
  for (const engine of ['codex', 'claude'] as const) {
    it(`emits only declared keys for engine=${engine}`, async () => {
      const diff = diffAgainstSchema(await bake(engine));
      expect(diff.visited.sort()).toEqual([...CLOSED].sort());
      expect(diff.undeclared).toEqual([]);
      expect(diff.missing).toEqual([]);
    });
  }

  it('reports the offending path.key for an undeclared and a dropped required key', async () => {
    const payload = await bake('codex');
    const mutated = payload as unknown as {
      host: Record<string, unknown>;
      wrapper: Record<string, unknown>;
    };
    mutated.host.peers = ['host02.example.com'];
    delete mutated.wrapper.track;

    const diff = diffAgainstSchema(payload);
    expect(diff.undeclared).toEqual(['host.peers']);
    expect(diff.missing).toEqual(['wrapper.track']);
  });
});
