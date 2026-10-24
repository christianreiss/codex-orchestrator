import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { prepareOwned, statusOwned, completeOwned } from './host-spawn-owned.js';
import { randomUUID, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from '../routes/index.js';
import { hosts, hostSpawns, installTokens, adminEvents, hostDaemons } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { SettingsService } from './settings.js';
import { HostManagementService, type InstallerInfo } from './host-management.js';
import { makeAdminEventsWriter } from './admin-events-writer.js';
import { daemonSettingsSchema, daemonExpired } from './host-daemon/policy.js';
import { wsPublisher } from '../ws/publisher.js';

export const HOST_SPAWN_ENABLED_KEY = 'host_spawn_enabled';
const engine = z.enum(['codex', 'claude', 'grok']);
const daemon = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('permanent'), username: daemonSettingsSchema.shape.username.removeDefault(),
    default_cwd: z.string().max(1024).regex(/^\/[^\0]*$/) }).strict(),
  z.object({ mode: z.literal('timed'), username: daemonSettingsSchema.shape.username.removeDefault(),
    default_cwd: z.string().max(1024).regex(/^\/[^\0]*$/),
    duration_minutes: z.number().int().min(1).max(10080) }).strict(),
]);
export const hostSpawnSchema = z.object({
  fqdn: z.string().trim().toLowerCase().min(1).max(255)
    .refine(v => v.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), 'Use a valid hostname or FQDN'),
  engines: z.array(engine).min(1).max(3).transform(v => [...new Set(v)].sort()),
  secure: z.boolean().default(true),
  client_message_id: z.string().uuid(),
  daemon: daemon.default({ mode: 'none' }),
}).strict();
export const hostSpawnStatusSchema = z.object({
  operation_id: z.string().uuid(),
  renew_installer: z.boolean().default(false),
  client_message_id: z.string().uuid().optional(),
}).strict().refine(v => !v.renew_installer || !!v.client_message_id, {
  message: 'Installer renewal requires a stable client_message_id',
});
const now = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class HostSpawnService {
  constructor(private ctx: RouteContext) {}
  async enabled() { return new SettingsService(this.ctx.db).getFlag(HOST_SPAWN_ENABLED_KEY); }
  private async caller(db: RouteContext['db'], hostId: number) {
    const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId)).for('update');
    if (!host || host.status !== 'active' || host.vip !== 1)
      throw new ForbiddenError('System spawn requires an active VIP source host', 'host_spawn_vip_required');
    if (!(await new SettingsService(db).getFlag(HOST_SPAWN_ENABLED_KEY)))
      throw new ForbiddenError('System spawn is disabled', 'host_spawn_disabled');
    return host;
  }
  async prepare(raw: unknown, sourceHostId: number) {
    const parsed = hostSpawnSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const input = parsed.data;
    if (ownerRuntimeFor(this.ctx.db)) return prepareOwned(this.ctx, this, input, sourceHostId);
    const result = await this.ctx.db.transaction(async tx => {
      const db = tx as unknown as RouteContext['db'];
      await this.caller(db, sourceHostId);
      const [existing] = await tx.select().from(hostSpawns).where(and(
        eq(hostSpawns.sourceHostId, sourceHostId), eq(hostSpawns.clientMessageId, input.client_message_id)));
      const requestHash = hash(input);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictError('Idempotency key reused with different input');
        if (existing.installerRevision !== 0) throw new ConflictError('Installer was renewed; use host_spawn_status');
        return this.response(existing);
      }
      if (input.daemon.mode !== 'none' && !(await new SettingsService(db).getFlag('agent_messaging_enabled')))
        throw new ConflictError('Enable Agent Messaging before installing a daemon');
      const management = new HostManagementService({ db, env: this.ctx.env, keyring: this.ctx.keyring,
        events: makeAdminEventsWriter(db) });
      const { host, installer } = await management.register({
        fqdn: input.fqdn, engines: input.engines, secure: input.secure, vip: false,
      }, { createOnly: true });
      if (input.daemon.mode !== 'none') {
        const settings = daemonSettingsSchema.parse({ enabled: true,
          username: input.daemon.username, default_cwd: input.daemon.default_cwd,
          lifetime_minutes: input.daemon.mode === 'timed' ? input.daemon.duration_minutes : null });
        await tx.insert(hostDaemons).values({ hostId: host.id, settings, enabledAt: now(), updatedAt: now() });
      }
      const row = { id: randomUUID(), sourceHostId, targetHostId: host.id,
        clientMessageId: input.client_message_id, requestHash, request: input,
        installerEnc: encrypt(JSON.stringify(installer), this.ctx.keyring), installerRevision: 0, renewalReceipts: {},
        renewalClientMessageId: null, setupCompletedAt: null, createdAt: now(), updatedAt: now() };
      await tx.insert(hostSpawns).values(row);
      await tx.insert(adminEvents).values({ type: 'host.spawn.prepared', hostId: host.id,
        payload: { source_host_id: sourceHostId, target_host_id: host.id, operation_id: row.id }, createdAt: now() });
      return this.response(row);
    });
    wsPublisher.publish('host.updated', { id: result.host_id });
    return result;
  }
  response(row: typeof hostSpawns.$inferSelect, deadlineExpired = false) {
    const installer = JSON.parse(decrypt(row.installerEnc, this.ctx.keyring)) as InstallerInfo;
    const daemon = row.request.daemon;
    return { operation_id: row.id, host_id: row.targetHostId, fqdn: row.request.fqdn,
      engines: row.request.engines, secure: row.request.secure, installer,
      daemon, setup_script: hostSpawnSetupScript(installer.url, daemon, deadlineExpired), setup_steps: deadlineExpired
        ? ["Run the installer to repair the existing installation. The expired daemon remains disabled."]
        : daemon.mode === 'none'
        ? ['Run installer.command on the target host over SSH. No agent is started.']
        : [`Run installer.command on Linux/systemd as ${daemon.username} (the user and working directory must already exist).`,
          'Install the system service as root with cxx daemon install, using the signed config paths of that user.',
          'Wait for host_spawn_status to report daemon_connected; then use agent_spawn for a separate task.'],
    };
  }
  async status(raw: unknown, sourceHostId: number) {
    const parsed = hostSpawnStatusSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const input = parsed.data;
    if (ownerRuntimeFor(this.ctx.db)) return statusOwned(this.ctx, this, input, sourceHostId);
    const row = await this.ctx.db.transaction(async tx => {
      const db = tx as unknown as RouteContext['db'];
      await this.caller(db, sourceHostId);
      const [row] = await tx.select().from(hostSpawns).where(and(eq(hostSpawns.id, input.operation_id),
        eq(hostSpawns.sourceHostId, sourceHostId))).for('update');
      if (!row) throw new NotFoundError('Spawn operation not found');
      if (input.renew_installer && row.renewalReceipts[input.client_message_id!]) {
        return { ...row, installerEnc: row.renewalReceipts[input.client_message_id!]! };
      }
      if (input.renew_installer) {
        const previous = JSON.parse(decrypt(row.installerEnc, this.ctx.keyring)) as InstallerInfo;
        const [token] = await tx.select().from(installTokens).where(eq(installTokens.token, hashToken(previous.token)));
        if (token && !token.usedAt && Date.parse(token.expiresAt) > Date.now())
          throw new ConflictError('Installer is still available; retry the existing setup');
        const management = new HostManagementService({ db, env: this.ctx.env, keyring: this.ctx.keyring,
          events: makeAdminEventsWriter(db) });
        const { installer } = await management.mintInstaller(row.targetHostId);
        row.installerEnc = encrypt(JSON.stringify(installer), this.ctx.keyring);
        row.installerRevision++;
        row.renewalReceipts = { ...row.renewalReceipts, [input.client_message_id!]: row.installerEnc };
        row.renewalClientMessageId = input.client_message_id!;
        row.updatedAt = now();
        await tx.update(hostSpawns).set({ installerEnc: row.installerEnc, installerRevision: row.installerRevision,
          renewalReceipts: row.renewalReceipts, renewalClientMessageId: row.renewalClientMessageId, updatedAt: row.updatedAt }).where(eq(hostSpawns.id, row.id));
        await tx.insert(adminEvents).values({ type: 'host.spawn.installer_renewed', hostId: row.targetHostId,
          payload: { source_host_id: sourceHostId, operation_id: row.id }, createdAt: now() });
      }
      return row;
    });
    const [config] = await this.ctx.db.select().from(hostDaemons).where(eq(hostDaemons.hostId, row.targetHostId));
    const connected = !!config?.runtime?.connected && Date.now() - Date.parse(config.runtime.heartbeat_at) < 45000;
    const deadlineExpired = !!config && daemonExpired(config.settings);
    const response = this.response(row, deadlineExpired);
    const [token] = await this.ctx.db.select().from(installTokens).where(eq(installTokens.token, hashToken(response.installer.token)));
    return { ...response, installer_used: !!token?.usedAt, setup_completed_at: row.setupCompletedAt,
      daemon_connected: connected, daemon_deadline_expired: deadlineExpired, daemon_expires_at: config?.settings.expires_at ?? null,
      state: row.setupCompletedAt ? 'installed' : token?.usedAt ? 'installer_downloaded' : 'registered' };
  }
  async complete(targetHostId: number) {
    if (ownerRuntimeFor(this.ctx.db)) return completeOwned(this.ctx, targetHostId);
    await this.ctx.db.update(hostSpawns).set({ setupCompletedAt: now(), updatedAt: now() })
      .where(and(eq(hostSpawns.targetHostId, targetHostId), isNull(hostSpawns.setupCompletedAt)));
    wsPublisher.publish('host.updated', { id: targetHostId });
    return { stored: true };
  }
}
function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }

export function hostSpawnCompletionScript(): string {
  return `  # Match cxx's IPv4-first transport so the completion uses the bound source IP.
  if ! curl $CURL_INSECURE_FLAG -4 -fsS --retry 2 --connect-timeout 10 --max-time 30 -X POST -H "X-API-Key: $HOST_API_KEY" "$BASE_URL/host/spawn/setup-complete" >"$STEP_LOG" 2>&1; then
    curl $CURL_INSECURE_FLAG -fsS --retry 2 --connect-timeout 10 --max-time 30 -X POST -H "X-API-Key: $HOST_API_KEY" "$BASE_URL/host/spawn/setup-complete" >/dev/null
  fi`;
}

function quote(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function hostSpawnSetupScript(url: string, daemon: z.infer<typeof hostSpawnSchema>['daemon'], deadlineExpired = false): string {
  const download = `setup_file=$(mktemp)
trap 'rm -f "$setup_file"' EXIT HUP INT TERM
curl -fsSL ${quote(url)} -o "$setup_file"
`;
  if (daemon.mode === 'none') return '#!/bin/sh\nset -eu\n' + download + 'sh "$setup_file"\n';
  return `#!/bin/sh
set -eu
[ "$(id -u)" = "0" ] || { echo 'Daemon setup requires root' >&2; exit 1; }
command -v systemctl >/dev/null
service_user=${quote(daemon.username)}
service_home=$(getent passwd "$service_user" | cut -d: -f6)
[ -n "$service_home" ] && [ -d "$service_home" ] && [ -d ${quote(daemon.default_cwd)} ]
${download}chown "$service_user" "$setup_file"
chmod 600 "$setup_file"
runuser -u "$service_user" -- env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" BIN_DIR="$service_home/.local/bin" sh "$setup_file"
${deadlineExpired ? "echo 'cxx daemon: deadline expired; installation repaired, daemon remains disabled'" : `env HOME="$service_home" CDX_CONFIG_PATH="$service_home/.config/codex-orchestrator/cdx.json" CLX_CONFIG_PATH="$service_home/.config/codex-orchestrator/clx.json" CGX_CONFIG_PATH="$service_home/.config/codex-orchestrator/cgx.json" "$service_home/.local/bin/cxx" daemon install`}
`;
}
