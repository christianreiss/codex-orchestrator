/**
 * Fleet security posture and response verbosity. Both are stored apart from the
 * document (posture per profile, verbosity fleet-wide), so each has its own
 * draft, its own dirty flag and its own save.
 */
import { fromStore } from "svelte/store";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";
import { responseVerbosityApi, type ResponseVerbosityLevelOption } from "$lib/api/agents";
import { ApiError } from "$lib/api/client";
import {
  agentPolicyProfilesApi,
  type AgentPolicyProfile,
  type SecurityLevelCatalog,
  type SecurityLevels,
} from "$lib/api/agentPolicyProfiles";

export class RulesPostureState {
  private qc = useQueryClient();
  private profilesStore = fromStore(createQuery({ queryKey: ["agent-policy-profiles"], queryFn: () => agentPolicyProfilesApi.list() }));
  private verbosityStore = fromStore(createQuery({ queryKey: ["response-verbosity"], queryFn: () => responseVerbosityApi.get() }));

  securityCatalog = $state<SecurityLevelCatalog | null>(null);
  defaultProfile = $state<AgentPolicyProfile | null>(null);
  draftLevels = $state<SecurityLevels | null>(null);
  private levelsHydrated = false;

  savedVerbosity = $state<number | null>(null);
  draftVerbosity = $state<number>(0);
  verbosityLevelOptions = $state<ResponseVerbosityLevelOption[]>([]);
  private verbosityHydrated = false;

  levelsDirty = $derived(
    this.draftLevels !== null &&
      this.defaultProfile !== null &&
      JSON.stringify(this.draftLevels) !== JSON.stringify(this.defaultProfile.levels),
  );
  verbosityDirty = $derived(this.savedVerbosity !== null && this.draftVerbosity !== this.savedVerbosity);

  /**
   * Claude Code refuses to start as root in bypassPermissions, so those hosts
   * are served `auto`. Derived from the SAVED profile, not the slider: it
   * describes what hosts are served right now, not a draft.
   */
  rootClampWarning = $derived.by(() => {
    const rootHosts = this.profilesStore.current.data?.root_hosts ?? [];
    if (!this.defaultProfile || this.defaultProfile.claude_permission_mode !== "bypassPermissions") return null;
    if (rootHosts.length === 0) return null;
    const named = rootHosts.slice(0, 3).join(", ");
    const rest = rootHosts.length > 3 ? ` and ${rootHosts.length - 3} more` : "";
    return `${rootHosts.length} host${rootHosts.length === 1 ? "" : "s"} run their agent as root (${named}${rest}). Claude Code refuses to start as root in bypassPermissions, so those hosts are served "auto" instead — reads and edits are auto-approved and everything else is vetted by a classifier. Run the agent as a non-root user to get the full bypass.`;
  });

  private saveLevelsStore = fromStore(
    createMutation({
      mutationFn: () => {
        if (!this.defaultProfile || !this.draftLevels) throw new Error("No fleet default profile to update");
        return agentPolicyProfilesApi.update(this.defaultProfile.id, { levels: this.draftLevels });
      },
      onSuccess: (result) => {
        this.defaultProfile = result.profile;
        this.draftLevels = { ...result.profile.levels };
        toast.success("Fleet posture saved");
        void this.qc.invalidateQueries({ queryKey: ["agent-policy-profiles"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to save posture"),
    }),
  );

  private saveVerbosityStore = fromStore(
    createMutation({
      mutationFn: () => responseVerbosityApi.set(this.draftVerbosity),
      onSuccess: (result) => {
        this.savedVerbosity = result.level;
        this.draftVerbosity = result.level;
        toast.success("Response verbosity saved");
        void this.qc.invalidateQueries({ queryKey: ["response-verbosity"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to save response verbosity"),
    }),
  );

  get savingLevels() {
    return this.saveLevelsStore.current.isPending;
  }
  get savingVerbosity() {
    return this.saveVerbosityStore.current.isPending;
  }
  saveLevels() {
    this.saveLevelsStore.current.mutate();
  }
  saveVerbosity() {
    this.saveVerbosityStore.current.mutate();
  }

  constructor() {
    $effect(() => {
      const data = this.profilesStore.current.data;
      if (!data || this.levelsHydrated) return;
      this.securityCatalog = data.catalog;
      this.defaultProfile = data.profiles.find((profile) => profile.is_default) ?? null;
      this.draftLevels = { ...(this.defaultProfile?.levels ?? data.catalog.default_levels) };
      this.levelsHydrated = true;
    });

    $effect(() => {
      const data = this.verbosityStore.current.data;
      if (!data || this.verbosityHydrated) return;
      this.savedVerbosity = data.level;
      this.draftVerbosity = data.level;
      this.verbosityLevelOptions = data.levels ?? [];
      this.verbosityHydrated = true;
    });
  }
}
