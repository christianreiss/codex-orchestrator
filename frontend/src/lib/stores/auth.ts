/**
 * Auth store. Hydrates from `window.__adminBootstrap` (injected by the PHP
 * gateway) and falls back to `GET /admin/auth/status`. Exposes a readable
 * `authStore` and an `authActions` API.
 */
import { writable, type Readable } from "svelte/store";
import { browser } from "$app/environment";
import { api, ApiError } from "../api/client";
import type { AdminBootstrap, AuthStatus, User } from "../api/types";

export interface AuthState {
  authenticated: boolean;
  enforced: boolean;
  user: User | null;
  roles: string[];
  loading: boolean;
}

const initial: AuthState = {
  authenticated: false,
  enforced: false,
  user: null,
  roles: [],
  loading: true,
};

const store = writable<AuthState>(initial);

function applyBootstrap(b: AdminBootstrap | undefined): AuthState | null {
  if (!b || typeof b !== "object") return null;
  const next: AuthState = {
    authenticated: Boolean(b.authenticated),
    enforced: Boolean(b.enforced),
    user: b.user ?? null,
    roles: extractRoles(b.user),
    loading: false,
  };
  store.set(next);
  return next;
}

function extractRoles(user: User | null | undefined): string[] {
  if (!user) return [];
  if (Array.isArray(user.roles)) return user.roles;
  if (typeof user.role === "string") return [user.role];
  return [];
}

async function refresh(): Promise<AuthState> {
  store.update((s) => ({ ...s, loading: true }));
  try {
    const status = await api.get<AuthStatus>("/admin/auth/status");
    const next: AuthState = {
      authenticated: Boolean(status.authenticated),
      enforced: Boolean(status.enforced),
      user: status.user ?? null,
      roles: status.roles ?? extractRoles(status.user),
      loading: false,
    };
    store.set(next);
    return next;
  } catch (err) {
    // If the endpoint is 401/403, treat as unauthenticated.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      const next: AuthState = {
        authenticated: false,
        enforced: true,
        user: null,
        roles: [],
        loading: false,
      };
      store.set(next);
      return next;
    }
    store.update((s) => ({ ...s, loading: false }));
    throw err;
  }
}

if (browser) {
  const applied = applyBootstrap(window.__adminBootstrap);
  if (!applied) {
    // No bootstrap injected — fall back to API status.
    void refresh().catch(() => {
      store.update((s) => ({ ...s, loading: false }));
    });
  }
}

export const authStore: Readable<AuthState> = { subscribe: store.subscribe };

export const authActions = {
  /**
   * Submit login credentials to the admin auth endpoint. The backend
   * sets the session cookie; we just refresh local state on success.
   */
  async login(payload: { username: string; password?: string; method?: string }): Promise<AuthState> {
    await api.post("/admin/auth/login", payload);
    return refresh();
  },

  async logout(): Promise<AuthState> {
    try {
      await api.post("/admin/auth/logout");
    } catch {
      /* ignore — we still want to reset local state */
    }
    return refresh();
  },

  refresh,
  applyBootstrap,
};
