/**
 * External Skill source subscriptions.
 *
 * Matt Pocock's public collection is the first source. Keeping its routes and
 * query keys here leaves the Authoring page concerned with presentation rather
 * than spelling admin API paths by hand.
 */
import { api } from "./client";

const MATTPOCOCK_PATH = "/admin/skill-sources/mattpocock";

export const MATTPOCOCK_REPOSITORY = "https://github.com/mattpocock/skills";

export interface SkillSourceState {
  source: string;
  repository: string;
  ref: string;
  enabled: boolean;
  auto_update: boolean;
  status: string;
  revision: string | null;
  upstream_version: string | null;
  skill_count: number;
  file_count: number;
  last_checked_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface SkillSourceUpdate {
  enabled?: boolean;
  auto_update?: boolean;
}

export function canManageMattPocockSkillsSource(
  roles: readonly string[],
  accessLevel?: string | null,
): boolean {
  const normalized = [...roles, accessLevel ?? ""]
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  return normalized.includes("owner") || normalized.includes("admin");
}

export const mattPocockSkillsApi = {
  get(): Promise<SkillSourceState> {
    return api.get<SkillSourceState>(MATTPOCOCK_PATH);
  },
  update(payload: SkillSourceUpdate): Promise<SkillSourceState> {
    return api.post<SkillSourceState>(MATTPOCOCK_PATH, payload);
  },
  refresh(): Promise<SkillSourceState> {
    return api.post<SkillSourceState>(`${MATTPOCOCK_PATH}/refresh`);
  },
};

/** Rooted under `skills` so existing skill WS events refresh source state too. */
export const mattPocockSkillsKeys = {
  all: ["skills"] as const,
  source: () => ["skills", "source", "mattpocock"] as const,
};
