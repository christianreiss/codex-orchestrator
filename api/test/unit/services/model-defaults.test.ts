import { describe, expect, it } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';
import { createDbFake } from '../../helpers/db-fake.js';

function configRow(engine: 'codex' | 'claude', settings: Record<string, unknown>, sha = 'a'.repeat(64)) {
  return {
    id: 1,
    engine,
    sha256: sha,
    body: engine === 'claude' ? '{}\n' : 'model = "old"\n',
    settings,
    sourceHostId: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

describe('ModelDefaultsService', () => {
  it('reports greenfield defaults and the complete per-engine catalogs', async () => {
    const db = createDbFake();
    const service = new ModelDefaultsService(db as never);

    const codex = await service.get(ENGINE_CODEX);
    expect(codex).toMatchObject({
      engine: 'codex',
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
    });
    expect(codex.catalog).toEqual([
      {
        model: 'gpt-5.6-sol',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.6-terra',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.6-luna',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.5',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.4',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.4-mini',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'medium',
      },
      {
        model: 'gpt-5.3-codex-spark',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'high',
      },
    ]);

    const claude = await service.get(ENGINE_CLAUDE);
    expect(claude).toMatchObject({
      engine: 'claude',
      model: 'claude-sonnet-5',
      reasoning_effort: 'high',
    });
    expect(claude.catalog).toEqual([
      {
        model: 'claude-fable-5',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'high',
      },
      {
        model: 'claude-opus-5',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'high',
      },
      {
        model: 'claude-opus-4-8',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'high',
      },
      {
        model: 'claude-sonnet-5',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'high',
      },
      {
        model: 'claude-opus-4-7',
        persistent_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'xhigh',
      },
      {
        model: 'claude-sonnet-4-6',
        persistent_efforts: ['low', 'medium', 'high'],
        default_effort: 'high',
      },
      {
        model: 'claude-haiku-4-5-20251001',
        persistent_efforts: [],
        default_effort: null,
      },
    ]);
  });

  it('merges Codex defaults into the canonical document without losing other settings', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [
      configRow('codex', {
        model: 'gpt-5.4',
        model_reasoning_effort: 'medium',
        approval_policy: 'never',
        features: { memories: true },
      }),
    ]);
    const service = new ModelDefaultsService(db as never);

    const response = await service.set(ENGINE_CODEX, {
      model: 'gpt-5.6-sol',
      reasoning_effort: 'ultra',
    });
    expect(response).toMatchObject({
      engine: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'ultra',
    });

    const rows = db.tables.get(clientConfigDocuments) ?? [];
    const saved = rows.at(-1)?.settings as Record<string, unknown>;
    expect(saved).toMatchObject({
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'ultra',
      approval_policy: 'never',
      features: { memories: true },
    });
  });

  it('uses Claude model defaults and removes effortLevel for Haiku', async () => {
    const db = createDbFake();
    db.tables.set(clientConfigDocuments, [
      configRow('claude', {
        model: 'claude-opus-4-7',
        effortLevel: 'xhigh',
        env: { FOO: 'bar' },
        hooks: { Stop: [{ commands: ['echo done'] }] },
      }),
    ]);
    const service = new ModelDefaultsService(db as never);

    const response = await service.set(ENGINE_CLAUDE, {
      model: 'claude-haiku-4-5-20251001',
      reasoning_effort: null,
    });
    expect(response).toMatchObject({
      engine: 'claude',
      model: 'claude-haiku-4-5-20251001',
      reasoning_effort: null,
    });

    const rows = db.tables.get(clientConfigDocuments) ?? [];
    const saved = rows.at(-1)?.settings as Record<string, unknown>;
    expect(saved.model).toBe('claude-haiku-4-5-20251001');
    expect(saved).not.toHaveProperty('effortLevel');
    expect(saved).toMatchObject({
      env: { FOO: 'bar' },
      hooks: { Stop: [{ commands: ['echo done'] }] },
    });
  });

  it('strictly rejects unknown fields, models, and incompatible efforts', async () => {
    const service = new ModelDefaultsService(createDbFake() as never);

    await expect(
      service.set(ENGINE_CODEX, {
        model: 'gpt-5.4',
        reasoning_effort: 'ultra',
      }),
    ).rejects.toMatchObject({ status: 422, param: 'reasoning_effort' });
    await expect(
      service.set(ENGINE_CODEX, {
        model: 'gpt-5.6-luna',
        reasoning_effort: 'ultra',
      }),
    ).rejects.toMatchObject({ status: 422, param: 'reasoning_effort' });
    await expect(
      service.set(ENGINE_CODEX, {
        model: 'gpt-5.5',
        reasoning_effort: 'minimal',
      }),
    ).rejects.toMatchObject({ status: 422, param: 'reasoning_effort' });
    await expect(
      service.set(ENGINE_CLAUDE, {
        model: 'claude-haiku-4-5-20251001',
        reasoning_effort: 'high',
      }),
    ).rejects.toMatchObject({ status: 422, param: 'reasoning_effort' });
    await expect(
      service.set(ENGINE_CLAUDE, {
        model: 'claude-unknown',
      }),
    ).rejects.toMatchObject({ status: 422, param: 'model' });
    await expect(
      service.set(ENGINE_CODEX, {
        model: 'gpt-5.4',
        extra: true,
      }),
    ).rejects.toMatchObject({ status: 422, param: 'extra' });
  });
});
