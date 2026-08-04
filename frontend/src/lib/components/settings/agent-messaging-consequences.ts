/**
 * Confirmation copy for the Agent Messaging fleet switch.
 *
 * A pure function rather than markup inside the dialog, because the frontend
 * suite is `node --test` over `.ts` modules and there is no component harness —
 * copy that lives in a `.svelte` file cannot be reviewed by a test. This is the
 * one place the consequences of the switch are written down, so it is also the
 * one place to correct them.
 *
 * The counts are load-bearing, not decoration. Enabling rewrites the standing
 * instructions on every active host; disabling destroys whatever is on the bus
 * right now. Neither number is visible anywhere in the console today, and
 * showing the real figure is the honest alternative to a type-the-word gate.
 */

export interface AgentMessagingBlastRadius {
  /** Hosts with `status === 'active'`. `null` while the hosts list is loading or unavailable. */
  activeHosts: number | null;
  openConversations: number;
  /** queued + leased. */
  pendingDeliveries: number;
  acceptedDeliveries: number;
  relays: number;
}

export interface AgentMessagingConfirmCopy {
  title: string;
  description: string;
  consequences: string[];
  confirmLabel: string;
  destructive: boolean;
}

function hostPhrase(activeHosts: number | null): string {
  if (activeHosts === null) return "every active host";
  if (activeHosts === 1) return "every active host — 1 today";
  return `every active host — ${activeHosts} today`;
}

export function agentMessagingConfirmCopy(
  enabling: boolean,
  radius: AgentMessagingBlastRadius,
): AgentMessagingConfirmCopy {
  if (enabling) {
    return {
      title: "Enable Agent Messaging for the fleet",
      description:
        "This turns the agent-to-agent bus on everywhere and changes the standing instructions every agent reads.",
      consequences: [
        `An Agent Messaging section is added to the managed AGENTS.md and CLAUDE.md served to ${hostPhrase(radius.activeHosts)}. The whole file is replaced; there is no separate managed block on the host.`,
        "Hosts pick it up on the next wrapper launch, or on their nightly cron tick between 00:00 and 03:59. A host with a session already running is skipped until that session ends.",
        "Every agent on those hosts gains the cxx-agent MCP server and its ten peer-messaging tools, becomes addressable by other agents, and can be woken by them.",
        "There is no per-host opt-out. The fleet switch is the only switch, and it covers insecure hosts too.",
      ],
      confirmLabel: "Enable for the fleet",
      destructive: false,
    };
  }
  return {
    title: "Disable Agent Messaging for the fleet",
    description: "This stops the bus and discards the work currently on it.",
    consequences: [
      `Cancels ${radius.pendingDeliveries} queued and in-flight deliveries, and marks ${radius.acceptedDeliveries} already-accepted deliveries ambiguous. Ambiguous is terminal — nothing is replayed automatically.`,
      `Cancels ${radius.openConversations} open conversations and revokes ${radius.relays} relays. Any live #call drops mid-turn, and every open #conference is adjourned — a member part-way through a dispatched task loses that work.`,
      "Removes the Agent Messaging section from every host's AGENTS.md and CLAUDE.md and the cxx-agent server from their config, on the same next-launch-or-nightly schedule.",
      "History and audit metadata stay readable, and interactive Codex and Claude sessions keep running.",
    ],
    confirmLabel: "Disable for the fleet",
    destructive: true,
  };
}
