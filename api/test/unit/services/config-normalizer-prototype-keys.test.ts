import { describe, expect, it } from 'vitest';
import {
  defaultCodexReasoningEffortForModel,
  normalizeClaudeEffortLevel,
  normalizeReasoningEffortForModel,
  normalizeSettings,
} from '../../../src/services/config-normalizer.js';
import { renderClaudeSettingsPartialForHost } from '../../../src/services/client-config.js';
import { ENGINE_CLAUDE } from '../../../src/util/engine.js';

// Model ids pass through normalizeStoredModel/normalizeClaudeModel verbatim, so a
// stored settings doc or host override can name an inherited Object.prototype
// member. The per-model effort tables must not resolve those.
const INHERITED_KEYS = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];

describe('per-model effort tables: inherited Object.prototype keys', () => {
  for (const key of INHERITED_KEYS) {
    it(`treats ${key} as a model with no effort constraints`, () => {
      expect(normalizeReasoningEffortForModel('high', key)).toBe('high');
      expect(defaultCodexReasoningEffortForModel(key)).toBeNull();
      expect(normalizeClaudeEffortLevel('high', key)).toBeNull();
      expect(() => normalizeSettings({ model: key, model_reasoning_effort: 'high' })).not.toThrow();
    });
  }

  it('omits the Claude effort default for an inherited model override', () => {
    const { partial } = renderClaudeSettingsPartialForHost({
      settings: { model: 'claude-sonnet-4-6', effortLevel: 'high' },
      host: {
        claudeModelOverride: 'constructor',
        claudeReasoningEffortOverride: null,
      } as never,
      baseUrl: null,
      apiKey: null,
      engine: ENGINE_CLAUDE,
    });
    expect(partial.model).toBe('constructor');
    expect(partial).not.toHaveProperty('effortLevel');
  });
});

describe('per-model effort tables: real models', () => {
  it('constrains Codex efforts to the model table', () => {
    expect(normalizeReasoningEffortForModel('ultra', 'gpt-5.6-luna')).toBeNull();
    expect(normalizeReasoningEffortForModel('max', 'gpt-5.6-luna')).toBe('max');
  });

  it('reports the Codex per-model default effort', () => {
    expect(defaultCodexReasoningEffortForModel('gpt-5.3-codex-spark')).toBe('high');
  });

  it('constrains Claude effort levels to the model table', () => {
    expect(normalizeClaudeEffortLevel('xhigh', 'claude-sonnet-4-6')).toBeNull();
    expect(normalizeClaudeEffortLevel('high', 'claude-sonnet-4-6')).toBe('high');
  });
});
