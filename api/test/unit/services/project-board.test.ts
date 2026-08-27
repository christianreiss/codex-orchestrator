/**
 * The project board's pure decision logic, which is where a mistake would be
 * SILENT rather than loud.
 *
 * Everything that needs a real row lock — that two concurrent claims resolve to
 * one winner, that a reclaim fires on a dead address before its TTL, that card
 * events reach `project_changes` — lives in
 * `test/integration/project-board/project-board.test.ts` instead. `db-fake` has
 * neither transactions nor `SELECT … FOR UPDATE`; asserting exclusivity against
 * it would pass for the fake's reasons and prove nothing about MySQL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_RESOLUTIONS,
  claimIsLive,
  columnAdvisories,
  normalizeCardRef,
  normalizeResolution,
  resolveClaim,
  resolveReleaseTarget,
  SEEDED_COLUMNS,
  type ClaimRequester,
  type ClaimState,
} from '../../../src/services/project-board.js';
import {
  isProjectBoardRole,
  normalizeProjectBoardRole,
  PROJECT_BOARD_ROLES,
  projectBoardRoleList,
} from '../../../src/services/project-board-roles.js';
import { PROJECT_BOARD_TOOLS } from '../../../src/services/project-board-tool-names.js';

const NOW = '2026-08-27T12:00:00Z';

const held = (over: Partial<ClaimState> = {}): ClaimState => ({
  role: 'code',
  hostId: 7,
  username: 'chris',
  worktreeHash: 'hash-a',
  clientRequestId: 'req-1',
  claimedAt: '2026-08-27T11:40:00Z',
  expiresAt: '2026-08-27T12:10:00Z',
  releasedAt: null,
  ...over,
});

const asks = (over: Partial<ClaimRequester> = {}): ClaimRequester => ({
  hostId: 9,
  username: 'other',
  worktreeHash: 'hash-b',
  clientRequestId: null,
  ...over,
});

describe('claimIsLive', () => {
  it('is false for a card nobody ever claimed', () => {
    expect(claimIsLive(null, NOW)).toBe(false);
  });

  it('is false once released, even with time left on the clock', () => {
    expect(claimIsLive(held({ releasedAt: '2026-08-27T11:50:00Z' }), NOW)).toBe(false);
  });

  it('is false once expired', () => {
    expect(claimIsLive(held({ expiresAt: '2026-08-27T11:59:59Z' }), NOW)).toBe(false);
  });

  it('is true while unreleased and unexpired', () => {
    expect(claimIsLive(held(), NOW)).toBe(true);
  });

  // An unparseable stamp must not read as "still held forever": that would wedge
  // the card against every other agent with no way to get it back.
  it('is false when the expiry cannot be parsed', () => {
    expect(claimIsLive(held({ expiresAt: 'soon' }), NOW)).toBe(false);
  });
});

describe('resolveClaim', () => {
  it('grants a free card', () => {
    expect(resolveClaim(null, asks(), NOW)).toEqual({ outcome: 'granted' });
  });

  it('grants a card whose holder let the claim expire', () => {
    expect(resolveClaim(held({ expiresAt: '2026-08-27T11:00:00Z' }), asks(), NOW)).toEqual({
      outcome: 'granted',
    });
  });

  it('refuses a card somebody else holds', () => {
    expect(resolveClaim(held(), asks(), NOW)).toEqual({ outcome: 'held' });
  });

  it('renews rather than contending when the same actor asks again', () => {
    const same = asks({ hostId: 7, username: 'chris', worktreeHash: 'hash-a' });
    expect(resolveClaim(held(), same, NOW)).toEqual({ outcome: 'renewed' });
  });

  it('treats the same client_request_id as a retry of the original call', () => {
    expect(resolveClaim(held(), asks({ clientRequestId: 'req-1' }), NOW)).toEqual({
      outcome: 'retry',
    });
  });

  // A retried id must not resurrect a claim that was released, or a model
  // re-calling a tool minutes later would take a card back off whoever has it.
  it('does not honour a client_request_id against a released claim', () => {
    const released = held({ releasedAt: '2026-08-27T11:50:00Z' });
    expect(resolveClaim(released, asks({ clientRequestId: 'req-1' }), NOW)).toEqual({
      outcome: 'granted',
    });
  });

  // Two agents on one host are two actors. Matching on host alone would let one
  // silently take over the other's card.
  it('does not treat a different worktree on the same host as the same actor', () => {
    const other = asks({ hostId: 7, username: 'chris', worktreeHash: 'hash-z' });
    expect(resolveClaim(held(), other, NOW)).toEqual({ outcome: 'held' });
  });
});

describe('columnAdvisories', () => {
  const lane = { key: 'coding', title: 'Coding', allowedRoles: ['code'], wipLimit: null };

  it('says nothing when the role matches', () => {
    expect(columnAdvisories({ role: 'code', column: lane, occupancy: 0 })).toEqual([]);
  });

  it('advises, and never refuses, when the role does not match', () => {
    const advisories = columnAdvisories({ role: 'plan', column: lane, occupancy: 0 });
    expect(advisories.map((a) => a.code)).toEqual(['role_not_allowed']);
    expect(advisories[0]!.message).toContain('Coding');
  });

  it('says nothing for an open lane', () => {
    const open = { ...lane, allowedRoles: null };
    expect(columnAdvisories({ role: 'plan', column: open, occupancy: 0 })).toEqual([]);
  });

  // The console has no role to declare. Advising on every operator move would
  // train readers to ignore the field.
  it('says nothing when no role was declared', () => {
    expect(columnAdvisories({ role: null, column: lane, occupancy: 0 })).toEqual([]);
  });

  it('allows a lane at its limit and advises only once it would exceed it', () => {
    const limited = { ...lane, wipLimit: 3 };
    expect(columnAdvisories({ role: 'code', column: limited, occupancy: 1 })).toEqual([]);
    expect(columnAdvisories({ role: 'code', column: limited, occupancy: 2 })).toEqual([]);
    const over = columnAdvisories({ role: 'code', column: limited, occupancy: 3 });
    expect(over.map((a) => a.code)).toEqual(['wip_limit_exceeded']);
  });

  // A release auto-advances into the next lane, which belongs to a different
  // role by construction. The service passes no role there for exactly this
  // reason; if it ever passes the holder's role again, a role advisory fires on
  // every healthy handoff and readers learn to ignore the whole field.
  it('says nothing about a role on a handoff into the next role\'s lane', () => {
    const review = { key: 'review', title: 'Review', allowedRoles: ['review'], wipLimit: 2 };
    expect(columnAdvisories({ role: null, column: review, occupancy: 0 })).toEqual([]);
    // …but a genuine WIP problem still surfaces, role or no role.
    expect(columnAdvisories({ role: null, column: review, occupancy: 2 }).map((a) => a.code)).toEqual([
      'wip_limit_exceeded',
    ]);
  });

  it('reports both problems at once', () => {
    const limited = { ...lane, wipLimit: 1 };
    const advisories = columnAdvisories({ role: 'plan', column: limited, occupancy: 5 });
    expect(advisories.map((a) => a.code)).toEqual(['role_not_allowed', 'wip_limit_exceeded']);
  });
});

describe('resolveReleaseTarget', () => {
  const current = { id: 'col-coding', defaultNextColumnId: 'col-review' };
  const base = {
    current,
    requestedColumnId: null,
    resolution: null,
    terminalColumnId: 'col-done',
    blockedColumnId: 'col-blocked',
  } as const;

  it('auto-advances a bare release to the next column', () => {
    expect(resolveReleaseTarget({ ...base })).toBe('col-review');
  });

  it('prefers an explicitly named column over everything else', () => {
    expect(
      resolveReleaseTarget({ ...base, requestedColumnId: 'col-planning', resolution: 'done' }),
    ).toBe('col-planning');
  });

  // A handoff means somebody else picks the card up where it is, not that the
  // work advanced. Auto-advancing here would skip a stage nobody did.
  it('leaves a handoff exactly where it is', () => {
    expect(resolveReleaseTarget({ ...base, resolution: 'handoff' })).toBe('col-coding');
  });

  it('sends a blocked release to the blocked lane', () => {
    expect(resolveReleaseTarget({ ...base, resolution: 'blocked' })).toBe('col-blocked');
  });

  it('sends a done release to the terminal lane, not merely to the next one', () => {
    expect(resolveReleaseTarget({ ...base, resolution: 'done' })).toBe('col-done');
  });

  it('stays put when the chain ends here', () => {
    const last = { id: 'col-done', defaultNextColumnId: null };
    expect(resolveReleaseTarget({ ...base, current: last })).toBe('col-done');
  });

  // A board whose blocked lane an operator removed must still release.
  it('falls through to the auto-advance when the named lane does not exist', () => {
    expect(resolveReleaseTarget({ ...base, resolution: 'blocked', blockedColumnId: null })).toBe(
      'col-review',
    );
  });
});

describe('normalizeCardRef', () => {
  it.each([
    ['17', { id: null, number: 17 }],
    [17, { id: null, number: 17 }],
    ['#17', { id: null, number: 17 }],
    ['  42 ', { id: null, number: 42 }],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', number: null }],
    ['3F2504E0-4F89-41D3-9A0C-0305E82C3301', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', number: null }],
  ])('resolves %o', (input, expected) => {
    expect(normalizeCardRef(input)).toEqual(expected);
  });

  // Nothing here may resolve to card 0 or card NaN: the caller turns a double
  // null into a ValidationError, and a guess would silently address the wrong
  // card or none at all.
  it.each([['seventeen'], [''], ['   '], [null], [undefined], [0], [-4], [1.5], [{}]])(
    'refuses to guess at %o',
    (input) => {
      expect(normalizeCardRef(input)).toEqual({ id: null, number: null });
    },
  );
});

describe('normalizeProjectBoardRole', () => {
  it('accepts every fleet role, case- and space-insensitively', () => {
    for (const role of PROJECT_BOARD_ROLES) {
      expect(normalizeProjectBoardRole(` ${role.toUpperCase()} `)).toBe(role);
      expect(isProjectBoardRole(role)).toBe(true);
    }
  });

  // Unlike a feedback type, an unknown role must NOT fall back to a default:
  // the value is recorded as a fact about what an agent said it was doing, and
  // every advisory computed from it would inherit the guess.
  it.each([['builder'], ['coding'], [''], [null], [undefined], [42]])(
    'returns null for %o rather than guessing',
    (input) => {
      expect(normalizeProjectBoardRole(input)).toBeNull();
    },
  );

  it('renders the vocabulary for an error message', () => {
    expect(projectBoardRoleList()).toBe('plan, code, review, verify, ops');
  });
});

describe('normalizeResolution', () => {
  it('accepts each resolution', () => {
    for (const resolution of CARD_RESOLUTIONS) {
      expect(normalizeResolution(resolution.toUpperCase())).toBe(resolution);
    }
  });

  it.each([['finished'], ['']])('returns null for %o', (input) => {
    expect(normalizeResolution(input)).toBeNull();
  });

  it('treats an absent resolution as absent, not as an error', () => {
    expect(normalizeResolution(undefined)).toBeNull();
    expect(normalizeResolution(null)).toBeNull();
  });
});

/**
 * `SEEDED_COLUMNS` provisions a board created after migration 0026 ran; the
 * migration's own `INSERT … SELECT` provisions every board that predates it.
 * They are two spellings of one list — SQL cannot import TypeScript — so a
 * divergence would give projects different boards depending on when they were
 * created, silently, and only visibly much later.
 */
describe('the seeded lanes match migration 0026', () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, '../../../src/db/migrations/0026_add_project_board.sql'),
    'utf8',
  );

  /** The block a `JOIN ( … ) AS <alias>` wraps, so the two seed lists cannot cross-match. */
  const derivedTable = (alias: string): string => {
    const end = sql.indexOf(`) AS ${alias}`);
    expect(end, `no derived table aliased ${alias}`).toBeGreaterThan(-1);
    return sql.slice(sql.lastIndexOf('JOIN (', end), end);
  };

  it('seeds the same keys, in the same order, with the same flags', () => {
    const seeded = [...derivedTable('seed').matchAll(/SELECT '([a-z]+)'/g)].map((match) => match[1]);
    expect(seeded).toEqual(SEEDED_COLUMNS.map((column) => column.key));
  });

  it('chains the same successors', () => {
    const chain = [...derivedTable('chain').matchAll(/SELECT '([a-z]+)'\s+AS from_key, '([a-z]+)'|SELECT '([a-z]+)',\s+'([a-z]+)'/g)].map(
      (match) => [match[1] ?? match[3], match[2] ?? match[4]] as const,
    );
    const expected = SEEDED_COLUMNS.filter((column) => column.next).map(
      (column) => [column.key, column.next] as const,
    );
    expect(chain).toEqual(expected);
  });

  it('declares exactly one intake, one terminal and one blocked lane', () => {
    expect(SEEDED_COLUMNS.filter((column) => column.isIntake)).toHaveLength(1);
    expect(SEEDED_COLUMNS.filter((column) => column.isTerminal)).toHaveLength(1);
    expect(SEEDED_COLUMNS.filter((column) => column.isBlocked)).toHaveLength(1);
  });

  // Every gated lane must name a role that exists, or a board ships advising
  // against a vocabulary nobody can satisfy.
  it('gates lanes only on roles the fleet vocabulary declares', () => {
    for (const column of SEEDED_COLUMNS) {
      for (const role of column.allowedRoles ?? []) {
        expect(isProjectBoardRole(role), `${column.key} expects "${role}"`).toBe(true);
      }
    }
  });
});

describe('the tool name registry', () => {
  it('names seven tools, all under the project_ prefix the module already owns', () => {
    expect(PROJECT_BOARD_TOOLS).toHaveLength(7);
    for (const name of PROJECT_BOARD_TOOLS) expect(name.startsWith('project_')).toBe(true);
  });
});
