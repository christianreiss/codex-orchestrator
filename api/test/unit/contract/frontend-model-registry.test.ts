import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FRONTEND_MODELS_PATH,
  TIER_DOC_PATH,
  renderFrontendModels,
  replaceTierTable,
} from '../../../src/services/model-registry/render.js';

/**
 * The admin SPA's model lists and the docs tier table are generated from the
 * model registry, not maintained beside it (docs/model-registry.md). A registry
 * edit without `npm run models:generate` fails here instead of shipping a
 * picker that offers a model the API no longer accepts, or hides a new one.
 */
const ROOT = resolve(import.meta.dirname, '../../../..');
const hint = 'run `cd api && npm run models:generate` and commit the result';

describe('registry-generated model views', () => {
  it(`${FRONTEND_MODELS_PATH} is current`, () => {
    expect(readFileSync(resolve(ROOT, FRONTEND_MODELS_PATH), 'utf8'), hint).toBe(renderFrontendModels());
  });

  it(`${TIER_DOC_PATH} tier table is current`, () => {
    const markdown = readFileSync(resolve(ROOT, TIER_DOC_PATH), 'utf8');
    expect(markdown, hint).toBe(replaceTierTable(markdown));
  });

  it('keeps hand-written model lists out of the frontend constants', () => {
    // models.ts may only re-export or spread the generated lists.
    const handwritten = readFileSync(resolve(ROOT, 'frontend/src/lib/constants/models.ts'), 'utf8');
    expect(handwritten).not.toMatch(/value:\s*["'](?:gpt-|claude-|grok-)/);
  });
});
