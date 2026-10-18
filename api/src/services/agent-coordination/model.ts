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
  z.object({ kind: z.literal('path'), host_id: z.number().int().positive(), path: absolute }).strict(),
  z
    .object({
      kind: z.literal('git'),
      host_id: z.number().int().positive(),
      common_dir: absolute,
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
export function repositoryIdentity(session: { hostId: number; cwd: string; workspace: unknown }): string {
  const w = readWorkspace(session.workspace);
  return w?.repository_key
    ? `repo:${w.repository_key}`
    : `local:${session.hostId}:${sha256(w?.git_common_dir ?? w?.cwd ?? session.cwd)}`;
}
export const acquireSchema = z
  .object({
    client_request_id: z.string().uuid(),
    purpose: z.string().trim().min(1).max(1000),
    resources: z.array(resourceSchema).min(1).max(64),
  })
  .strict();
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
