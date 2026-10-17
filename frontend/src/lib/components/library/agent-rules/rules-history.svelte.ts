/**
 * Publishing and history for the Agent rules document: which stored version
 * hosts are handed (serve mode), how many backups are kept, and previewing or
 * restoring an old version. None of it changes the draft, so none of it moves
 * the live preview.
 */
import { fromStore } from "svelte/store";
import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";
import { agentsApi } from "$lib/api/agents";
import { ApiError } from "$lib/api/client";
import type { AgentsVersion, AgentsVersionMeta } from "$lib/api/types";
import type { RulesDocState } from "./rules-doc.svelte";

export class RulesHistoryState {
  private doc!: RulesDocState;
  private qc = useQueryClient();

  serveMode = $state<"latest" | "locked">("latest");
  serveLockedId = $state<number | null>(null);
  private serveHydrated = false;
  retentionInput = $state<number>(20);
  private retentionHydrated = false;
  viewingVersion = $state<AgentsVersion | null>(null);

  versions = $derived<AgentsVersionMeta[]>(this.doc.data?.versions ?? []);
  currentVersionId = $derived(this.doc.data?.served_id ?? this.doc.data?.active_id ?? null);

  private serveStore = fromStore(
    createMutation({
      mutationFn: (payload: { mode: "latest" | "locked"; version_id?: number | null }) => agentsApi.serve(payload),
      onSuccess: () => {
        toast.success("Serve mode updated");
        void this.qc.invalidateQueries({ queryKey: ["agents"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to update serve mode"),
    }),
  );

  private retentionStore = fromStore(
    createMutation({
      mutationFn: () => agentsApi.retention({ backup_limit: this.retentionInput }),
      onSuccess: () => {
        toast.success("Retention updated");
        void this.qc.invalidateQueries({ queryKey: ["agents"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to update retention"),
    }),
  );

  private versionStore = fromStore(
    createMutation({
      mutationFn: (id: number) => agentsApi.getVersion(id),
      onSuccess: (data) => (this.viewingVersion = data),
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to load version"),
    }),
  );

  private revertStore = fromStore(
    createMutation({
      mutationFn: (id: number) => agentsApi.revert({ version_id: id }),
      onSuccess: (result) => {
        // Hydrate from the mutation's own result rather than waiting on the
        // invalidated query: that refetch is async, so the re-hydration effect
        // could fire first against stale cached data and leave the editor
        // showing pre-restore content while the version list looks correct.
        this.doc.content = result.content ?? "";
        this.doc.serverSha = result.sha256 ?? null;
        // The mode is fleet state, not document state: restoring an old version
        // restores its prose, never a mode the operator did not ask for.
        this.doc.hydrateBuilder(result);
        this.doc.hydrated = true;
        toast.success("Restored version");
        this.viewingVersion = null;
        void this.qc.invalidateQueries({ queryKey: ["agents"] });
      },
      onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to restore"),
    }),
  );

  get serving() {
    return this.serveStore.current.isPending;
  }
  get savingRetention() {
    return this.retentionStore.current.isPending;
  }
  get loadingVersion() {
    return this.versionStore.current.isPending;
  }
  get reverting() {
    return this.revertStore.current.isPending;
  }

  constructor(doc: RulesDocState) {
    this.doc = doc;
    $effect(() => {
      const data = this.doc.data;
      if (!this.serveHydrated && (data?.mode === "latest" || data?.mode === "locked")) {
        this.serveMode = data.mode;
        this.serveLockedId = data.served_id ?? data.active_id ?? null;
        this.serveHydrated = true;
      }
    });
    $effect(() => {
      const limit = this.doc.data?.backup_limit;
      if (typeof limit === "number" && !this.retentionHydrated) {
        this.retentionInput = limit;
        this.retentionHydrated = true;
      }
    });
  }

  applyServeMode() {
    if (this.serveMode === "locked" && (!this.serveLockedId || this.serveLockedId <= 0)) {
      toast.error("Pick a version to lock to");
      return;
    }
    this.serveStore.current.mutate({
      mode: this.serveMode,
      version_id: this.serveMode === "locked" ? this.serveLockedId : null,
    });
  }
  saveRetention() {
    this.retentionStore.current.mutate();
  }
  loadVersion(id: number) {
    this.versionStore.current.mutate(id);
  }
  closeVersion() {
    this.viewingVersion = null;
  }
  makeVersionCurrent() {
    if (this.viewingVersion) this.revertStore.current.mutate(this.viewingVersion.id);
  }
}
