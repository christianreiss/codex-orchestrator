import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-skills.js';

const description =
  'Inspect the Claude account pool and switch this session to another account at the next turn boundary instead of stopping at one account\'s quota.';
const manifest = `---
name: account-switch
description: "${description}"
---

# Account switch

A fleet can hold several Claude subscriptions. One account near its quota is not
the agent's limit while another account in the pool has headroom.

## Read the pool

Call account_status. It returns the bound account, every account's short and
weekly usage, the distribution policy (auto or manual; balanced or exhaust), a
pending switch and recommendation.action:

- continue: keep working. In auto mode the policy moves the session itself.
- switch: another account should take over; recommendation.account_id names it.
- pause: every usable account is at its limit. Save a continuation checkpoint.

quota_get carries the same recommendation under pool, and QUOTA/1 notices in a
pool name the other accounts.

## Switch

Call account_switch with target set to an account id from account_status, or
"auto" for the policy's choice. The switch is a request: the wrapper performs it
after the current turn ends, flushes the old account's token rotation and writes
the new credentials; the next prompt runs on the new account without a restart.

- Every session sharing this host user's Claude credentials moves together.
- The first request on the new account rebuilds the prompt cache once; avoid
  switching back and forth. In auto mode the policy waits its minimum dwell.
- A target that is paused, unverified or removed is refused.
- Switch only when the recommendation says so or the operator asks.
- clx accounts list and clx accounts use <id|auto> are the CLI equivalents.

Codex, Grok and Kimi have no live switch: the tools report that, and the pool
policy applies from their next launch.
`;

export const isManagedAccountSwitchSlug = (slug: string) => slug.trim().toLowerCase() === 'account-switch';

export function buildManagedAccountSwitchSkill(updatedAt: string): ManagedSkillManifest {
  return {
    slug: 'account-switch',
    display_name: 'Account Switch',
    description,
    manifest,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: 'skill://account-switch',
    canonical_uri: 'skill://account-switch',
    managed: true,
  };
}
