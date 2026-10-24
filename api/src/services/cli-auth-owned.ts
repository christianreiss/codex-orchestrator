import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cliAuthRequests } from '../db/schema.js';
import { ApiError, ConflictError, NotFoundError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { encrypt, decryptOrNull } from '../security/secret-box.js';
import { mutateOwnerState, requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import type { Json } from '../control-plane/commands.js';
import type { CliAuthDeps, CliAuthService, CliAuthPollResult } from './cli-auth.js';
import { wsPublisher } from '../ws/publisher.js';

/** Device approval and credential rotation publish as one durable change. */
export function createOwnedCliAuthService(
  { db, keyring, registration }: CliAuthDeps,
  generateUserCode: () => string,
): CliAuthService {
  const owner = requireOwnerRuntime(db);
  const codeHash = (value: string) => {
    const code = value.toUpperCase().trim();
    if (!code) throw new ApiError('user_code is required', { status: 422, code: 'validation_failed' });
    return sha256(code);
  };
  const lookupCode = (hash: string) =>
    owner.state
      .snapshot()
      .table('cliAuthRequests')
      .all()
      .find((row) => row.userCodeHash === hash);
  return {
    async start({ fqdn, secure, ip, userAgent }) {
      const trimmed = fqdn.trim();
      if (!trimmed)
        throw new ApiError('fqdn is required', { status: 422, code: 'validation_failed', param: 'fqdn' });
      return (await mutateOwnerState(owner, {
        kind: 'cli_auth.start',
        payload: { fqdn: trimmed, secure, ip, userAgent },
        prepare(ctx) {
          let userCode = generateUserCode();
          while (
            ctx.draft
              .table('cliAuthRequests')
              .all()
              .some((row) => row.userCodeHash === sha256(userCode) && Date.parse(row.expiresAt) > Date.now())
          )
            userCode = generateUserCode();
          const requestId = randomBytes(32).toString('hex'),
            createdAt = new Date().toISOString();
          const values = {
            requestId,
            requestIdEnc: encrypt(requestId, keyring),
            userCode,
            userCodeHash: sha256(userCode),
            fqdn: trimmed,
            secure: secure ? 1 : 0,
            status: 'pending',
            ip,
            userAgent,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            createdAt,
            approvedByUserId: null,
            hostId: null,
            apiKeyEnc: null,
            approvedAt: null,
            consumedAt: null,
            engine: 'codex',
          };
          ctx.write(async (tx) => {
            const [inserted] = await tx.insert(cliAuthRequests).values(values);
            ctx.draft.upsert('cliAuthRequests', { ...values, id: Number(inserted.insertId) });
          });
          return { request_id: requestId, user_code: userCode, expires_in: 600, poll_interval: 5 };
        },
      })) as unknown as Awaited<ReturnType<CliAuthService['start']>>;
    },
    async poll(requestId) {
      owner.assertOwner();
      const row = owner.state.snapshot().table('cliAuthRequests').by('requestId', requestId)[0];
      if (!row) return { status: 'not_found' };
      if (Date.parse(row.expiresAt) <= Date.now()) return { status: 'expired' };
      if (row.consumedAt) return { status: 'consumed' };
      if (row.status !== 'approved') return { status: row.status === 'denied' ? 'denied' : 'pending' };
      return (await mutateOwnerState(owner, {
        kind: 'cli_auth.consume',
        payload: { id: row.id },
        prepare: async (ctx): Promise<Json> => {
          const current = ctx.draft.table('cliAuthRequests').get(row.id);
          if (!current || current.requestId !== requestId) return { status: 'not_found' };
          if (Date.parse(current.expiresAt) <= Date.now()) return { status: 'expired' };
          if (current.consumedAt) return { status: 'consumed' };
          if (current.status !== 'approved')
            return { status: current.status === 'denied' ? 'denied' : 'pending' };
          const [cold] = await db
            .select({ apiKeyEnc: cliAuthRequests.apiKeyEnc })
            .from(cliAuthRequests)
            .where(eq(cliAuthRequests.id, current.id));
          const apiKey = decryptOrNull(cold?.apiKeyEnc ?? null, keyring);
          if (!apiKey) throw new Error('Approved login has no durable credential');
          stageUpdate(ctx, 'cliAuthRequests', current.id, { consumedAt: new Date().toISOString() });
          return { status: 'approved', api_key: apiKey, fqdn: current.fqdn, secure: current.secure === 1 };
        },
      })) as unknown as CliAuthPollResult;
    },
    async lookup(userCode) {
      owner.assertOwner();
      if (!userCode.trim()) return null;
      const row = lookupCode(codeHash(userCode));
      if (!row || Date.parse(row.expiresAt) <= Date.now()) return null;
      return {
        id: row.id,
        fqdn: row.fqdn,
        secure: row.secure === 1,
        ip: row.ip,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
      };
    },
    async approve(userCode, approvedByUserId, approvedByName) {
      const hash = codeHash(userCode);
      const result = (await mutateOwnerState(owner, {
        kind: 'cli_auth.approve',
        payload: { userCodeHash: hash, approvedByUserId, approvedByName },
        prepare(ctx) {
          const row = ctx.draft
            .table('cliAuthRequests')
            .all()
            .find((row) => row.userCodeHash === hash);
          if (!row) throw new NotFoundError('Login request not found or expired');
          if (Date.parse(row.expiresAt) <= Date.now())
            throw new ApiError('Login request has expired', { status: 410, code: 'expired' });
          if (row.status !== 'pending') throw new ConflictError('Login request already resolved');
          if (!registration.stageOwned)
            throw new Error('Owner CLI approval requires composed host registration');
          let result!: { fqdn: string; host_id: number };
          registration.stageOwned(
            ctx,
            { fqdn: row.fqdn, secure: row.secure === 1, createdBy: approvedByName },
            (reg) => {
              const at = new Date().toISOString();
              stageUpdate(ctx, 'cliAuthRequests', row.id, {
                status: 'approved',
                approvedByUserId,
                hostId: reg.host.id,
                apiKeyEnc: encrypt(reg.apiKey, keyring),
                approvedAt: at,
              });
              adminAudit(
                ctx,
                'cli_auth.approved',
                { request_id: row.id, approved_by_user_id: approvedByUserId },
                at,
                reg.host.id,
              );
              result = { fqdn: row.fqdn, host_id: reg.host.id };
            },
          );
          return () => result as Json;
        },
      })) as unknown as { fqdn: string; host_id: number };
      wsPublisher.publish('insecure.approval.changed', { ...result, kind: 'cli_auth' });
      return result;
    },
    async deny(userCode) {
      const hash = codeHash(userCode);
      const result = (await mutateOwnerState(owner, {
        kind: 'cli_auth.deny',
        payload: { userCodeHash: hash },
        prepare(ctx) {
          const row = ctx.draft
            .table('cliAuthRequests')
            .all()
            .find((row) => row.userCodeHash === hash);
          if (!row) throw new NotFoundError('Login request not found or expired');
          if (Date.parse(row.expiresAt) <= Date.now())
            throw new ApiError('Login request has expired', { status: 410, code: 'expired' });
          if (row.status !== 'pending') throw new ConflictError('Login request already resolved');
          const at = new Date().toISOString();
          stageUpdate(ctx, 'cliAuthRequests', row.id, { status: 'denied', approvedAt: at });
          adminAudit(ctx, 'cli_auth.denied', { request_id: row.id }, at);
          return { fqdn: row.fqdn };
        },
      })) as { fqdn: string };
      wsPublisher.publish('insecure.approval.changed', { ...result, kind: 'cli_auth_denied' });
      return result;
    },
  };
}
