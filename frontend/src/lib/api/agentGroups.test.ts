import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

const QUERY = "stub:agent-groups-query";
const CLIENT = "stub:agent-groups-client";
const KEYS = "stub:agent-groups-keys";
registerHooks({
  resolve(specifier, context, next) {
    const url = specifier === "@tanstack/svelte-query" ? QUERY : specifier === "./client" ? CLIENT : specifier === "./agentMessaging" ? KEYS : null;
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === QUERY) return { format: "module", shortCircuit: true, source: "export const invalidations = []; export function createMutation(options) { return options; } export function useQueryClient() { return { invalidateQueries: (options) => { invalidations.push(options.queryKey); return Promise.resolve(); } }; }" };
    if (url === CLIENT) return { format: "module", shortCircuit: true, source: "export const calls = []; export const api = { get: (path, options) => { calls.push({method:'GET',path,options}); return Promise.resolve({}); }, post: (path, body) => { calls.push({method:'POST',path,body}); return Promise.resolve({}); } };" };
    if (url === KEYS) return { format: "module", shortCircuit: true, source: "export const agentMessagingKeys = { all: ['agent-messaging'] };" };
    return next(url, context);
  },
});
const modulePath: string = "./agentGroups.ts";
const groups = await import(modulePath) as typeof import("./agentGroups");
const clientPath: string = CLIENT;
const { calls } = await import(clientPath) as { calls: Array<Record<string, unknown>> };
const queryPath: string = QUERY;
const { invalidations } = await import(queryPath) as { invalidations: unknown[][] };
beforeEach(() => { calls.length = 0; invalidations.length = 0; });

describe("Persistent audiences", () => {
  it("uses abortable, refreshable queries and never fetches an unselected group", async () => {
    const signal = new AbortController().signal;
    const list = groups.agentGroupsOptions();
    const detail = groups.agentGroupOptions("release-review");
    const subscriptions = groups.agentSubscriptionsOptions();
    assert.equal(groups.agentGroupOptions("").enabled, false);
    assert.equal(detail.refetchInterval, 15_000);
    assert.deepEqual(detail.queryKey, ["agent-messaging", "groups", "release-review"]);
    await list.queryFn({ signal }); await detail.queryFn({ signal }); await subscriptions.queryFn({ signal });
    assert.deepEqual(calls.map((call) => [call.method, call.path, (call.options as {signal: AbortSignal}).signal]), [
      ["GET", "/admin/agent-messaging/groups", signal],
      ["GET", "/admin/agent-messaging/groups/release-review", signal],
      ["GET", "/admin/agent-messaging/subscriptions", signal],
    ]);
  });
  it("sends the caller's exact publication receipt ID and invalidates metadata only", async () => {
    const mutation = groups.agentPublishMutation() as unknown as { mutationFn(input: import("./agentGroups").AgentPublishInput): Promise<unknown>; onSettled(): void };
    const input = { topic: groups.SERVER_TOPIC, content: "Fleet update", client_message_id: "11111111-1111-4111-8111-111111111111" };
    await mutation.mutationFn(input); mutation.onSettled();
    assert.deepEqual(calls, [{ method: "POST", path: "/admin/agent-messaging/publish", body: input }]);
    assert.deepEqual(invalidations, [["agent-messaging"]]);
  });
});
