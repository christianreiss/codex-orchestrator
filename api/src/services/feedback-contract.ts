import { z } from 'zod';
import { ValidationError } from '../http/errors.js';

export const FEEDBACK_ENABLED_KEY = 'feedback_enabled';
export const FEEDBACK_TYPES = ['bug', 'feature', 'feedback'] as const;
export const FEEDBACK_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'dismissed', 'duplicate'] as const;
/** Closed statuses never carry a claim and are the only ones an administrator may delete. */
export const FEEDBACK_CLOSED_STATUSES = ['resolved', 'dismissed', 'duplicate'] as const;
export const FEEDBACK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const FEEDBACK_DEPLOYMENTS = ['unknown', 'not_deployed', 'deployed'] as const;
export const FEEDBACK_CLAIM_SECONDS = 1800;
const short = z.string().trim().min(1).max(1000);
const body = z.string().trim().min(1).max(32000);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());

export const feedbackSubmitSchema = z.object({
  client_request_id: uuid,
  type: z.enum(FEEDBACK_TYPES),
  title: z.string().trim().min(1).max(255),
  description: body,
  component: z.string().trim().min(1).max(100).default('other'),
  priority: z.enum(FEEDBACK_PRIORITIES).default('normal'),
  reproduction: body.optional(),
  expected: body.optional(),
  actual: body.optional(),
  versions: short.optional(),
  agent_uuid: uuid.optional(),
}).strict();

export const feedbackListSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  type: z.enum(FEEDBACK_TYPES).optional(),
  component: z.string().trim().min(1).max(100).optional(),
  priority: z.enum(FEEDBACK_PRIORITIES).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

export const feedbackClaimSchema = z.object({
  id: uuid,
  action: z.enum(['acquire', 'renew', 'release', 'force_release']).default('acquire'),
  client_request_id: uuid.optional(),
  claim_token: uuid.optional(),
  agent_uuid: uuid.optional(),
  reason: short.optional(),
}).strict();

export const feedbackUpdateSchema = z.object({
  id: uuid,
  expected_version: z.number().int().positive(),
  claim_token: uuid.optional(),
  type: z.enum(FEEDBACK_TYPES).optional(),
  title: z.string().trim().min(1).max(255).optional(),
  component: z.string().trim().min(1).max(100).optional(),
  priority: z.enum(FEEDBACK_PRIORITIES).optional(),
  status: z.enum(['open', 'blocked', 'resolved', 'dismissed', 'duplicate']).optional(),
  note: body.optional(),
  reason: short.optional(),
  resolution: body.optional(),
  fix_ref: short.optional(),
  verification: body.optional(),
  duplicate_of: uuid.optional(),
  deployment: z.enum(FEEDBACK_DEPLOYMENTS).optional(),
  deployment_ref: short.optional(),
}).strict();

export const feedbackPurgeSchema = z.object({
  statuses: z.array(z.enum(FEEDBACK_CLOSED_STATUSES)).min(1).max(FEEDBACK_CLOSED_STATUSES.length),
  // Compared against updated_at, i.e. when the item was last changed (normally its closure).
  older_than: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
}).strict();

export function parseFeedback<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

export function feedbackId(input: unknown): string {
  return parseFeedback(uuid, input);
}

export interface FeedbackActor extends Record<string, unknown> {
  host_id: number | null;
  engine: string | null;
  admin_user_id?: number;
  agent_uuid?: string;
}
