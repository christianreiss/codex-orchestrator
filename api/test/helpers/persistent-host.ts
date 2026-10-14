import { hostDaemons } from '../../src/db/schema.js';
import type { Database } from '../../src/db/client.js';

/**
 * Per-user relays and persistent schedules exist only on persistent hosts
 * (docs/host-runtime-policy.md). Fixtures that exercise them mark their host
 * persistent through the same host_daemons setting the admin console writes.
 */
export async function markPersistentHost(db: Database, hostId: number): Promise<void> {
  const settings = { enabled: false, resident_enabled: true, username: 'root', default_cwd: '', max_parallel: 8, idle_minutes: 60, question_minutes: 1440 };
  await db
    .insert(hostDaemons)
    .values({ hostId, settings, updatedAt: new Date().toISOString() })
    .onDuplicateKeyUpdate({ set: { settings } });
}
