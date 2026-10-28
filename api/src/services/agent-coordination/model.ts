import { posix } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../security/hash.js';
import { readWorkspace } from '../agent-messaging/workspace.js';

const absolute = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => v.startsWith('/') && !v.includes('\0') && !v.split('/').includes('..'),
    'Canonical absolute path required',
  )
  .transform((v) => posix.normalize(v).replace(/\/+$/, '') || '/');
export const resourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('remote'),
      fqdn: z
        .string()
        .trim()
        .toLowerCase()
        .transform((v) => v.replace(/\.$/, ''))
        .pipe(
          z
            .string()
            .max(253)
            .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
        ),
      service: z.string().trim().min(1).max(255),
    })
    .strict(),
  z.object({ kind: z.literal('path'), host_id: z.number().int().positive(), path: absolute }).strict(),
  z
    .object({
      kind: z.literal('git'),
      host_id: z.number().int().positive(),
      common_dir: absolute,
      // Native MCP schemas expose the union of resource fields. Accept a
      // redundant path for compatibility; Git identity remains common_dir/branch.
      path: absolute.optional(),
      branch: z.string().min(1).max(255).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('service'),
      host_id: z.number().int().positive(),
      service: z.string().trim().min(1).max(255),
    })
    .strict(),
]);
export type Resource = z.infer<typeof resourceSchema>;
export function overlaps(a: Resource, b: Resource): boolean {
  if (a.kind === 'remote' || b.kind === 'remote')
    return (
      a.kind === 'remote' &&
      b.kind === 'remote' &&
      a.fqdn === b.fqdn &&
      (a.service === b.service || a.service === '*' || b.service === '*')
    );
  if (a.host_id !== b.host_id || a.kind !== b.kind) return false;
  if (a.kind === 'path' && b.kind === 'path')
    return (
      a.path === b.path ||
      a.path.startsWith(b.path === '/' ? '/' : b.path + '/') ||
      b.path.startsWith(a.path === '/' ? '/' : a.path + '/')
    );
  if (a.kind === 'git' && b.kind === 'git')
    return a.common_dir === b.common_dir && (!a.branch || !b.branch || a.branch === b.branch);
  return (
    a.kind === 'service' &&
    b.kind === 'service' &&
    (a.service === b.service || a.service === '*' || b.service === '*')
  );
}
/** Whether holding `a` already includes all of `b` (path descendants, branch-less Git, `*` service). */
export function covers(a: Resource, b: Resource): boolean {
  if (a.kind === 'remote' || b.kind === 'remote')
    return a.kind === 'remote' && b.kind === 'remote' && a.fqdn === b.fqdn && (a.service === b.service || a.service === '*');
  if (a.host_id !== b.host_id || a.kind !== b.kind) return false;
  if (a.kind === 'path' && b.kind === 'path')
    return a.path === b.path || b.path.startsWith(a.path === '/' ? '/' : a.path + '/');
  if (a.kind === 'git' && b.kind === 'git') return a.common_dir === b.common_dir && (!a.branch || a.branch === b.branch);
  return a.kind === 'service' && b.kind === 'service' && (a.service === b.service || a.service === '*');
}
/**
 * Claims queue in arrival order: `created_at`, then `id` as a deterministic
 * tiebreak. A new claim is behind every claim that already exists.
 */
export function claimArrivalOrder(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/**
 * A waiting claim ahead in the queue blocks a later claim, except where the
 * later claim only re-enters resources its own session already holds: the
 * earlier waiter is queued behind that holder anyway, and refusing the holder's
 * nested claim would deadlock it against its own grant.
 */
export function waiterBlocks(subject: Resource[], waiter: Resource[], held: Resource[]): boolean {
  const contested = subject.filter((resource) => waiter.some((other) => overlaps(resource, other)));
  return contested.length > 0 && !contested.every((resource) => held.some((grant) => covers(grant, resource)));
}
export function repositoryIdentity(session: { hostId: number; cwd: string; workspace: unknown }): string {
  const w = readWorkspace(session.workspace);
  return w?.repository_key
    ? `repo:${w.repository_key}`
    : `local:${session.hostId}:${sha256(w?.git_common_dir ?? w?.cwd ?? session.cwd)}`;
}
type ContextRoom = { kind: string; id: string; members?: unknown; next_member_offset?: unknown };
type ContextClaim = { session_id?: unknown; scope_ids?: string[] };
/**
 * Compact acknowledgement for `context/update`. The full snapshot of a busy host
 * (host room with every member, every fleet claim) can exceed a client's output
 * limit. The acknowledgement keeps the workspace, the repository key, room headers and
 * only the claims this session owns or that belong to a session in one of its
 * non-host (repository/project) rooms. `context/get` stays the complete read.
 */
export function compactContextAck<T extends { rooms: ContextRoom[]; claims: ContextClaim[] }>(
  full: T,
  session: { id: string; hostId: number; cwd: string; workspace: unknown },
) {
  const { rooms, claims, ...rest } = full;
  const own = new Set(rooms.filter((r) => r.kind !== 'host').map((r) => r.id));
  const relevant = claims.filter(
    (c) => c.session_id === session.id || (c.scope_ids ?? []).some((id) => own.has(id)),
  );
  return {
    ...rest,
    repository_key: repositoryIdentity(session),
    rooms: rooms.map(({ members: _members, next_member_offset: _next, ...room }) => room) as Array<
      Omit<T['rooms'][number], 'members' | 'next_member_offset'>
    >,
    claims: relevant as T['claims'],
    claims_total: claims.length,
    claims_omitted: claims.length - relevant.length,
    detail: 'agent_context_get returns every room member and all visible claims',
  };
}
export const acquireSchema = z
  .object({
    client_request_id: z.string().uuid(),
    purpose: z.string().trim().min(1).max(1000),
    resources: z.array(resourceSchema).min(1).max(64),
  })
  .strict();
/** Local targets inherit only the authenticated caller's host, never a payload hint. */
export function parseAcquireForHost(input: unknown, hostId: number) {
  z.number().int().positive().parse(hostId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return acquireSchema.parse(input);
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.resources)) return acquireSchema.parse(input);
  return acquireSchema.parse({
    ...body,
    resources: body.resources.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const resource = value as Record<string, unknown>;
      return ['path', 'git', 'service'].includes(String(resource.kind)) && resource.host_id === undefined
        ? { ...resource, host_id: hostId }
        : resource;
    }),
  });
}
export const claimStatusSchema = z
  .object({
    claim_id: z.string().uuid(),
    renew: z.boolean().optional(),
    response: z.enum(['wait', 'isolate']).optional(),
  })
  .strict();
export const roomReadSchema = z
  .object({
    scope_id: z.string().uuid(),
    after: z.number().int().nonnegative().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    member_offset: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine((v) => v.after === undefined || v.before === undefined, 'Use before or after');
export const roomSendSchema = z
  .object({
    scope_id: z.string().uuid(),
    content: z.string().trim().min(1).max(30000),
    client_request_id: z.string().uuid(),
  })
  .strict();
export const CLAIM_SECONDS = 60;
export const NEGOTIATION_SECONDS = 120;
