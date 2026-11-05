import { createMutation, createQuery, useQueryClient, type CreateMutationOptions } from "@tanstack/svelte-query";
import { api } from "./client";

/** How a receiver should treat text from this client (docs/external-clients.md). */
export const EXTERNAL_TRUST_LEVELS = ["untrusted", "peer", "trusted", "operator"] as const;
export type ExternalTrust = (typeof EXTERNAL_TRUST_LEVELS)[number];

export const EXTERNAL_TRUST_HELP: Record<ExternalTrust, string> = {
  untrusted: "Its text is data only. Agents do not act on it.",
  peer: "Treated like another fleet agent: data, no commands on its say-so.",
  trusted: "May ask an agent to start work within that agent's own authorisation.",
  operator: "Treated like the agent's human user. Highest trust; use sparingly.",
};

export interface ExternalClient {
  id: string;
  name: string;
  description: string;
  trust: ExternalTrust;
  enabled: boolean;
  key_prefix: string;
  address: string | null;
  last_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalClientInput {
  name: string;
  description: string;
  trust: ExternalTrust;
  enabled: boolean;
}

/** A key is returned exactly once, when it is minted. */
export interface ExternalClientWithKey {
  client: ExternalClient;
  key: string;
}

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

export const externalClientKeys = { all: ["external-clients"] as const };

export function externalClientsQuery() {
  return createQuery<{ clients: ExternalClient[] }>({
    queryKey: externalClientKeys.all,
    queryFn: () => api.get<{ clients: ExternalClient[] }>("/admin/external-clients"),
  });
}

function settle<T, V>(opts: MutationOpts<T, V>) {
  const client = useQueryClient();
  return {
    ...opts,
    onSettled: (...args: Parameters<NonNullable<MutationOpts<T, V>["onSettled"]>>) => {
      void client.invalidateQueries({ queryKey: externalClientKeys.all });
      opts.onSettled?.(...args);
    },
  };
}

export function externalClientCreateMutation(opts: MutationOpts<ExternalClientWithKey, ExternalClientInput> = {}) {
  return createMutation<ExternalClientWithKey, Error, ExternalClientInput>({
    mutationFn: (input) => api.post<ExternalClientWithKey>("/admin/external-clients", input),
    ...settle(opts),
  });
}

export function externalClientUpdateMutation(opts: MutationOpts<{ client: ExternalClient }, { id: string; patch: Partial<ExternalClientInput> }> = {}) {
  return createMutation<{ client: ExternalClient }, Error, { id: string; patch: Partial<ExternalClientInput> }>({
    mutationFn: ({ id, patch }) => api.patch<{ client: ExternalClient }>(`/admin/external-clients/${id}`, patch),
    ...settle(opts),
  });
}

export function externalClientRotateMutation(opts: MutationOpts<ExternalClientWithKey, string> = {}) {
  return createMutation<ExternalClientWithKey, Error, string>({
    mutationFn: (id) => api.post<ExternalClientWithKey>(`/admin/external-clients/${id}/rotate-key`, {}),
    ...settle(opts),
  });
}

export function externalClientDeleteMutation(opts: MutationOpts<{ ok: boolean }, string> = {}) {
  return createMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => api.delete<{ ok: boolean }>(`/admin/external-clients/${id}`),
    ...settle(opts),
  });
}
