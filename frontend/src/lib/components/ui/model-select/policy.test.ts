import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const modulePath = './policy.ts';
const { filterModelOptions, modelOptionsEngine } = await import(modulePath) as typeof import('./policy');
describe('model choice policy', () => {
  it('infers the engine and leaves non-model controls alone', () => {
    assert.equal(modelOptionsEngine([{ value: 'gpt-6.1-sol', label: 'Sol' }]), 'codex');
    assert.equal(modelOptionsEngine([{ value: 'claude-opus-5', label: 'Opus' }]), 'claude');
    assert.equal(modelOptionsEngine([{ value: 'grok-4.7', label: 'Grok' }]), 'grok');
    assert.equal(modelOptionsEngine([{ value: 'low', label: 'Low' }]), null);
  });
  it('filters old versions, preserves inherit/clear sentinels, and restores the full list when off', () => {
    const options = ['inherit', 'old', 'new'].map(value => ({ value, label: value }));
    const policy = { engine: 'codex' as const, latest_only: true, replacements: { old: 'new', new: 'new' }, latest_models: ['new'] };
    assert.deepEqual(filterModelOptions(options, policy).map(item => item.value), ['inherit', 'new']);
    assert.equal(filterModelOptions(options, { ...policy, latest_only: false }), options);
    assert.equal(filterModelOptions(options), options);
  });
});
