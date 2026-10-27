import { z } from 'zod';
import { AgentSupervisor } from '../agent-supervisor.js';
import { WatchdogsService } from '../watchdogs.js';
import { define } from './tool-definition.js';
import type { ChattyTool, ToolContext } from './tools.js';
const target = z
  .string()
  .regex(/^agent:[0-9a-f-]{36}$/i)
  .transform((value) => value.toLowerCase());
const supervisor = (c: ToolContext) => new AgentSupervisor(c.db, c.keyring);

export function supervisorTools(): ChattyTool[] {
  return [
    define(
      'supervisor_read',
      'Read fleet supervision settings, dependencies and task diagnostics; never runs or restarts an agent.',
      'agent_messaging.read',
      { target: target.optional() },
      async (c, a) => supervisor(c).list(a.target),
    ),
    define(
      'supervisor_state_set',
      'Configure the fleet supervision switch. Its existing subsystem monitors authorized work; this tool does not launch tasks or enable an individual recovery.',
      'agent_messaging.manage',
      { enabled: z.boolean() },
      (c, a) => supervisor(c).setEnabled(a.enabled, c.actor.userId),
      {
        confirm: true,
        snapshot: async (c) => supervisor(c).list(),
        href: () => '/admin/settings#agent-supervisor',
      },
    ),
    define(
      'supervisor_pause',
      'Pause supervision and future recovery of an existing task at its current version. Does not terminate its agent.',
      'agent_messaging.manage',
      { target, version: z.number().int().positive() },
      (c, a) => supervisor(c).pause(a.target, a.version),
      { confirm: true, snapshot: async (c, a) => supervisor(c).list(a.target), href: () => '/admin/agents' },
    ),
    define(
      'watchdog_read',
      'Read one bounded recovery watchdog and its existing status. Does not activate recovery.',
      'agent_messaging.read',
      { id: z.string().uuid() },
      (c, a) => new WatchdogsService(c.db, c.keyring).get(a.id),
    ),
  ];
}
