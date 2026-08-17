/**
 * Auth store. Hydrates from `GET /admin/auth/status`. Exposes a readable
 * `authStore` and an `authActions` API.
 */
import { writable, type Readable } from "svelte/store";
import { browser } from "$app/environment";
import { api, ApiError } from "../api/client";
import type { AuthStatus, User } from "../api/types";
import { capabilityChecker, type Capability } from "../auth/capabilities";

export interface AuthState {
  authenticated: boolean;
  enforced: boolean;
  user: User | null;
  roles: string[];
  /** Capability names the server reported for this session. */
  capabilities: string[];
  /**
   * Whether the signed-in operator holds a capability. Presentation only —
   * the server re-checks every request and answers 403 regardless of what
   * this says.
   */
  can: (capability: Capability) => boolean;
  loading: boolean;
  unreachable: string | null;
}

const initial: AuthState = {
  authenticated: false,
  enforced: false,
  user: null,
  roles: [],
  capabilities: [],
  can: capabilityChecker([]),
  loading: true,
  unreachable: null,
};

const store = writable<AuthState>(initial);

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
    const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
    const next: AuthState = {
      authenticated: Boolean(status.authenticated),
      enforced: Boolean(status.enforced),
      user: status.user ?? null,
      roles: status.roles ?? extractRoles(status.user),
      capabilities,
      can: capabilityChecker(capabilities),
      loading: false,
      unreachable: null,
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
        capabilities: [],
        can: capabilityChecker([]),
        loading: false,
        unreachable: null,
      };
      store.set(next);
      return next;
    }
    store.update((s) => ({
      ...s,
      loading: false,
      unreachable: err instanceof Error ? err.message : "API unreachable",
    }));
    throw err;
  }
}

if (browser) {
  void refresh().catch(() => {
    store.update((s) => ({ ...s, loading: false }));
  });
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
};
