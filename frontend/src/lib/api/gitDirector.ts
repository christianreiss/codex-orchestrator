import {
  createMutation,
  createQuery,
  useQueryClient,
  type CreateMutationOptions,
} from "@tanstack/svelte-query";
import { api } from "./client";

export type GitVerdict = "allow" | "wait" | "deny" | "expired" | "withdrawn";
export type GitDecidedBy = "policy" | "llm" | "operator";

export interface GitDirectorState {
  enabled: boolean;
  model: string;
  clones: number;
  worktrees: number;
  updated_at: string | null;
}

export interface GitWorktreeRow {
  worktree_id: string;
  worktree_path: string;
  username: string;
  engine: string | null;
  branch: string | null;
  head_sha: string | null;
  task: string | null;
  declared_paths: string[];
  target_branch: string | null;
  /** True when Agent Messaging supplied a live address for this worktree. */
  agent_address_bound: boolean;
  heartbeat_at: string;
  expires_at: string;
}

export interface GitLeaseRow {
  request_id: string;
  worktree_id: string;
  target_branch: string;
  verdict: GitVerdict;
  decided_by: GitDecidedBy;
  reason: string | null;
  overlap: string[];
  lease_expires_at: string | null;
  requested_at: string;
}

export interface GitRequestRow extends GitLeaseRow {
  model: string | null;
  completed_at: string | null;
}

export interface GitStaleWorktreeRow {
  worktree_id: string;
  worktree_path: string;
  username: string;
  engine: string | null;
  branch: string | null;
  task: string | null;
  /** `abandoned` = the fleet saw its session end. `expired` = it just went quiet. */
  status: "expired" | "abandoned";
  last_seen_at: string;
  released_at: string | null;
}

export interface GitCloneRow {
  clone_id: string;
  host_id: number;
  fqdn: string | null;
  repo_root: string;
  remote_url: string | null;
  remote_key: string | null;
  last_seen_at: string;
  worktrees: GitWorktreeRow[];
  leases: GitLeaseRow[];
  stale: GitStaleWorktreeRow[];
  recent: GitRequestRow[];
}

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

export const gitDirectorKeys = {
  all: ["git-director"] as const,
  state: ["git-director", "state"] as const,
  clones: ["git-director", "clones"] as const,
};

export function gitDirectorStateQuery() {
  return createQuery<GitDirectorState>({
    queryKey: gitDirectorKeys.state,
    queryFn: () => api.get<GitDirectorState>("/admin/git-director/state"),
  });
}

export function gitDirectorClonesQuery() {
  return createQuery<{ clones: GitCloneRow[] }>({
    queryKey: gitDirectorKeys.clones,
    queryFn: () => api.get<{ clones: GitCloneRow[] }>("/admin/git-director"),
  });
}

function invalidateAll() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: gitDirectorKeys.all });
}

export function gitDirectorStateMutation(opts: MutationOpts<GitDirectorState, boolean> = {}) {
  const invalidate = invalidateAll();
  return createMutation<GitDirectorState, Error, boolean>({
    mutationFn: (enabled) => api.post<GitDirectorState>("/admin/git-director/state", { enabled }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function gitDirectorEvictMutation(opts: MutationOpts<unknown, string> = {}) {
  const invalidate = invalidateAll();
  return createMutation<unknown, Error, string>({
    mutationFn: (id) => api.post(`/admin/git-director/worktrees/${id}/release`),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function gitDirectorDecideMutation(
  opts: MutationOpts<GitRequestRow, { id: string; verdict: "allow" | "deny"; reason?: string }> = {},
) {
  const invalidate = invalidateAll();
  return createMutation<GitRequestRow, Error, { id: string; verdict: "allow" | "deny"; reason?: string }>({
    mutationFn: ({ id, verdict, reason }) =>
      api.post<GitRequestRow>(`/admin/git-director/requests/${id}/decide`, { verdict, reason }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}
