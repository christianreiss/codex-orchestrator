/**
 * Users feature — typed query/mutation builders for `/admin/users*` and
 * `/admin/auth/status` (used to discover the available role list).
 *
 * Phase 2 — webui-rewrite/users.
 */
import {
  createQuery,
  createMutation,
  useQueryClient,
  type CreateQueryResult,
  type CreateMutationResult,
} from "@tanstack/svelte-query";
import { api } from "./client";
import type {
  AdminAuthStatusResponse,
  AdminUser,
  AdminUserListResponse,
  AdminUserPayload,
  AdminUserResponse,
} from "./types";

export const USERS_QUERY_KEY = ["users"] as const;
export const AUTH_STATUS_QUERY_KEY = ["auth", "status"] as const;

export async function listUsers(): Promise<AdminUser[]> {
  const data = await api.get<AdminUserListResponse>("/admin/users");
  return data?.users ?? [];
}

export async function fetchAuthStatus(): Promise<AdminAuthStatusResponse> {
  return await api.get<AdminAuthStatusResponse>("/admin/auth/status");
}

export async function createUser(payload: AdminUserPayload): Promise<AdminUser> {
  const data = await api.post<AdminUserResponse>("/admin/users", payload);
  return data.user;
}

export async function updateUser(id: number | string, payload: Partial<AdminUserPayload>): Promise<AdminUser> {
  const data = await api.post<AdminUserResponse>(`/admin/users/${id}`, payload);
  return data.user;
}

export async function deleteUser(id: number | string): Promise<void> {
  await api.delete(`/admin/users/${id}`);
}

export async function wipeAllUsers(): Promise<void> {
  await api.post("/admin/users/wipe", { confirm: "WIPE" });
}

/** svelte-query wrappers. Components import these and never the raw fns. */

export function createUsersQuery(): CreateQueryResult<AdminUser[], Error> {
  return createQuery<AdminUser[], Error>({
    queryKey: USERS_QUERY_KEY,
    queryFn: listUsers,
  });
}

export function createAuthStatusQuery(): CreateQueryResult<AdminAuthStatusResponse, Error> {
  return createQuery<AdminAuthStatusResponse, Error>({
    queryKey: AUTH_STATUS_QUERY_KEY,
    queryFn: fetchAuthStatus,
    staleTime: 5 * 60_000,
  });
}

export function createUserCreateMutation(): CreateMutationResult<AdminUser, Error, AdminUserPayload, unknown> {
  const qc = useQueryClient();
  return createMutation<AdminUser, Error, AdminUserPayload>({
    mutationFn: createUser,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
  });
}

export interface UpdateUserVars {
  id: number | string;
  patch: Partial<AdminUserPayload>;
}

export function createUserUpdateMutation(): CreateMutationResult<
  AdminUser,
  Error,
  UpdateUserVars,
  { previous?: AdminUser[] }
> {
  const qc = useQueryClient();
  return createMutation<AdminUser, Error, UpdateUserVars, { previous?: AdminUser[] }>({
    mutationFn: ({ id, patch }) => updateUser(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: USERS_QUERY_KEY });
      const previous = qc.getQueryData<AdminUser[]>(USERS_QUERY_KEY);
      if (previous) {
        qc.setQueryData<AdminUser[]>(
          USERS_QUERY_KEY,
          previous.map((u) => (String(u.id) === String(id) ? { ...u, ...patch } : u)),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(USERS_QUERY_KEY, ctx.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
  });
}

export function createUserDeleteMutation(): CreateMutationResult<
  void,
  Error,
  number | string,
  { previous?: AdminUser[] }
> {
  const qc = useQueryClient();
  return createMutation<void, Error, number | string, { previous?: AdminUser[] }>({
    mutationFn: deleteUser,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: USERS_QUERY_KEY });
      const previous = qc.getQueryData<AdminUser[]>(USERS_QUERY_KEY);
      if (previous) {
        qc.setQueryData<AdminUser[]>(
          USERS_QUERY_KEY,
          previous.filter((u) => String(u.id) !== String(id)),
        );
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(USERS_QUERY_KEY, ctx.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
  });
}

export function createWipeUsersMutation(): CreateMutationResult<void, Error, void, unknown> {
  const qc = useQueryClient();
  return createMutation<void, Error, void>({
    mutationFn: wipeAllUsers,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
  });
}
