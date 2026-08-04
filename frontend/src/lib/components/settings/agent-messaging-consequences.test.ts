import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const consequencesModule: string = "./agent-messaging-consequences.ts";
const { agentMessagingConfirmCopy } = (await import(
  consequencesModule
)) as typeof import("./agent-messaging-consequences");
type AgentMessagingBlastRadius =
  import("./agent-messaging-consequences").AgentMessagingBlastRadius;

const radius = (overrides: Partial<AgentMessagingBlastRadius> = {}): AgentMessagingBlastRadius => ({
  activeHosts: 4,
  openConversations: 3,
  pendingDeliveries: 7,
  acceptedDeliveries: 2,
  relays: 5,
  ...overrides,
});

describe("agentMessagingConfirmCopy", () => {
  it("styles only the disable direction as destructive", () => {
    // Enabling is additive and one click from being undone; disabling destroys
    // in-flight work. The button variant is the whole signal, since neither
    // direction asks the operator to type a token.
    assert.equal(agentMessagingConfirmCopy(true, radius()).destructive, false);
    assert.equal(agentMessagingConfirmCopy(false, radius()).destructive, true);
    assert.equal(
      agentMessagingConfirmCopy(true, radius()).title,
      "Enable Agent Messaging for the fleet",
    );
    assert.equal(
      agentMessagingConfirmCopy(false, radius()).title,
      "Disable Agent Messaging for the fleet",
    );
  });

  it("tells the operator that enabling rewrites the fleet's standing instructions", () => {
    // The fact nothing in the console says today, and the reason this dialog
    // exists at all: the whole file is replaced on every host.
    const copy = agentMessagingConfirmCopy(true, radius());
    const text = copy.consequences.join("\n");
    assert.match(text, /AGENTS\.md and CLAUDE\.md/);
    assert.match(text, /whole file is replaced/);
    assert.match(text, /no per-host opt-out/i);
    assert.match(text, /next wrapper launch/);
  });

  it("counts active hosts, and drops the number rather than guessing", () => {
    assert.match(agentMessagingConfirmCopy(true, radius({ activeHosts: 4 })).consequences[0]!, /— 4 today/);
    assert.match(agentMessagingConfirmCopy(true, radius({ activeHosts: 1 })).consequences[0]!, /— 1 today/);
    // Loading or failed: say "every active host" rather than claiming zero.
    const unknown = agentMessagingConfirmCopy(true, radius({ activeHosts: null })).consequences[0]!;
    assert.match(unknown, /every active host\./);
    assert.doesNotMatch(unknown, /today/);
    assert.doesNotMatch(unknown, /null/);
  });

  it("interpolates every live count into the disable copy", () => {
    const text = agentMessagingConfirmCopy(false, radius()).consequences.join("\n");
    assert.match(text, /Cancels 7 queued and in-flight deliveries/);
    assert.match(text, /marks 2 already-accepted deliveries ambiguous/);
    assert.match(text, /Cancels 3 open conversations/);
    assert.match(text, /revokes 5 relays/);
    assert.match(text, /Ambiguous is terminal/);
  });

  it("still renders zero counts", () => {
    // Being told the number is zero is the point: it is how an operator learns
    // the switch is safe to flip right now.
    const text = agentMessagingConfirmCopy(false, {
      activeHosts: 0,
      openConversations: 0,
      pendingDeliveries: 0,
      acceptedDeliveries: 0,
      relays: 0,
    }).consequences.join("\n");
    assert.match(text, /Cancels 0 queued and in-flight deliveries/);
    assert.match(text, /Cancels 0 open conversations and revokes 0 relays/);
  });

  it("promises removal on the same schedule, not immediately", () => {
    // Hosts keep the section until their next successful sync, so an agent can
    // briefly hold instructions for tools that no longer answer.
    const text = agentMessagingConfirmCopy(false, radius()).consequences.join("\n");
    assert.match(text, /next-launch-or-nightly schedule/);
  });
});
