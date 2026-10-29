/**
 * Regenerates every model-registry view that lives outside the API process:
 * the admin SPA's `frontend/src/lib/constants/models.generated.ts` and the tier
 * table block in `docs/model-tiers.md`.
 *
 * Run from `api/` with `npm run models:generate` after editing
 * `src/services/model-registry/data.ts`.
 * `test/unit/contract/frontend-model-registry.test.ts` fails until you have.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRONTEND_MODELS_PATH,
  TIER_DOC_PATH,
  renderFrontendModels,
  replaceTierTable,
} from '../src/services/model-registry/render.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function write(relative: string, next: string): void {
  const path = resolve(ROOT, relative);
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === next) {
    console.log(`${relative} already current`);
  } else {
    writeFileSync(path, next);
    console.log(`${relative} regenerated`);
  }
}

write(FRONTEND_MODELS_PATH, renderFrontendModels());
write(TIER_DOC_PATH, replaceTierTable(readFileSync(resolve(ROOT, TIER_DOC_PATH), 'utf8')));
