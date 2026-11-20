import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `owner_admin_event_id` is derived owner RAM: `/admin/ws/info`, Git Director
 * and server retention read it as the latest `admin_events` id. Only
 * `insertOwnedAdminEvent` (and `adminAudit`, which calls it) advances it, so an
 * owner mutation that inserts the row itself leaves the head behind until the
 * next boot hydration (2026-11-20: daemon operations, feedback configuration
 * and purge, and admin toasts did).
 *
 * Every other direct insert must sit on a plain path that runs only without an
 * owner runtime, where `AdminEventsService.latestEventId` reads SQL instead.
 * A new site belongs here only after checking that; otherwise use the helper.
 */
const PLAIN_PATH_INSERTS: Record<string, number> = {
  'src/control-plane/state/admin.ts': 1, // insertOwnedAdminEvent itself
  'src/services/admin-events.ts': 1,
  'src/services/admin-events-writer.ts': 1,
  'src/services/admin-auth.ts': 2,
  'src/services/admin-memory-lifecycle.ts': 1,
  'src/services/agent-coordination/index.ts': 1,
  'src/services/authorization-mode.ts': 2,
  'src/services/feedback.ts': 1, // the `else` of the owned-context branch
  'src/services/feedback/config.ts': 1,
  'src/services/git-director.ts': 1,
  'src/services/git-director/notifications.ts': 3,
  'src/services/host-daemon/service.ts': 4,
  'src/services/host-registration.ts': 1,
  'src/services/host-spawn.ts': 2,
  'src/services/secrets.ts': 1,
};

const root = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('owner admin-event head', () => {
  it('has no admin_events insert outside the reviewed plain paths and the owned helper', () => {
    const found: Record<string, number> = {};
    for (const file of sources(join(root, 'src'))) {
      const count = (readFileSync(file, 'utf8').match(/\.insert\(\s*(?:schema\.)?adminEvents\s*\)/g) ?? []).length;
      if (count) found[relative(root, file)] = count;
    }
    expect(found).toEqual(PLAIN_PATH_INSERTS);
  });
});
