import { hostDaemons } from '../../src/db/schema.js';
import type { Database } from '../../src/db/client.js';

/**
 * Per-user relays and persistent schedules exist only on persistent hosts
 * (docs/host-runtime-policy.md). Fixtures that exercise them mark their host
 * persistent for `username` (the daemon's account) through the same host_daemons
 * setting the admin console writes.
 */
export async function markPersistentHost(db: Database, hostId: number, username = 'root'): Promise<void> {
  const settings = { enabled: false, resident_enabled: true, username, default_cwd: '', max_parallel: 8, idle_minutes: 60, question_minutes: 1440 };
  await db
    .insert(hostDaemons)
    .values({ hostId, settings, updatedAt: new Date().toISOString() })
    .onDuplicateKeyUpdate({ set: { settings } });
}

/**
 * For fixtures that register relays for several OS users on one host: every
 * registration first makes its own user the daemon account, so the relay is
 * admitted exactly as on a host persistent for that user.
 */
export function persistRelayUsers<T extends { registerRelay: (...args: never[]) => unknown }>(db: Database, service: T): T {
  const original = service.registerRelay.bind(service) as (host: { id: number }, input: { username: string }) => Promise<unknown>;
  (service as unknown as { registerRelay: typeof original }).registerRelay = async (host, input) => {
    await markPersistentHost(db, host.id, input.username.replace(/:daemon$/, ''));
    return original(host, input);
  };
  return service;
}
