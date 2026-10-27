import { describe, expect, it } from 'vitest';
import { HANDOFF_TARGETS, handoffTool } from '../../../src/services/chatty/handoff-tools.js';
import type { ToolContext } from '../../../src/services/chatty/tools.js';

describe('Chatty product handoffs', () => {
  it('links newer administrative areas and repairs retired aliases without claiming execution', async () => {
    const tool = handoffTool();
    expect(tool.write).toBe(false);
    const cases = {
      workflows: '/admin/workflows', limits: '/admin/limits', roles: '/admin/library?type=roles',
      retention: '/admin/settings#retention', supervisor: '/admin/settings#agent-supervisor',
      'agent-sessions': '/admin/agents', users: '/admin/people',
      'account/passkeys': '/admin/account#security', authoring: '/admin/library',
    };
    for (const [destination, href] of Object.entries(cases)) {
      expect(await tool.run({} as ToolContext, { destination })).toEqual({
        href, instruction: 'Complete this operation in the linked interface. Chatty has not executed it.',
      });
    }
    expect(Object.values(HANDOFF_TARGETS).every((href) => href.startsWith('/admin/'))).toBe(true);
  });
  it('refuses arbitrary URLs, fragments and unsupported destinations', () => {
    for (const destination of ['https://example.com', '../auth', 'settings#arbitrary', 'shell'])
      expect(() => handoffTool().parse({ destination })).toThrow();
  });
});
