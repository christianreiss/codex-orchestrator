import { z } from 'zod';
import { capabilitiesForRole, type Capability } from '../../security/capabilities.js';

export const providers = ['chatgpt', 'claude', 'grok', 'kimi'] as const;
export const categories = [
  'hosts',
  'projects',
  'memory',
  'content',
  'coordination',
  'workflows',
  'feedback',
] as const;
export const grantSchema = z
  .object({
    categories: z.record(z.enum(categories), z.enum(['ro', 'rw'])).default({}),
    tools: z.array(z.string()).max(200).default([]),
    hosts: z.array(z.number().int().positive()).max(500).default([]),
    projects: z.array(z.string().min(1).max(255)).max(500).default([]),
    global: z.boolean().default(false),
    sensitive: z.array(z.enum(['secrets.metadata', 'secrets.reveal', 'delete', 'delegate'])).default([]),
  })
  .strict();
export type GrantScope = z.infer<typeof grantSchema>;
export const policySchema = z
  .object({
    enabled: z.boolean().default(false),
    providers: z
      .object({ chatgpt: z.boolean(), claude: z.boolean(), grok: z.boolean(), kimi: z.boolean().default(false) })
      .default({ chatgpt: false, claude: false, grok: false, kimi: false }),
    ceiling: grantSchema.default({}),
  })
  .strict();
export type ConnectorPolicy = z.infer<typeof policySchema>;
export interface OperationPolicy {
  category: (typeof categories)[number];
  write?: boolean;
  capability: Capability;
  sensitive?: GrantScope['sensitive'][number];
  global?: boolean;
}
export function allowed(
  scope: GrantScope,
  ceiling: GrantScope,
  role: string,
  name: string,
  op: OperationPolicy,
): boolean {
  if (!capabilitiesForRole(role).includes(op.capability)) return false;
  for (const s of [scope, ceiling]) {
    if (!s.categories[op.category] || (op.write && s.categories[op.category] !== 'rw')) return false;
    if (s.tools.length && !s.tools.includes(name)) return false;
    if (op.sensitive && !s.sensitive.includes(op.sensitive)) return false;
    if (op.global && !s.global) return false;
  }
  return true;
}
export function targetAllowed(
  scope: GrantScope,
  ceiling: GrantScope,
  type: 'hosts' | 'projects',
  target: number | string,
): boolean {
  return [scope, ceiling].every((s) => (s[type] as Array<string | number>).includes(target));
}

/** Freeze only currently permitted scope; later ceiling expansion cannot grow it. */
export function intersectScope(selected: GrantScope, ceiling: GrantScope): GrantScope {
  const result = grantSchema.parse({});
  for (const category of categories) {
    const a = selected.categories[category],
      b = ceiling.categories[category];
    if (a && b) result.categories[category] = a === 'rw' && b === 'rw' ? 'rw' : 'ro';
  }
  result.hosts = selected.hosts.filter((id) => ceiling.hosts.includes(id));
  result.projects = selected.projects.filter((id) => ceiling.projects.includes(id));
  result.global = selected.global && ceiling.global;
  result.sensitive = selected.sensitive.filter((s) => ceiling.sensitive.includes(s));
  result.tools = selected.tools;
  return result;
}
