/**
 * Rewrites the generated capability-matrix block in `docs/ADMIN.md` in place.
 *
 * Run from `api/` with `npm run docs:capabilities` after changing
 * `ROLE_CAPABILITIES`. `test/unit/security/capability-docs.test.ts` fails until
 * you have.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_TABLE_BEGIN,
  CAPABILITY_TABLE_END,
  renderCapabilityTable,
} from '../src/security/capability-docs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../../docs/ADMIN.md');

const markdown = readFileSync(DOC, 'utf8');
const start = markdown.indexOf(CAPABILITY_TABLE_BEGIN);
const end = markdown.indexOf(CAPABILITY_TABLE_END);
if (start === -1 || end === -1) {
  throw new Error(`no ${CAPABILITY_TABLE_BEGIN} … ${CAPABILITY_TABLE_END} block in ${DOC}`);
}

const next =
  markdown.slice(0, start) +
  renderCapabilityTable() +
  markdown.slice(end + CAPABILITY_TABLE_END.length);

if (next === markdown) {
  console.log('docs/ADMIN.md capability matrix already current');
} else {
  writeFileSync(DOC, next);
  console.log('docs/ADMIN.md capability matrix regenerated');
}
