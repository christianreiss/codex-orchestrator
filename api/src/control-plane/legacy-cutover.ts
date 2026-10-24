import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { legacyGitIdentity, legacyResourceIdentity, type LegacyProtectedCapture } from './legacy-drain.js';
import type { OwnerStateSnapshot } from './state/store.js';
import { ownedEngineState, ownedMessagingHost } from './state/messaging.js';
import { activeHostEngines } from '../services/host-engine-policy.js';
import type { Engine } from '../util/engine.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const entrySchema = z
  .object({
    kind: z.enum(['resource', 'git']),
    id: z.string().uuid(),
    identity: z.array(z.unknown()).min(7).max(11),
    session: z.array(z.unknown()).length(16),
    securityDeadline: z.number().finite().nonnegative().nullable(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    database: z.string().min(1).max(255),
    capturedAt: z.string().datetime({ offset: true }),
    entries: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();
export type LegacyCutoverManifest = z.infer<typeof manifestSchema>;

/** No fallback: malformed, public, linked or mismatched manifests stop owner boot. */
export async function readLegacyCutoverManifest(
  path: string,
  database: string,
  now = Date.now(),
): Promise<LegacyCutoverManifest | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > MAX_BYTES)
      throw new Error('Legacy cutover manifest must be a private regular file within its size limit');
    const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset > MAX_BYTES ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Legacy cutover manifest changed while reading or exceeds its size limit');
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    } catch {
      throw new Error('Invalid legacy cutover manifest JSON');
    }
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid legacy cutover manifest schema');
    const manifest = parsed.data,
      capturedAt = Date.parse(manifest.capturedAt);
    if (manifest.database !== database || !Number.isFinite(capturedAt) || capturedAt > now)
      throw new Error('Legacy cutover manifest database or capture time does not match');
    const ids = new Set<string>();
    for (const entry of manifest.entries) {
      const key = entry.kind + ':' + entry.id;
      if (ids.has(key)) throw new Error('Duplicate legacy cutover grant identity');
      ids.add(key);
      if (entry.identity.length !== (entry.kind === 'resource' ? 7 : 11))
        throw new Error('Invalid legacy cutover identity shape');
    }
    return manifest;
  } finally {
    await handle.close();
  }
}

/** Exact tuple shared with the quiescent capture writer; contains hashes, never raw credentials. */
export function legacyCutoverSessionIdentity(
  snapshot: OwnerStateSnapshot,
  id: string,
): readonly unknown[] | null {
  const session = snapshot.sessions.get(id),
    control = snapshot.table('agentNativeControls').get(id);
  if (
    !session ||
    session.endedAt ||
    !control ||
    control.status === 'exited' ||
    control.bindingGeneration !== session.bindingGeneration
  )
    return null;
  const host = snapshot.hosts.get(session.hostId);
  if (!host || host.authFingerprint !== session.hostAuthFingerprint) return null;
  return [
    session.id,
    session.hostId,
    session.username,
    session.engine,
    session.bindingGeneration,
    session.bridgeTokenHash,
    session.hostAuthFingerprint,
    session.expiresAt,
    control.instanceId,
    control.bindingGeneration,
    host.ip4,
    host.ip6,
    host.allowRoamingIps,
    host.reverseDnsMode,
    host.secure,
    host.reverseDnsMode === null ? snapshot.setting('reverse_dns_enabled') : null,
  ];
}

/** A persisted entry is eligibility evidence only, never a native-presence proof. */
export function filterLegacyCutoverManifest(
  manifest: LegacyCutoverManifest | null,
  snapshot: OwnerStateSnapshot,
  now = Date.now(),
): LegacyProtectedCapture {
  if (!manifest) return {};
  const capturedAt = Date.parse(manifest.capturedAt),
    resourceClaimIds: string[] = [],
    gitRegistrationIds: string[] = [];
  const securityDeadlines: Record<string, number> = Object.create(null) as Record<string, number>;
  if (!Number.isFinite(capturedAt) || capturedAt > now)
    throw new Error('Invalid legacy cutover capture time');
  for (const entry of manifest.entries) {
    const sessionId = entry.session[0];
    if (typeof sessionId !== 'string') continue;
    const session = snapshot.sessions.get(sessionId),
      identity = legacyCutoverSessionIdentity(snapshot, sessionId);
    if (!session || !identity || JSON.stringify(identity) !== JSON.stringify(entry.session)) continue;
    const caps = session.adapterCapabilities as { control_state_protocol?: unknown } | null;
    if (caps?.control_state_protocol === 1) continue;
    try {
      const host = ownedMessagingHost(snapshot, session.hostId, now);
      if (!activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(session.engine as Engine))
        continue;
      if (
        entry.securityDeadline !== null &&
        (entry.securityDeadline <= now || entry.securityDeadline <= capturedAt)
      )
        continue;
      // A missing cap cannot turn a formerly bounded session/insecure grant into an unlimited one.
      if (entry.securityDeadline === null && (session.expiresAt !== null || host.secure !== 1)) continue;
      const securityCap = Math.min(
        entry.securityDeadline ?? Infinity,
        session.expiresAt ? Date.parse(session.expiresAt) : Infinity,
        host.expiresAt ? Date.parse(host.expiresAt) : Infinity,
        host.secure === 1
          ? Infinity
          : host.insecureEnabledUntil
            ? new Date(host.insecureEnabledUntil).getTime()
            : NaN,
      );
      if (Number.isNaN(securityCap) || securityCap <= now) continue;
      let eligible = false;
      if (entry.kind === 'resource') {
        const row = snapshot.claims.get(entry.id);
        eligible = Boolean(
          row &&
          row.ownershipMode === 'timed' &&
          row.sessionId === sessionId &&
          row.generation === session.bindingGeneration &&
          (row.state === 'active' ||
            (row.state === 'uncertain' && row.uncertaintyReason === 'owner_restart')) &&
          legacyResourceIdentity(row) === JSON.stringify(entry.identity) &&
          Date.parse(row.expiresAt) > capturedAt,
        );
        if (eligible) resourceClaimIds.push(entry.id);
      } else {
        const row = snapshot.table('gitWorktrees').get(entry.id);
        eligible = Boolean(
          row &&
          row.ownershipMode === 'timed' &&
          !row.releasedAt &&
          row.agentSessionId === sessionId &&
          row.agentBindingGeneration === session.bindingGeneration &&
          (row.status === 'active' ||
            (row.status === 'uncertain' && row.uncertaintyReason === 'owner_restart')) &&
          legacyGitIdentity(row) === JSON.stringify(entry.identity) &&
          Date.parse(row.expiresAt) > capturedAt,
        );
        if (eligible) gitRegistrationIds.push(entry.id);
      }
      if (eligible)
        securityDeadlines[sessionId] = Math.min(securityDeadlines[sessionId] ?? Infinity, securityCap);
    } catch {
      /* Ineligible current host/security state cannot acquire drain authority. */
    }
  }
  return { capturedAt, resourceClaimIds, gitRegistrationIds, securityDeadlines };
}
