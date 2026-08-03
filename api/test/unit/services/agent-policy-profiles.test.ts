/**
 * Profiles carry posture; the agents document carries prose. The two are
 * versioned separately on purpose, so these cover the resolution chain a host
 * is served through and the fallbacks that keep the launch path alive when a
 * row is missing.
 */
import { describe, expect, it } from 'vitest';
import { agentPolicyProfileAssignments, agentPolicyProfiles } from '../../../src/db/schema.js';
import { NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { AgentPolicyProfilesService } from '../../../src/services/agent-policy-profiles.js';
import {
  DEFAULT_SECURITY_LEVELS,
  presetLevels,
} from '../../../src/services/agent-security-levels.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

type Row = Record<string, unknown>;

function makeDb(): DbFake {
  return createDbFake(
    new Map<unknown, Row[]>([
      [agentPolicyProfiles, []],
      [agentPolicyProfileAssignments, []],
    ]),
  );
}

function seed(db: DbFake, rows: Row[]): void {
  db.tables.set(agentPolicyProfiles, rows);
}

const svc = (db: DbFake): AgentPolicyProfilesService => new AgentPolicyProfilesService(db as never);

describe('AgentPolicyProfilesService.resolveForHost', () => {
  it('prefers the host’s assigned profile', async () => {
    const db = makeDb();
    seed(db, [
      { id: 1, name: 'fleet-default', levels: presetLevels('standard'), isDefault: 1, revision: 1 },
      { id: 2, name: 'lab-box', levels: presetLevels('unrestricted'), isDefault: 0, revision: 1 },
    ]);
    db.tables.set(agentPolicyProfileAssignments, [{ hostId: 7, profileId: 2 }]);

    expect(await svc(db).resolveForHost(7)).toEqual(presetLevels('unrestricted'));
  });

  it('falls back to the fleet default for an unassigned host', async () => {
    const db = makeDb();
    seed(db, [
      { id: 1, name: 'fleet-default', levels: presetLevels('contained'), isDefault: 1, revision: 1 },
    ]);
    expect(await svc(db).resolveForHost(7)).toEqual(presetLevels('contained'));
  });

  it('falls back to Standard when no profile exists at all', async () => {
    // This runs on the launch path. A fleet that has not migrated yet must get
    // today's posture, never no document.
    expect(await svc(makeDb()).resolveForHost(7)).toEqual(DEFAULT_SECURITY_LEVELS);
  });

  it('falls back to Standard when the assigned profile has been deleted', async () => {
    const db = makeDb();
    db.tables.set(agentPolicyProfileAssignments, [{ hostId: 7, profileId: 99 }]);
    expect(await svc(db).resolveForHost(7)).toEqual(DEFAULT_SECURITY_LEVELS);
  });

  it('completes a partial stored vector rather than serving a hole', async () => {
    // A row written before an axis existed must still resolve to nine axes.
    const db = makeDb();
    seed(db, [{ id: 1, name: 'old', levels: { autonomy: 0 }, isDefault: 1, revision: 1 }]);
    const resolved = await svc(db).resolveForHost(7);
    expect(resolved.autonomy).toBe(0);
    expect(resolved.deploy_release).toBe(DEFAULT_SECURITY_LEVELS.deploy_release);
  });

  it('degrades to Standard instead of throwing when the table is unreadable', async () => {
    const db = makeDb();
    db.select = () => {
      throw new Error('table gone');
    };
    expect(await svc(db).resolveForHost(7)).toEqual(DEFAULT_SECURITY_LEVELS);
  });
});

describe('AgentPolicyProfilesService mutations', () => {
  it('rejects a duplicate name and a blank name', async () => {
    const db = makeDb();
    seed(db, [{ id: 1, name: 'lab-box', levels: presetLevels('standard'), isDefault: 0, revision: 1 }]);
    await expect(svc(db).create({ name: 'lab-box' })).rejects.toThrow(ValidationError);
    await expect(svc(db).create({ name: '   ' })).rejects.toThrow(ValidationError);
  });

  it('rejects an out-of-range level rather than clamping it', async () => {
    await expect(
      svc(makeDb()).create({ name: 'bad', levels: { autonomy: 9 } }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses to delete the fleet default', async () => {
    // Deleting it would silently change behaviour for every unassigned host.
    const db = makeDb();
    seed(db, [{ id: 1, name: 'fleet-default', levels: presetLevels('standard'), isDefault: 1, revision: 1 }]);
    await expect(svc(db).remove(1)).rejects.toThrow(ValidationError);
  });

  it('404s on an unknown profile', async () => {
    await expect(svc(makeDb()).update(42, { name: 'x' })).rejects.toThrow(NotFoundError);
    await expect(svc(makeDb()).assign(7, 42)).rejects.toThrow(NotFoundError);
  });

  it('bumps the profile’s own revision on update', async () => {
    const db = makeDb();
    seed(db, [{ id: 1, name: 'lab-box', levels: presetLevels('standard'), isDefault: 0, revision: 3 }]);
    await svc(db).update(1, { levels: presetLevels('trusted') });
    expect((db.tables.get(agentPolicyProfiles) ?? [])[0]?.revision).toBe(4);
  });

  it('clears an assignment back to the fleet default', async () => {
    const db = makeDb();
    seed(db, [{ id: 1, name: 'fleet-default', levels: presetLevels('contained'), isDefault: 1, revision: 1 }]);
    db.tables.set(agentPolicyProfileAssignments, [{ hostId: 7, profileId: 1 }]);

    expect(await svc(db).assign(7, null)).toEqual({ host_id: 7, profile_id: null });
    expect(db.tables.get(agentPolicyProfileAssignments)).toHaveLength(0);
    expect(await svc(db).resolveForHost(7)).toEqual(presetLevels('contained'));
  });

  it('moves the default flag rather than setting a second one', async () => {
    const db = makeDb();
    seed(db, [
      { id: 1, name: 'a', levels: presetLevels('standard'), isDefault: 1, revision: 1 },
      { id: 2, name: 'b', levels: presetLevels('trusted'), isDefault: 0, revision: 1 },
    ]);
    await svc(db).setDefault(2);
    const rows = db.tables.get(agentPolicyProfiles) ?? [];
    expect(rows.filter((r) => Number(r.isDefault) === 1).map((r) => r.id)).toEqual([2]);
  });
});

describe('AgentPolicyProfilesService.enforcementForHost', () => {
  it('projects the resolved posture onto engine config', async () => {
    const db = makeDb();
    seed(db, [{ id: 1, name: 'open', levels: presetLevels('unrestricted'), isDefault: 1, revision: 1 }]);
    const derived = await svc(db).enforcementForHost(7);
    expect(derived.codex.approval_policy.value).toBe('never');
    expect(derived.codex.sandbox_mode.value).toBe('danger-full-access');
    expect(derived.claude.permission_mode.value).toBe('bypassPermissions');
    expect(derived.not_enforced.map((n) => n.key)).toContain(
      '[security].dangerously_bypass_approvals_and_sandbox',
    );
  });
});
