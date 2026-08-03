import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

const QUERY_STUB = "stub:agent-messaging-svelte-query";
const CLIENT_STUB = "stub:agent-messaging-api-client";

const queryStubSource = `
export const invalidations = [];
export function createQuery(options) { return options; }
export function createMutation(options) { return options; }
export function useQueryClient() {
  return {
    invalidateQueries(filters) {
      invalidations.push(filters.queryKey);
      return Promise.resolve();
    },
  };
}
`;

const clientStubSource = `
export const calls = [];
function record(method, path, body) {
  calls.push({ method, path, body });
  if (path.endsWith("/reveal")) {
    return Promise.resolve({ message_id: "message-1", content: "decrypted content" });
  }
  return Promise.resolve({});
}
export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  patch: (path, body) => record("PATCH", path, body),
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === QUERY_STUB) {
      return { format: "module", shortCircuit: true, source: queryStubSource };
    }
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    return nextLoad(url, context);
  },
});

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: unknown;
}

interface BuiltQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
}

interface BuiltMutation<Variables = unknown> {
  mutationFn: (variables: Variables) => Promise<unknown>;
  onSettled?: (...args: unknown[]) => void;
}

const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };
const queryModule: string = QUERY_STUB;
const { invalidations } = (await import(queryModule)) as { invalidations: unknown[][] };
const messagingModule: string = "./agentMessaging.ts";
const messaging = (await import(messagingModule)) as typeof import("./agentMessaging");

const asQuery = (value: unknown): BuiltQuery => value as BuiltQuery;
const asMutation = <Variables>(value: unknown): BuiltMutation<Variables> =>
  value as BuiltMutation<Variables>;

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
});

describe("Agent Messaging query builders", () => {
  it("trusts authoritative address eligibility and always permits disable", () => {
    assert.equal(
      messaging.agentAddressToggleDisabled(
        { enabled: false, eligible: true },
      ),
      false,
    );
    assert.equal(
      messaging.agentAddressToggleDisabled(
        { enabled: false, eligible: false },
      ),
      true,
    );
    assert.equal(
      messaging.agentAddressToggleDisabled(
        { enabled: true, eligible: false },
      ),
      false,
    );

    assert.equal(messaging.agentAddressIneligibleReasonLabel("master_disabled"), "Fleet switch is off");
    assert.equal(messaging.agentAddressIneligibleReasonLabel("host_inactive"), "Host is not active");
    assert.equal(
      messaging.agentAddressIneligibleReasonLabel("insecure_window_closed"),
      "Insecure host — allowed window is closed",
    );
    assert.equal(
      messaging.agentAddressIneligibleReasonLabel("engine_disabled"),
      "Address engine is disabled on this host",
    );
    assert.equal(messaging.agentAddressIneligibleReasonLabel("future_reason"), "Address is not eligible");
    assert.equal(messaging.agentAddressIneligibleReasonLabel(null), null);
  });

  it("uses stable state and address keys", async () => {
    const state = asQuery(messaging.agentMessagingStateQuery());
    const addresses = asQuery(messaging.agentMessagingAddressesQuery());

    assert.deepEqual(state.queryKey, ["agent-messaging", "state"]);
    assert.deepEqual(addresses.queryKey, ["agent-messaging", "addresses"]);
    await state.queryFn();
    await addresses.queryFn();
    assert.deepEqual(calls, [
      { method: "GET", path: "/admin/agent-messaging/state", body: undefined },
      { method: "GET", path: "/admin/agent-messaging/addresses", body: undefined },
    ]);
  });

  it("puts conversation filters in both the key and URL", async () => {
    const query = asQuery(
      messaging.agentMessagingConversationsQuery({ status: "canceled", limit: 250 }),
    );

    assert.deepEqual(query.queryKey, [
      "agent-messaging",
      "conversations",
      { status: "canceled", limit: 250 },
    ]);
    await query.queryFn();
    assert.deepEqual(calls, [
      {
        method: "GET",
        path: "/admin/agent-messaging/conversations?status=canceled&limit=250",
        body: undefined,
      },
    ]);
  });

  it("normalizes message filters and bounds the server limit", async () => {
    const conversationId = " 123e4567-e89b-42d3-a456-426614174000 ";
    const query = asQuery(
      messaging.agentMessagingMessagesQuery({
        conversationId,
        status: "ambiguous",
        limit: 900,
      }),
    );

    assert.deepEqual(query.queryKey, [
      "agent-messaging",
      "messages",
      {
        conversation_id: conversationId.trim(),
        status: "ambiguous",
        limit: 500,
        enabled: true,
      },
    ]);
    assert.equal(query.enabled, true);
    await query.queryFn();
    assert.deepEqual(calls, [
      {
        method: "GET",
        path:
          "/admin/agent-messaging/messages?conversation_id=123e4567-e89b-42d3-a456-426614174000&status=ambiguous&limit=500",
        body: undefined,
      },
    ]);
  });

  it("disables an invalid non-empty conversation UUID without sharing the unfiltered key", () => {
    const query = asQuery(
      messaging.agentMessagingMessagesQuery({
        conversationId: undefined,
        status: "queued",
        limit: 100,
        enabled: false,
      }),
    );

    assert.equal(query.enabled, false);
    assert.deepEqual(query.queryKey, [
      "agent-messaging",
      "messages",
      { conversation_id: null, status: "queued", limit: 100, enabled: false },
    ]);
    assert.deepEqual(calls, []);
  });
});

describe("Agent Messaging mutations", () => {
  it("toggles the fleet switch and invalidates the whole feature", async () => {
    const mutation = asMutation<boolean>(messaging.agentMessagingStateMutation());
    await mutation.mutationFn(true);
    mutation.onSettled?.(undefined, undefined, true, undefined);

    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/agent-messaging/state",
        body: { enabled: true },
      },
    ]);
    assert.deepEqual(invalidations, [["agent-messaging"]]);
  });

  it("uses the address, conversation and redrive contracts", async () => {
    const enabled = asMutation<{ id: string; enabled: boolean }>(
      messaging.agentAddressEnabledMutation(),
    );
    const alias = asMutation<{ id: string; alias: string | null }>(
      messaging.agentAddressAliasMutation(),
    );
    const cancel = asMutation<{ id: string; reason?: string }>(
      messaging.agentConversationCancelMutation(),
    );
    const redrive = asMutation<string>(messaging.agentMessageRedriveMutation());

    await enabled.mutationFn({ id: "address-1", enabled: false });
    await alias.mutationFn({ id: "address-1", alias: "agent:build" });
    await cancel.mutationFn({ id: "conversation-1" });
    await redrive.mutationFn("message-1");

    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/agent-messaging/addresses/address-1/enabled",
        body: { enabled: false },
      },
      {
        method: "PATCH",
        path: "/admin/agent-messaging/addresses/address-1",
        body: { alias: "agent:build" },
      },
      {
        method: "POST",
        path: "/admin/agent-messaging/conversations/conversation-1/cancel",
        body: { reason: null },
      },
      {
        method: "POST",
        path: "/admin/agent-messaging/messages/message-1/redrive",
        body: undefined,
      },
    ]);
  });

  it("reveals plaintext without putting it in the query cache or invalidating it", async () => {
    const content = await messaging.revealAgentMessage("message-1");

    assert.equal(content, "decrypted content");
    assert.deepEqual(invalidations, []);
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/agent-messaging/messages/message-1/reveal",
        body: undefined,
      },
    ]);
  });
});
