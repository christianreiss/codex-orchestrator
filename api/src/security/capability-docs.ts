/**
 * Renders the role→capability matrix as the Markdown table `docs/ADMIN.md`
 * carries, so the documentation is generated from the matrix rather than
 * describing it from memory.
 *
 * The previous docs claimed a four-role capability matrix the API did not
 * implement, and then — after that was caught — claimed there was no capability
 * system at all. Both were true when written and false later. A table a test
 * regenerates cannot go stale in either direction: change `ROLE_CAPABILITIES`
 * without running `npm run docs:capabilities` and the invariant test fails with
 * the exact block to paste.
 */

import { CAPABILITIES, ROLE_CAPABILITIES, type Capability } from './capabilities.js';
import { VALID_ACCESS_LEVELS, type AccessLevel } from '../services/admin-auth.js';

export const CAPABILITY_TABLE_BEGIN = '<!-- BEGIN GENERATED: capability-matrix -->';
export const CAPABILITY_TABLE_END = '<!-- END GENERATED: capability-matrix -->';

/** Column order: privileged first, then fleet, then the read-only roles. */
const ROLE_ORDER: readonly AccessLevel[] = [
  'owner',
  'admin',
  'fleet_operator',
  'trusted_user',
  'viewer',
  'user',
];

function held(role: AccessLevel, capability: Capability): string {
  return ROLE_CAPABILITIES[role].includes(capability) ? 'yes' : '—';
}

/**
 * The generated block, markers included. Regenerate with
 * `npm run docs:capabilities` from `api/`.
 */
export function renderCapabilityTable(): string {
  // A role added to VALID_ACCESS_LEVELS but not to ROLE_ORDER would silently
  // vanish from the published table, which is the one failure this file exists
  // to prevent.
  const missing = VALID_ACCESS_LEVELS.filter((role) => !ROLE_ORDER.includes(role));
  if (missing.length > 0) {
    throw new Error(`add ${missing.join(', ')} to ROLE_ORDER in security/capability-docs.ts`);
  }

  const header = `| Capability | ${ROLE_ORDER.map((r) => `\`${r}\``).join(' | ')} |`;
  const rule = `| --- | ${ROLE_ORDER.map(() => '---').join(' | ')} |`;
  const rows = CAPABILITIES.map(
    (capability) =>
      `| \`${capability}\` | ${ROLE_ORDER.map((role) => held(role, capability)).join(' | ')} |`,
  );
  return [CAPABILITY_TABLE_BEGIN, '', header, rule, ...rows, '', CAPABILITY_TABLE_END].join('\n');
}
