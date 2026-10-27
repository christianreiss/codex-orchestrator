import { z } from 'zod';
import { define } from './tool-definition.js';

/** Stable tool destinations resolve to the current product owner, including old aliases. */
export const HANDOFF_TARGETS = {
  accounts: '/admin/accounts',
  'api-keys': '/admin/api-keys',
  secrets: '/admin/secrets',
  users: '/admin/people',
  people: '/admin/people',
  account: '/admin/account',
  'account/passkeys': '/admin/account#security',
  authoring: '/admin/library',
  library: '/admin/library',
  settings: '/admin/settings',
  projects: '/admin/projects',
  transfers: '/admin/transfers',
  'agent-sessions': '/admin/agents',
  agents: '/admin/agents',
  'git-director': '/admin/git-director',
  workflows: '/admin/workflows',
  limits: '/admin/limits',
  roles: '/admin/library?type=roles',
  retention: '/admin/settings#retention',
  supervisor: '/admin/settings#agent-supervisor',
  schedules: '/admin/schedules',
  engines: '/admin/engines',
  messages: '/admin/agent-messaging',
  reports: '/admin/reports',
} as const;
const destinations = Object.keys(HANDOFF_TARGETS) as [
  keyof typeof HANDOFF_TARGETS,
  ...(keyof typeof HANDOFF_TARGETS)[],
];

export function handoffTool() {
  return define(
    'interactive_handoff',
    'Open the current interface for credentials, identity verification, uploads or operations not exposed as Chatty tools. Does not execute an operation.',
    'chatty.use',
    { destination: z.enum(destinations) },
    async (_c, a) => ({
      href: HANDOFF_TARGETS[a.destination],
      instruction: 'Complete this operation in the linked interface. Chatty has not executed it.',
    }),
  );
}
