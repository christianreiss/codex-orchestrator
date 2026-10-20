import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import type { Engine } from '../util/engine.js';

export const quotaPolicySchema = z.object({
  unlimited: z.boolean(),
  short_warn_percent: z.number().int().min(1).max(100).nullable(),
  long_warn_percent: z.number().int().min(1).max(100).nullable(),
  short_auto_resume: z.boolean(),
  long_auto_resume: z.boolean(),
}).strict();
export type QuotaPolicy = z.infer<typeof quotaPolicySchema>;
export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  unlimited: false, short_warn_percent: 85, long_warn_percent: 85,
  short_auto_resume: true, long_auto_resume: false,
};
export const quotaPolicyKey = (engine: Engine, accountId?: number) =>
  accountId === undefined ? `quota_policy_${engine}` : `quota_policy_account_${accountId}`;
export async function readQuotaPolicy(db: Pick<Database, 'select'>, engine: Engine, accountId?: number) {
  const read = async (key: string) => {
    const [row] = await db.select().from(versions).where(eq(versions.name, key));
    if (!row?.version) return null;
    try { return quotaPolicySchema.parse(JSON.parse(row.version)); }
    catch { return { ...DEFAULT_QUOTA_POLICY, short_auto_resume: false, long_auto_resume: false }; }
  };
  const defaults = await read(quotaPolicyKey(engine)) ?? DEFAULT_QUOTA_POLICY;
  const override = accountId === undefined ? null : await read(quotaPolicyKey(engine, accountId));
  return { defaults, override, effective: override ?? defaults };
}
