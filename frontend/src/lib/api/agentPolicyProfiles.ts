/**
 * Agent policy profiles — named fleet security postures.
 *
 * A profile is a level vector, not a document: the canonical prose stays one
 * fleet document so a wording fix reaches every profile, while posture varies
 * per host. Assignment is orthogonal to the agents-document version pin.
 */
import { api } from "./client";

export type SecurityAxisId =
  | "autonomy"
  | "git_history"
  | "remote_hosts"
  | "deploy_release"
  | "destructive_data"
  | "secrets_exposure"
  | "security_controls"
  | "dependencies"
  | "verification_waiver";

export type SecurityLevels = Record<SecurityAxisId, number>;

/** `prose_only` is a promise the UI must keep — see the badge in the panel. */
export type AxisEnforcement = "mechanical" | "partial" | "prose_only";

export interface SecurityAxisSpec {
  id: SecurityAxisId;
  label: string;
  description: string;
  enforcement: AxisEnforcement;
  bands: string[];
}

export interface SecurityPreset {
  id: string;
  label: string;
  description: string;
  levels: SecurityLevels;
}

export interface SecurityLevelCatalog {
  axes: SecurityAxisSpec[];
  presets: SecurityPreset[];
  bands: string[];
  default_levels: SecurityLevels;
}

export interface AgentPolicyProfile {
  id: number;
  name: string;
  description: string | null;
  levels: SecurityLevels;
  is_default: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  host_ids: number[];
  /** The Claude permission mode this vector asks for, derived server-side. */
  claude_permission_mode: string;
}

export interface DerivedKnob<T> {
  value: T;
  governedBy: SecurityAxisId;
  coverage: "full" | "partial";
}

export interface DerivedEnforcement {
  codex: {
    approval_policy: DerivedKnob<string>;
    sandbox_mode: DerivedKnob<string>;
    network_access: DerivedKnob<boolean>;
    web_search: DerivedKnob<boolean>;
    guardian_approval: DerivedKnob<boolean>;
  };
  claude: { permission_mode: DerivedKnob<string> };
  not_enforced: Array<{ key: string; reason: string }>;
}

export const agentPolicyProfilesApi = {
  list(): Promise<{
    profiles: AgentPolicyProfile[];
    catalog: SecurityLevelCatalog;
    /** Hosts whose agent user is root, which a bypass posture cannot reach. */
    root_hosts: string[];
  }> {
    return api.get("/admin/agent-policy-profiles");
  },
  create(payload: { name: string; description?: string | null; levels?: SecurityLevels }): Promise<{ profile: AgentPolicyProfile }> {
    return api.post("/admin/agent-policy-profiles", payload);
  },
  update(
    id: number,
    payload: { name?: string; description?: string | null; levels?: SecurityLevels },
  ): Promise<{ profile: AgentPolicyProfile }> {
    return api.post(`/admin/agent-policy-profiles/${id}`, payload);
  },
  remove(id: number): Promise<{ deleted_id: number }> {
    return api.delete(`/admin/agent-policy-profiles/${id}`);
  },
  setDefault(id: number): Promise<{ profile: AgentPolicyProfile }> {
    return api.post(`/admin/agent-policy-profiles/${id}/default`, {});
  },
  /** `profile_id: null` clears the assignment back to the fleet default. */
  assign(hostId: number, profileId: number | null): Promise<{ host_id: number; profile_id: number | null }> {
    return api.post("/admin/agent-policy-profiles/assign", { host_id: hostId, profile_id: profileId });
  },
  enforcement(hostId: number): Promise<{ host_id: number; levels: SecurityLevels; enforcement: DerivedEnforcement }> {
    return api.get(`/admin/agent-policy-profiles/enforcement?host_id=${encodeURIComponent(String(hostId))}`);
  },
};

/** Which axes differ from a preset, for the "modified: N axes" indicator. */
export function axesModifiedFrom(preset: SecurityPreset, levels: SecurityLevels): SecurityAxisId[] {
  return (Object.keys(preset.levels) as SecurityAxisId[]).filter((id) => preset.levels[id] !== levels[id]);
}

export function matchingPreset(
  presets: SecurityPreset[],
  levels: SecurityLevels,
): SecurityPreset | null {
  return presets.find((p) => axesModifiedFrom(p, levels).length === 0) ?? null;
}
