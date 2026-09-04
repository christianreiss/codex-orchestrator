import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { hosts } from '../../../src/db/schema.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import { createInsecureWindowService } from '../../../src/services/insecure-window.js';
import { messagingHostEligibleSql } from '../../../src/services/agent-messaging.js';
import { INSECURE_FLEET_WINDOW_KEY } from '../../../src/services/insecure-fleet-window.js';
import { SettingsService } from '../../../src/services/settings.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { Env } from '../../../src/env.js';

/**
 * The fleet window against real MySQL, for the one property `db-fake` cannot
 * model: the type boundary the grant crosses.
 *
 * `hosts.insecure_enabled_until` is one of only two real DATETIME columns in
 * the schema, and the pool sets `dateStrings: true`, so a stamped deadline is
 * read back as `"YYYY-MM-DD HH:MM:SS"` with no zone marker — while the fleet
 * deadline it was written from is a true UTC instant out of the `versions`
 * VARCHAR. The fake stores whatever it is handed and compares Dates to Dates,
 * so it agrees with itself no matter what the driver would do.
 *
 * `messagingHostEligibleSql` raises the stakes: it is a fragment MySQL
 * executes, so it cannot consult the settings key at all and can only be right
 * if the stamp on the row is right. Its own doc comment warns that passing an
 * ISO string where a DATETIME is expected "would silently return the wrong host
 * set" — this asserts the fleet window lands on the correct side of that.
 */

const FQDN = 'ztest-fleetwindow.example';
const SECURE_FQDN = 'ztest-fleetwindow-secure.example';

const handle = await getTestDb();

describe.skipIf(!handle)('fleet insecure window against a real database', () => {
  let db: TestDb;
  let admin: InsecureWindowAdminService;
  let hostId: number;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const env = () => ({ INSECURE_GRACE_MINUTES: 60 }) as Env;

  const reload = async (fqdn: string) =>
    (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)).limit(1))[0]!;

  beforeAll(async () => {
    db = handle!.db;
    admin = new InsecureWindowAdminService({
      db,
      env: env(),
      events: makeAdminEventsWriter(db),
    });
  });

  beforeEach(async () => {
    const now = new Date().toISOString();
    for (const [fqdn, secure] of [
      [FQDN, 0],
      [SECURE_FQDN, 1],
    ] as const) {
      await exec(`DELETE FROM hosts WHERE fqdn = '${fqdn}'`);
      await exec(
        `INSERT INTO hosts (fqdn, api_key, status, secure, created_at, updated_at)
         VALUES ('${fqdn}', SHA2('${fqdn}', 256), 'active', ${secure}, '${now}', '${now}')`,
      );
    }
    hostId = Number((await reload(FQDN)).id);
    await new SettingsService(db).delete(INSECURE_FLEET_WINDOW_KEY, { publish: false });
  });

  it('stamps a deadline the SQL eligibility predicate actually selects', async () => {
    // Before: an insecure host with no window is not addressable.
    const closed = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(and(eq(hosts.id, hostId), messagingHostEligibleSql()));
    expect(closed).toHaveLength(0);

    await admin.openFleetWindow(480);

    const open = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(and(eq(hosts.id, hostId), messagingHostEligibleSql()));
    expect(open).toHaveLength(1);
  });

  it('reads its own stamp back as a future instant', async () => {
    // The round trip the fake cannot fail: written as a Date through drizzle,
    // returned as a zoneless string by the driver, compared against now.
    const { until } = await admin.openFleetWindow(480);
    const row = await reload(FQDN);

    expect(row.insecureEnabledUntil).not.toBeNull();
    const readBack = new Date(row.insecureEnabledUntil as unknown as string);
    expect(readBack.getTime()).toBeGreaterThan(Date.now());
    expect(Math.abs(readBack.getTime() - until.getTime())).toBeLessThan(60_000);
  });

  it('does not touch secure hosts, and enforce() holds the deadline for insecure ones', async () => {
    await admin.openFleetWindow(480);
    expect((await reload(SECURE_FQDN)).insecureEnabledUntil).toBeNull();

    // A poll from a host whose stored window is ten minutes must not shorten
    // the grant -- the regression the whole design turns on, exercised here
    // through the driver rather than the fake.
    await exec(`UPDATE hosts SET insecure_window_minutes = 10 WHERE id = ${hostId}`);
    const svc = createInsecureWindowService({ db, env: env() });
    await svc.enforce(await reload(FQDN), 'retrieve');

    const after = new Date((await reload(FQDN)).insecureEnabledUntil as unknown as string);
    expect(after.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it('closes everything and leaves nothing eligible', async () => {
    await admin.openFleetWindow(480);
    const result = await admin.closeFleetWindow('manual');

    expect(result.closed).toBe(true);
    const row = await reload(FQDN);
    expect(row.insecureEnabledUntil).toBeNull();
    expect(row.insecureGraceUntil).toBeNull();
    expect(await new SettingsService(db).getRaw(INSECURE_FLEET_WINDOW_KEY)).toBeNull();

    const eligible = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(and(eq(hosts.id, hostId), messagingHostEligibleSql()));
    expect(eligible).toHaveLength(0);
  });
});
