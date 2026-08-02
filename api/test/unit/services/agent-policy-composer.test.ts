import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/http/errors.js';
import {
  AGENT_POLICY_MODULE_IDS,
  AGENT_POLICY_REQUIRED,
  agentPolicyCatalog,
  defaultAgentPolicyComposition,
  renderAgentPolicyBase,
} from '../../../src/services/agent-policy-composer.js';

describe('agent policy composer', () => {
  it('ships the complete current policy as the fresh-install default', () => {
    const composition = defaultAgentPolicyComposition();
    const rendered = renderAgentPolicyBase(composition);

    expect(composition.enabled_modules).toEqual(AGENT_POLICY_MODULE_IDS);
    expect(agentPolicyCatalog().required).toEqual(AGENT_POLICY_REQUIRED);
    expect(rendered.content).toContain('## Operating Contract (FAST)');
    expect(rendered.content).toContain('## Git and Shared-Worktree Safety');
    expect(rendered.content).toContain('## Midnight Rule');
    expect(rendered.content).not.toContain('Fleet Management');
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered.size_bytes).toBe(Buffer.byteLength(rendered.content, 'utf8'));
  });

  it('renders modules in catalog order and appends custom instructions', () => {
    const rendered = renderAgentPolicyBase({
      ...defaultAgentPolicyComposition(),
      enabled_modules: ['response_style', 'operating_contract'],
      custom_instructions: 'Keep the operator note.',
    });

    expect(rendered.composition.enabled_modules).toEqual(['operating_contract', 'response_style']);
    expect(rendered.content.indexOf('Operating Contract')).toBeLessThan(rendered.content.indexOf('Default Response Shape'));
    expect(rendered.content).toMatch(/## Custom Instructions\n\nKeep the operator note\.\n$/);
  });

  it('rejects unknown, duplicate, and future template inputs', () => {
    const base = defaultAgentPolicyComposition();
    const cases = [
      { ...base, enabled_modules: ['unknown'] },
      { ...base, enabled_modules: ['security', 'security'] },
      { ...base, template_version: 2 },
    ];
    for (const input of cases) {
      expect(() => renderAgentPolicyBase(input)).toThrow(ValidationError);
    }
  });
});
