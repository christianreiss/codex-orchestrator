/**
 * Holds `docs/ADMIN.md` against the matrix it describes.
 *
 * This repository has published a wrong authorization model twice. First a
 * four-role capability matrix that no code implemented — documented permissions
 * an operator could plan around and that the server never enforced. Then, after
 * that was removed, the sentence "There is no capability system in the Node
 * API", which was accurate until the layer landed and dangerously wrong the
 * moment it did.
 *
 * Prose cannot be prevented from going stale, so the table is not prose: it is
 * rendered from `ROLE_CAPABILITIES` into a marked block, and this test
 * re-renders and compares. The failure message is the block to paste.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../../../src/security/capabilities.js';
import {
  CAPABILITY_TABLE_BEGIN,
  CAPABILITY_TABLE_END,
  renderCapabilityTable,
} from '../../../src/security/capability-docs.js';
import { VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_DOC = resolve(HERE, '../../../../docs/ADMIN.md');
const LOGIN_DOC = resolve(HERE, '../../../../docs/LOGIN.md');

const adminMarkdown = readFileSync(ADMIN_DOC, 'utf8');
const loginMarkdown = readFileSync(LOGIN_DOC, 'utf8');

describe('published capability matrix', () => {
  it('renders a table with a row per capability and a column per role', () => {
    const table = renderCapabilityTable();
    // A renderer that emitted an empty block would satisfy the comparison below
    // against a doc that also held an empty block.
    for (const capability of CAPABILITIES) {
      expect(table, `${capability} is missing from the rendered table`).toContain(
        `\`${capability}\``,
      );
    }
    for (const role of VALID_ACCESS_LEVELS) {
      expect(table, `${role} is missing from the rendered table`).toContain(`\`${role}\``);
    }
    expect(table.split('\n').length).toBeGreaterThan(CAPABILITIES.length);
  });

  it('matches the block published in docs/ADMIN.md', () => {
    const start = adminMarkdown.indexOf(CAPABILITY_TABLE_BEGIN);
    const end = adminMarkdown.indexOf(CAPABILITY_TABLE_END);
    expect(start, `no ${CAPABILITY_TABLE_BEGIN} marker in docs/ADMIN.md`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const published = adminMarkdown.slice(start, end + CAPABILITY_TABLE_END.length);
    expect(published, 'run `npm run docs:capabilities` from api/').toEqual(renderCapabilityTable());
  });

  it('publishes a grant for every capability, so none is silently unreachable', () => {
    const ungranted = CAPABILITIES.filter((capability) =>
      VALID_ACCESS_LEVELS.every((role) => !ROLE_CAPABILITIES[role].includes(capability)),
    );
    expect(
      ungranted,
      'no role holds these, so the routes behind them are unreachable by anyone',
    ).toEqual([]);
  });

  it('no longer claims the API has no capability system', () => {
    for (const [name, markdown] of [
      ['ADMIN.md', adminMarkdown],
      ['LOGIN.md', loginMarkdown],
    ] as const) {
      expect(markdown, `docs/${name} still denies the capability layer`).not.toMatch(
        /(?:is )?no capability system|no named capabilities/i,
      );
      expect(markdown, `docs/${name} still describes the removed six-gate model`).not.toMatch(
        /exactly six role gates|six, all `owner`-or-`admin`/i,
      );
    }
  });

  it('tells an upgrading operator that roles lose access', () => {
    // The tightening is the point of the change and the one thing an operator
    // cannot discover from a green deploy — a viewer simply starts getting 403s.
    expect(adminMarkdown).toMatch(/lose access they had/i);
  });
});
