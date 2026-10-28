import { afterEach, describe, expect, it } from 'vitest';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import * as schema from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import { Keyring } from '../../../src/security/keyring.js';
import { sha256 } from '../../../src/security/hash.js';
import { McpSessionService } from '../../../src/services/mcp-session.js';
import { createHostRegistrationService } from '../../../src/services/host-registration.js';
import type { InsecureWindowService } from '../../../src/services/insecure-window.js';
import { createDbFake } from '../../helpers/db-fake.js';

/**
 * Feedback e099e458 (c): insecure hosts get an 8-hour MCP session token in
 * their rendered MCP config instead of the host key. Bridge and relay tokens
 * are fingerprint-bound to the host key, but an MCP session row carries only
 * host_id, so without revocation a token minted under the old key kept
 * authenticating `/mcp` (and the communicator's per-frame MCP check) after the
 * host key was rotated. Rotation must revoke it, in owner and legacy SQL mode.
 */

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const FQDN = 'rotate.example.com';
const OLD_KEY_HASH = sha256('sk-codex-old');
const keyring = Keyring.fromEnv({ ENCRYPTION_ACTIVE_KEY: KEY } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
const insecure = {} as InsecureWindowService; // secure host: never consulted

function hostRow(): Record<string, unknown> {
  return {
    id: 7,
    fqdn: FQDN,
    apiKey: OLD_KEY_HASH,
    apiKeyHash: OLD_KEY_HASH,
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    engines: 'codex',
    insecureEnabledUntil: null,
    expiresAt: null,
    ip4: null,
    ip6: null,
    allowRoamingIps: 0,
    reverseDnsMode: 0,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const queues: DeadlineQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});

function ownerHarness() {
  const seed = { hosts: [hostRow()], mcpSessionTokens: [] } as unknown as StateSeed;
  const fake = createDbFake(
    new Map<unknown, Record<string, unknown>[]>([
      [schema.hosts, [hostRow()]],
      [schema.mcpSessionTokens, []],
    ]),
  );
  const db = fake as unknown as Database;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: '12345678-1234-1234-1234-123456789012', sequence: 0n }, seed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(db, runtime);
  return { db, fake, state };
}

describe('MCP session tokens across a host key rotation', () => {
  it('owner mode: a token minted under the old key stops authenticating once the key rotates', async () => {
    const { db, fake, state } = ownerHarness();
    const sessions = new McpSessionService(db);
    const { token } = await sessions.issue(7);
    expect((await sessions.verify(token))?.id).toBe(7);

    const rotated = await createHostRegistrationService({ db, keyring, insecure }).registerOrRotate({ fqdn: FQDN });
    expect(rotated.host.id).toBe(7);
    expect(state.snapshot().hosts.get(7)?.authFingerprint).not.toBe(sha256(OLD_KEY_HASH));

    expect(await sessions.verify(token)).toBeNull();
    expect(state.snapshot().table('mcpSessionTokens').by('hostId', 7)).toHaveLength(0);
    expect(fake.deletes.some((d) => d.table === schema.mcpSessionTokens)).toBe(true);
    // A token minted after the rotation is valid again.
    const fresh = await sessions.issue(7);
    expect((await sessions.verify(fresh.token))?.id).toBe(7);
  });

  it('legacy SQL mode: rotation deletes the host MCP session tokens in the rotation transaction', async () => {
    const fake = createDbFake(
      new Map<unknown, Record<string, unknown>[]>([
        [schema.hosts, [hostRow()]],
        [schema.adminEvents, []],
        [schema.logs, []],
        [
          schema.mcpSessionTokens,
          [{ id: 1, token: sha256('legacy-token'), tokenEnc: null, hostId: 7, expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
        ],
      ]),
    );
    const db = fake as unknown as Database;
    const sessions = new McpSessionService(db);
    expect((await sessions.verify('legacy-token'))?.id).toBe(7);
    await createHostRegistrationService({ db, keyring, insecure }).registerOrRotate({ fqdn: FQDN });
    expect(await sessions.verify('legacy-token')).toBeNull();
  });
});
