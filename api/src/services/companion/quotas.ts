import { asc } from 'drizzle-orm';
import { providerAccounts } from '../../db/schema.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { readFleetEngineState } from '../engine-switch.js';
import { ENGINES, ENGINE_LABELS } from '../../util/engine.js';
import type { RouteContext } from '../../routes/index.js';

/** Snapshot-only projection: no credentials, sessions, provider calls or account maintenance. */
export async function companionQuotas(ctx: RouteContext) {
  const owner = ownerRuntimeFor(ctx.db);
  owner?.assertOwner();
  const accounts = owner
    ? owner.state.snapshot().accounts.all()
    : await ctx.db
        .select({
          id: providerAccounts.id,
          engine: providerAccounts.engine,
          label: providerAccounts.label,
          state: providerAccounts.state,
        })
        .from(providerAccounts)
        .orderBy(asc(providerAccounts.id));
  const enabled = await readFleetEngineState(ctx.db);
  const service = new ProviderAccountsService(ctx.db, ctx.keyring);
  return {
    engines: await Promise.all(
      ENGINES.map(async (engine) => ({
        engine,
        label: ENGINE_LABELS[engine],
        enabled: enabled[engine],
        accounts: await Promise.all(
          accounts
            .filter((a) => a.engine === engine && a.state !== 'removed')
            .sort((a, b) => a.id - b.id)
            .map(async (a) => {
              const usage = await service.usage(a.id, engine);
              const windows =
                engine === 'grok' && 'current_window' in usage
                  ? usage.current_window
                    ? [
                        {
                          kind: usage.current_window.period ?? 'current',
                          used_percent: usage.current_window.used_percent,
                          resets_at: usage.current_window.resets_at,
                          limit_seconds: null,
                        },
                      ]
                    : []
                  : [
                      {
                        kind: 'short',
                        used_percent: usage.short_used_percent,
                        resets_at: usage.short_resets_at,
                        limit_seconds: 'short_limit_seconds' in usage ? usage.short_limit_seconds : null,
                      },
                      {
                        kind: 'weekly',
                        used_percent: usage.weekly_used_percent,
                        resets_at: usage.weekly_resets_at,
                        limit_seconds: 'weekly_limit_seconds' in usage ? usage.weekly_limit_seconds : null,
                      },
                    ].filter((w) => w.used_percent !== null);
              return {
                id: a.id,
                label: a.label,
                state: a.state,
                fetched_at: usage.fetched_at,
                stale: usage.stale,
                windows,
              };
            }),
        ),
      })),
    ),
  };
}
