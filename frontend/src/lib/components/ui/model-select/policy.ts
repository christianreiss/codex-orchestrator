import type { ModelOption } from '$lib/constants/models';
import type { Engine } from '$lib/constants/engines';
import type { ModelPolicy } from '$lib/api/model-policy';
export function modelOptionsEngine(options: ModelOption[]): Engine | null {
  if (options.some(option => option.value.startsWith('gpt-'))) return 'codex';
  if (options.some(option => option.value.startsWith('claude-'))) return 'claude';
  if (options.some(option => option.value.startsWith('grok-'))) return 'grok';
  return null;
}
export function filterModelOptions(options: ModelOption[], policy?: ModelPolicy): ModelOption[] {
  if (!policy?.latest_only) return options;
  return options.filter(option => !Object.hasOwn(policy.replacements, option.value) || policy.latest_models.includes(option.value));
}
