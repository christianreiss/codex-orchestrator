import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { providerAccounts } from '../db/schema.js';
import { ConflictError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';

/** Keep already-running clients usable after an operator consolidates duplicate accounts. */
export async function resolveProviderAccount(
  db: Pick<Database, 'select'>,
  id: number,
  engine?: Engine,
): Promise<typeof providerAccounts.$inferSelect | undefined> {
  const seen = new Set<number>();
  while (!seen.has(id)) {
    seen.add(id);
    const [account] = await db
      .select()
      .from(providerAccounts)
      .where(and(eq(providerAccounts.id, id), engine ? eq(providerAccounts.engine, engine) : undefined));
    if (!account || !account.mergedIntoAccountId) return account;
    engine = account.engine as Engine;
    id = account.mergedIntoAccountId;
  }
  throw new ConflictError('Invalid account merge reference', 'account_merge_cycle');
}
