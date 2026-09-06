import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../src/http/errors.js';
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_LEGACY_MODEL_UPGRADES,
  CLAUDE_SUPPORTED_MODELS,
  createClaudeModelsService,
} from '../../../src/services/claude-models.js';
import type { Database } from '../../../src/db/client.js';

/**
 * Stub Database that pretends `versions` has no `claude_models_disabled` row
 * (i.e. all models enabled). The service is exercised at a unit level — no
 * MySQL connection is opened. Real integration coverage lives elsewhere once
 * the contract suite lands.
 */
function fakeDb(): Database {
  const fluent = (rows: unknown[]) => ({
    from: () => fluent(rows),
    where: () => fluent(rows),
    limit: async () => rows,
    orderBy: () => fluent(rows),
  });
  return {
    select: () => fluent([]),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  } as unknown as Database;
}

describe('claude-models', () => {
  it('exposes a non-empty static catalog and a sane default', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(CLAUDE_SUPPORTED_MODELS).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('maps legacy model ids onto the current generation', () => {
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-sonnet-4-5']).toBe('claude-sonnet-5');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-3-opus-20240229']).toBe('claude-opus-4-8');
  });

  it('resolves missing/blank model strings to the default', async () => {
    const svc = createClaudeModelsService(fakeDb());
    expect(await svc.resolveRequestedModel(undefined)).toBe(CLAUDE_DEFAULT_MODEL);
    expect(await svc.resolveRequestedModel('')).toBe(CLAUDE_DEFAULT_MODEL);
    expect(await svc.resolveRequestedModel('   ')).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('resolves canonical and legacy model strings', async () => {
    const svc = createClaudeModelsService(fakeDb());
    expect(await svc.resolveRequestedModel('claude-fable-5')).toBe('claude-fable-5');
    expect(await svc.resolveRequestedModel('claude-opus-5')).toBe('claude-opus-5');
    expect(await svc.resolveRequestedModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(await svc.resolveRequestedModel('CLAUDE-SONNET-5')).toBe('claude-sonnet-5');
    expect(await svc.resolveRequestedModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(await svc.resolveRequestedModel('CLAUDE-SONNET-4-6')).toBe('claude-sonnet-4-6');
    expect(await svc.resolveRequestedModel('claude-3-5-sonnet-latest')).toBe('claude-sonnet-5');
  });

  it('upgrades pre-reconciliation picker ids to the gate canon', async () => {
    const svc = createClaudeModelsService(fakeDb());
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-opus-4-6']).toBe('claude-opus-4-8');
    expect(CLAUDE_LEGACY_MODEL_UPGRADES['claude-haiku-4-5']).toBe('claude-haiku-4-5-20251001');
    expect(await svc.resolveRequestedModel('claude-opus-4-6')).toBe('claude-opus-4-8');
    expect(await svc.resolveRequestedModel('claude-haiku-4-5')).toBe('claude-haiku-4-5-20251001');
  });

  it('throws Anthropic-shaped 404 not_found_error for unsupported ids', async () => {
    const svc = createClaudeModelsService(fakeDb());
    let err: unknown = null;
    try {
      await svc.resolveRequestedModel('gpt-4o');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.type).toBe('not_found_error');
    expect(apiErr.code).toBe('model_not_found');
    expect(apiErr.param).toBe('model');
  });

  it('404s on inherited Object.prototype names rather than resolving them', async () => {
    const svc = createClaudeModelsService(fakeDb());
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      let err: unknown = null;
      try {
        await svc.resolveRequestedModel(name);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('model_not_found');
    }
  });

  it('builds an Anthropic-shaped models response body', async () => {
    const svc = createClaudeModelsService(fakeDb());
    const out = await svc.modelsResponse();
    expect(out.data.length).toBe(CLAUDE_SUPPORTED_MODELS.length);
    // Canonical Anthropic Models API envelope.
    expect(out.has_more).toBe(false);
    expect(out.first_id).toBe(CLAUDE_SUPPORTED_MODELS[0]);
    expect(out.last_id).toBe(CLAUDE_SUPPORTED_MODELS[CLAUDE_SUPPORTED_MODELS.length - 1]);
    for (const m of out.data) {
      expect(m.type).toBe('model');
      expect(typeof m.display_name).toBe('string');
      expect(m.display_name.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(m.created_at))).toBe(false);
      expect(m.max_input_tokens).toBeGreaterThan(0);
      expect(m.max_tokens).toBeGreaterThan(0);
      expect((CLAUDE_SUPPORTED_MODELS as readonly string[]).includes(m.id)).toBe(true);
      // Retained OpenAI-compat aliases.
      expect(m.object).toBe('model');
      expect(m.owned_by).toBe('anthropic');
      expect(typeof m.created).toBe('number');
    }
    expect(out.object).toBe('list');
  });

  it('retrieves a single model and 404s on an unknown or blank id', async () => {
    const svc = createClaudeModelsService(fakeDb());
    const m = await svc.modelResponse('claude-opus-5');
    expect(m).toMatchObject({
      type: 'model',
      id: 'claude-opus-5',
      display_name: 'Claude Opus 5',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
    });
    expect((await svc.modelResponse('claude-haiku-4-5-20251001')).max_input_tokens).toBe(200_000);
    // Legacy aliases resolve to their canonical replacement.
    expect((await svc.modelResponse('claude-sonnet-4-5')).id).toBe('claude-sonnet-5');

    for (const bad of ['gpt-4o', '', '   ']) {
      await expect(svc.modelResponse(bad)).rejects.toMatchObject({
        status: 404,
        type: 'not_found_error',
      });
    }
  });
});
