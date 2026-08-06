/**
 * The per-host Codex pin has to respect CODEX_MIN_CLIENT_VERSION the same way
 * the fleet-wide lock in /admin/settings does — an admin pinning one host below
 * the floor would hand its CLI a config.toml it refuses. The only other
 * coverage of `setCodexVersionOverride` lives in the DB-gated integration
 * suite, so the floor is asserted here over a stubbed db.
 */
import { describe, expect, it } from 'vitest';
import {
  HostManagementService,
  isSemanticVersion as hostManagementIsSemanticVersion,
} from '../../../src/services/host-management.js';
import {
  coerceCodexVersionToMinimum,
  isSemanticVersion,
} from '../../../src/services/client-versions.js';
import { applyHostClientVersionPin } from '../../../src/services/version-snapshot.js';
import { ValidationError } from '../../../src/http/errors.js';
import type { Database } from '../../../src/db/client.js';
import type { Host } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import type { Keyring } from '../../../src/security/keyring.js';
import type { AdminEventsWriter } from '../../../src/services/admin-events-writer.js';

interface Harness {
  service: HostManagementService;
  /** Column values written by every `update(hosts)` in call order. */
  updates: Array<Record<string, unknown>>;
}

/**
 * Minimal drizzle chain for the override path: the `hosts` read behind
 * `requireById`/`publishUpdate`, the `hosts` update and the `logs` insert.
 */
function createHarness(): Harness {
  const host = { id: 7, fqdn: 'host.example.com', clientVersionOverride: null } as unknown as Host;
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    select() {
      return {
        from: (_table: unknown) => ({
          where: (_condition: unknown) => ({
            limit: async (_n: number) => [host],
          }),
        }),
      };
    },
    insert(_table: unknown) {
      return {
        values: async (_values: Record<string, unknown>) => {},
      };
    },
    update(_table: unknown) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: async (_condition: unknown) => {
            updates.push(values);
          },
        }),
      };
    },
  };

  const events = {
    append: async () => ({}),
    appendAndPublish: async () => ({}),
  } as unknown as AdminEventsWriter;

  return {
    service: new HostManagementService({
      db: db as unknown as Database,
      env: {} as Env,
      keyring: {} as Keyring,
      events,
    }),
    updates,
  };
}

async function storedOverride(selection: string | null): Promise<unknown> {
  const { service, updates } = createHarness();
  await service.setCodexVersionOverride(7, selection);
  return updates[0]?.clientVersionOverride;
}

describe('setCodexVersionOverride floor', () => {
  it('raises a below-floor pin to CODEX_MIN_CLIENT_VERSION', async () => {
    expect(await storedOverride('0.10.0')).toBe('0.125.0');
    expect(await storedOverride('v0.124.9')).toBe('0.125.0');
  });

  it('stores a pin at or above the floor verbatim', async () => {
    expect(await storedOverride('0.125.0')).toBe('0.125.0');
    expect(await storedOverride('1.2.3')).toBe('1.2.3');
  });

  it('clears the column on a null selection', async () => {
    expect(await storedOverride(null)).toBeNull();
  });

  it('rejects a non-semver selection before any write', async () => {
    const { service, updates } = createHarness();
    await expect(service.setCodexVersionOverride(7, 'latest')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(updates).toHaveLength(0);
  });

  it('validates through the one shared semver validator', () => {
    expect(hostManagementIsSemanticVersion).toBe(isSemanticVersion);
  });

  it('hands the floored pin, not the requested one, to the served snapshot', () => {
    // The floor is applied on write; the read path takes the column verbatim.
    // Asserting the join here keeps a future floor change from quietly reaching
    // wrappers as the un-floored value.
    const snapshot = {
      client_version: '0.137.0',
      client_version_override: null,
      client_version_enforce_exact: false,
    } as Parameters<typeof applyHostClientVersionPin>[0];
    const stored = coerceCodexVersionToMinimum('0.10.0');
    const served = applyHostClientVersionPin(snapshot, { clientVersionOverride: stored }, 'codex');
    expect(served.client_version_override).toBe('0.125.0');
    expect(served.client_version_enforce_exact).toBe(true);
  });
});
