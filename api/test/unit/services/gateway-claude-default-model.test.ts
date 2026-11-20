import { describe, expect, it } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { createGatewayBackends } from '../../../src/services/gateway-backends.js';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/services/claude-models.js';
import { modelPolicyKey } from '../../../src/services/model-policy.js';
import { createDbFake } from '../../helpers/db-fake.js';

/**
 * The admin "Proxy default model" (`/admin/claude/settings`) was stored but
 * never read: a Claude-backed request without `model` always got the
 * constant. Grok and Kimi already apply their saved default; this is parity.
 */
function claudeModels(rows: Array<{ name: string; version: string }>) {
  const db = createDbFake(new Map([[versions, rows]]));
  return createGatewayBackends({ db: db as never, keyring: {} as never, env: {} as never }).get('claude').models;
}

describe('Claude gateway proxy default model', () => {
  it('answers a model-less request with the saved default', async () => {
    const models = claudeModels([{ name: 'claude_default_model', version: 'claude-haiku-5-5' }]);
    expect(await models.resolve(undefined)).toBe('claude-haiku-5-5');
    expect(await models.resolve('')).toBe('claude-haiku-5-5');
    // An explicit model still wins.
    expect(await models.resolve('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('applies the saved default under the latest-only policy too', async () => {
    const models = claudeModels([
      { name: 'claude_default_model', version: 'claude-haiku-5-5' },
      { name: modelPolicyKey('claude'), version: '1' },
    ]);
    expect(await models.resolve(undefined)).toBe('claude-haiku-5-5');
  });

  it('falls back to the built-in default when nothing usable is saved', async () => {
    expect(await claudeModels([]).resolve(undefined)).toBe(CLAUDE_DEFAULT_MODEL);
    expect(await claudeModels([{ name: 'claude_default_model', version: 'no-such-model' }]).resolve(undefined)).toBe(
      CLAUDE_DEFAULT_MODEL,
    );
  });
});
