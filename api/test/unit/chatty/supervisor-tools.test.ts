import { describe, expect, it, vi } from 'vitest';
import { AgentSupervisor } from '../../../src/services/agent-supervisor.js';
import { supervisorTools } from '../../../src/services/chatty/supervisor-tools.js';
import type { ToolContext } from '../../../src/services/chatty/tools.js';
const context = { db: {}, keyring: {}, actor: { userId: 7, sessionId: 9 } } as ToolContext;

describe('Chatty supervisor administration', () => {
  it('configures the existing domain with the acting administrator and confirmation', async () => {
    const set = vi
      .spyOn(AgentSupervisor.prototype, 'setEnabled')
      .mockResolvedValue({ enabled: true } as never);
    try {
      const tool = supervisorTools().find((item) => item.name === 'supervisor_state_set')!;
      expect(tool).toMatchObject({ capability: 'agent_messaging.manage', write: true, confirm: true });
      await tool.run(context, { enabled: true });
      expect(set).toHaveBeenCalledWith(true, 7);
    } finally {
      set.mockRestore();
    }
  });
  it('pauses a versioned task without exposing run, restart or resume commands', async () => {
    const pause = vi.spyOn(AgentSupervisor.prototype, 'pause').mockResolvedValue({ enabled: false } as never);
    try {
      const target = 'agent:00000000-0000-4000-8000-000000000001';
      const tools = supervisorTools(),
        tool = tools.find((item) => item.name === 'supervisor_pause')!;
      expect(tool.confirm).toBe(true);
      await tool.run(context, { target, version: 3 });
      expect(pause).toHaveBeenCalledWith(target, 3);
      expect(() => tool.parse({ target, version: 0 })).toThrow();
      expect(() => tool.parse({ target, version: 3, resume: true })).toThrow();
      expect(tools.every((item) => !/enable|restart|resume|launch/.test(item.name))).toBe(true);
    } finally {
      pause.mockRestore();
    }
  });
});
