import { describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import { anthropicModelObject, createGatewayBackends } from '../../../src/services/gateway-backends.js';
import {
  CLAUDE_MODEL_LINES,
  CLAUDE_SUPPORTED_MODELS,
  createClaudeModelsService,
  modelObject,
} from '../../../src/services/claude-models.js';

/**
 * CLX-7: the Models API `line` field (platform.claude.com/docs/en/api/models/list,
 * fetched 2026-10-28) is `ModelLine or null`, one of haiku/sonnet/opus/fable/mythos,
 * and must not be inferred from the id by clients. The gateway serves it from
 * explicit catalog data and emits `null` for models that belong to no line.
 */

function fakeDb(): Database {
  const fluent = (rows: unknown[]) => ({
    from: () => fluent(rows),
    where: () => fluent(rows),
    limit: async () => rows,
    orderBy: () => fluent(rows),
  });
  return { select: () => fluent([]) } as unknown as Database;
}

const LINES = new Set(['haiku', 'sonnet', 'opus', 'fable', 'mythos']);

describe('Anthropic Models API line field', () => {
  it('assigns every catalog model a documented line', () => {
    for (const id of CLAUDE_SUPPORTED_MODELS) expect(LINES.has(CLAUDE_MODEL_LINES[id])).toBe(true);
    expect(CLAUDE_MODEL_LINES['claude-fable-5-1']).toBe('fable');
    expect(CLAUDE_MODEL_LINES['claude-opus-5-5']).toBe('opus');
    expect(CLAUDE_MODEL_LINES['claude-opus-4-5-20251101']).toBe('opus');
    expect(CLAUDE_MODEL_LINES['claude-sonnet-4-6']).toBe('sonnet');
    expect(CLAUDE_MODEL_LINES['claude-haiku-5-5']).toBe('haiku');
    expect(CLAUDE_MODEL_LINES['claude-haiku-4-5-20251001']).toBe('haiku');
  });

  it('carries line on the Claude models service objects', async () => {
    expect(modelObject('claude-sonnet-5-5').line).toBe('sonnet');
    const list = await createClaudeModelsService(fakeDb()).modelsResponse();
    for (const model of list.data) expect(model.line).toBe(CLAUDE_MODEL_LINES[model.id]);
  });

  it('carries line through the production Claude gateway backend', async () => {
    const backends = createGatewayBackends({ db: fakeDb(), env: {} as never, keyring: {} as never });
    const claude = backends.get('claude');
    expect(anthropicModelObject(claude.models.info('claude-opus-4-8')).line).toBe('opus');
    const catalog = await claude.models.catalog();
    expect(catalog.length).toBe(CLAUDE_SUPPORTED_MODELS.length);
    for (const info of catalog) {
      expect(anthropicModelObject(info).line).toBe(CLAUDE_MODEL_LINES[info.id as keyof typeof CLAUDE_MODEL_LINES]);
    }
  });

  it('renders line as null for backends whose models belong to no Anthropic line', async () => {
    const backends = createGatewayBackends({ db: fakeDb(), env: {} as never, keyring: {} as never });
    const codex = await backends.get('codex').models.catalog();
    expect(codex.length).toBeGreaterThan(0);
    for (const info of codex) {
      const object = anthropicModelObject(info);
      expect(object).toHaveProperty('line');
      expect(object.line).toBeNull();
    }
    const grok = backends.get('grok').models.info('grok-4.7');
    expect(anthropicModelObject(grok).line).toBeNull();
  });
});
