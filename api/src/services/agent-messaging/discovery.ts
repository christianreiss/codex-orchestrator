import { AGENT_MESSAGING_LIST_LIMIT } from './constants.js';
import { ValidationError } from '../../http/errors.js';
import type { Engine } from '../../util/engine.js';

export interface AgentDiscoveryFilters {
  engine?: Engine;
  hostId?: number;
  includeOffline?: boolean;
  name?: string;
  limit?: number;
  offset?: number;
}

/** Page a presence-ranked list; name matching is literal and case insensitive. */
export function pageAgentAddresses<
  T extends { address: { address: string; launchName: string | null; displayAlias: string | null } },
>(ranked: T[], filters: AgentDiscoveryFilters) {
  const limit = filters.limit ?? AGENT_MESSAGING_LIST_LIMIT;
  const offset = filters.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > AGENT_MESSAGING_LIST_LIMIT ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new ValidationError(
      'limit must be between 1 and 50 and offset must be a non-negative safe integer',
    );
  }
  const name = filters.name?.trim().toLowerCase();
  const matched = name
    ? ranked.filter(({ address }) =>
        [address.launchName, address.displayAlias, address.address].some((value) =>
          value?.toLowerCase().includes(name),
        ),
      )
    : ranked;
  const addresses = matched.slice(offset, offset + limit);
  const next = offset + addresses.length;
  return {
    addresses,
    total: matched.length,
    ...(next < matched.length ? { truncated: true, next_offset: next } : {}),
  };
}
