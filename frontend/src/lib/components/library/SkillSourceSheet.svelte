<script lang="ts">
  /**
   * Import skills from a curated upstream repository (Matt Pocock's skills).
   * Secondary action on the Skills list: opted in per fleet, optionally
   * auto-updating, and always flagged as an external instruction supply chain.
   */
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import {
    MATTPOCOCK_REPOSITORY,
    mattPocockSkillsApi,
    mattPocockSkillsKeys,
    type SkillSourceState,
    type SkillSourceUpdate,
  } from "$lib/api/skillSources";
  import { authStore } from "$lib/stores/auth";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { relativeTime } from "$lib/utils/format";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import * as Sheet from "$lib/components/ui/sheet";

  let { open = $bindable() }: { open: boolean } = $props();

  const qc = useQueryClient();
  const query = createQuery(
    reactiveOptions(() => ({
      queryKey: mattPocockSkillsKeys.source(),
      queryFn: () => mattPocockSkillsApi.get(),
      enabled: open,
    })),
  );

  function acceptState(next: SkillSourceState) {
    qc.setQueryData(mattPocockSkillsKeys.source(), next);
    void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.all });
  }

  const updateMutation = createMutation({
    mutationFn: (payload: SkillSourceUpdate) => mattPocockSkillsApi.update(payload),
    onSuccess: (next) => {
      acceptState(next);
      toast.success("Skill source settings updated");
    },
    onError: (error: unknown) => {
      void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.source() });
      toast.error(error instanceof Error ? error.message : "Failed to update skill source");
    },
  });

  const refreshMutation = createMutation({
    mutationFn: () => mattPocockSkillsApi.refresh(),
    onSuccess: (next) => {
      acceptState(next);
      toast.success(`Skill source checked · ${next.skill_count} skills`);
    },
    onError: (error: unknown) => {
      void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.source() });
      toast.error(error instanceof Error ? error.message : "Failed to check skill source");
    },
  });

  const state = $derived($query.data);
  const canMutate = $derived($authStore.authenticated && $authStore.can("content.manage"));
  const busy = $derived($query.isLoading || $query.isFetching || $updateMutation.isPending || $refreshMutation.isPending);

  function statusVariant(status: string | undefined) {
    switch (status?.toLowerCase()) {
      case "ok": case "ready": case "synced": case "current": return "success" as const;
      case "error": case "failed": return "destructive" as const;
      case "checking": case "syncing": case "updating": return "warning" as const;
      default: return "secondary" as const;
    }
  }

  const shortRevision = (revision: string | null | undefined) =>
    !revision ? "—" : revision.length > 12 ? `${revision.slice(0, 12)}…` : revision;

  const details = $derived<Array<{ label: string; value: string; title?: string; mono?: boolean }>>([
    { label: "Upstream version", value: state?.upstream_version ?? "—", mono: true },
    { label: "Ref", value: state?.ref ?? "—", mono: true },
    { label: "Revision", value: shortRevision(state?.revision), title: state?.revision ?? undefined, mono: true },
    { label: "Imported", value: state ? `${state.skill_count} skills · ${state.file_count} files` : "—" },
    { label: "Last checked", value: state?.last_checked_at ? relativeTime(state.last_checked_at) : "—", title: state?.last_checked_at ?? undefined },
    { label: "Last synced", value: state?.last_synced_at ? relativeTime(state.last_synced_at) : "—", title: state?.last_synced_at ?? undefined },
  ]);
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
    <Sheet.Header>
      <Sheet.Title class="flex flex-wrap items-center gap-2">
        Import skills from a repository
        {#if state}<Badge variant={statusVariant(state.status)}>{state.status || "unknown"}</Badge>{/if}
        {#if state && !canMutate}<Badge variant="secondary">Read-only</Badge>{/if}
      </Sheet.Title>
      <Sheet.Description>
        Matt Pocock's curated skills. Opt this collection into the fleet skill library.
      </Sheet.Description>
    </Sheet.Header>

    <Alert.Root variant="warning">
      <ShieldAlert class="h-4 w-4" />
      <Alert.Title>External instruction supply chain</Alert.Title>
      <Alert.Description>
        Enabling this source distributes upstream-authored instructions and supporting files to the fleet.
        Auto-update lets later upstream changes flow in automatically.
        <a href={MATTPOCOCK_REPOSITORY} target="_blank" rel="noreferrer" class="ml-1 inline-flex items-center gap-1 font-medium underline underline-offset-2">
          Review repository
          <ExternalLink class="h-3 w-3" />
        </a>
      </Alert.Description>
    </Alert.Root>

    {#if $query.isError}
      <Alert.Root variant="destructive">
        <Alert.Title>Could not load source state</Alert.Title>
        <Alert.Description>
          {$query.error instanceof Error ? $query.error.message : "The source API request failed."}
          <button type="button" class="ml-1 font-medium underline underline-offset-2" onclick={() => void $query.refetch()}>Retry</button>
        </Alert.Description>
      </Alert.Root>
    {/if}
    {#if state && !canMutate}
      <p class="text-body-sm text-muted-foreground">Owner or admin access is required to change or refresh this source.</p>
    {/if}

    <div class="divide-y rounded-md border">
      <div class="flex items-center justify-between gap-4 p-3">
        <div>
          <Label for="mattpocock-skills-enabled">Include in fleet</Label>
          <p class="text-body-sm text-muted-foreground">Import and publish the upstream collection through the existing skill sync.</p>
        </div>
        <Switch
          id="mattpocock-skills-enabled"
          checked={state?.enabled ?? false}
          disabled={busy || !state || !canMutate}
          onCheckedChange={(enabled) => $updateMutation.mutate({ enabled: Boolean(enabled) })}
        />
      </div>
      <div class="flex items-center justify-between gap-4 p-3">
        <div>
          <Label for="mattpocock-skills-auto-update">Auto-update</Label>
          <p class="text-body-sm text-muted-foreground">Periodically adopt the latest validated upstream revision.</p>
        </div>
        <Switch
          id="mattpocock-skills-auto-update"
          checked={state?.auto_update ?? false}
          disabled={busy || !state || !canMutate}
          onCheckedChange={(auto_update) => $updateMutation.mutate({ auto_update: Boolean(auto_update) })}
        />
      </div>
    </div>

    <dl class="grid gap-x-4 gap-y-2 text-body-sm sm:grid-cols-2">
      {#each details as item (item.label)}
        <div>
          <dt class="text-muted-foreground">{item.label}</dt>
          <dd class={item.mono ? "font-mono" : undefined} title={item.title}>{item.value}</dd>
        </div>
      {/each}
      <div class="sm:col-span-2">
        <dt class="text-muted-foreground">Repository</dt>
        <dd class="truncate font-mono" title={state?.repository ?? MATTPOCOCK_REPOSITORY}>{state?.repository ?? MATTPOCOCK_REPOSITORY}</dd>
      </div>
    </dl>

    {#if state?.last_error}
      <Alert.Root variant="destructive">
        <Alert.Title>Last source update failed</Alert.Title>
        <Alert.Description>{state.last_error}</Alert.Description>
      </Alert.Root>
    {/if}

    <Sheet.Footer class="mt-auto">
      <Button variant="outline" onclick={() => $refreshMutation.mutate()} disabled={busy || !state?.enabled || !canMutate}>
        <RefreshCw class={$refreshMutation.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        Check now
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
