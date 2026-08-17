<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import {
    MATTPOCOCK_REPOSITORY,
    mattPocockSkillsApi,
    mattPocockSkillsKeys,
    type SkillSourceState,
    type SkillSourceUpdate,
  } from "$lib/api/skillSources";
  import { authStore } from "$lib/stores/auth";
  import { relativeTime } from "$lib/utils/format";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";

  const qc = useQueryClient();

  const query = createQuery({
    queryKey: mattPocockSkillsKeys.source(),
    queryFn: () => mattPocockSkillsApi.get(),
  });

  function acceptState(state: SkillSourceState) {
    qc.setQueryData(mattPocockSkillsKeys.source(), state);
    void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.all });
  }

  const updateMutation = createMutation({
    mutationFn: (payload: SkillSourceUpdate) => mattPocockSkillsApi.update(payload),
    onSuccess: (state) => {
      acceptState(state);
      toast.success("Skill source settings updated");
    },
    onError: (error: unknown) => {
      void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.source() });
      toast.error(error instanceof Error ? error.message : "Failed to update skill source");
    },
  });

  const refreshMutation = createMutation({
    mutationFn: () => mattPocockSkillsApi.refresh(),
    onSuccess: (state) => {
      acceptState(state);
      toast.success(`Skill source checked · ${state.skill_count} skills`);
    },
    onError: (error: unknown) => {
      void qc.invalidateQueries({ queryKey: mattPocockSkillsKeys.source() });
      toast.error(error instanceof Error ? error.message : "Failed to check skill source");
    },
  });

  const state = $derived($query.data);
  const canMutate = $derived($authStore.authenticated && $authStore.can("content.manage"));
  const busy = $derived(
    $query.isLoading || $query.isFetching || $updateMutation.isPending || $refreshMutation.isPending,
  );

  function statusVariant(status: string | undefined) {
    switch (status?.toLowerCase()) {
      case "ok":
      case "ready":
      case "synced":
      case "current":
        return "success" as const;
      case "error":
      case "failed":
        return "destructive" as const;
      case "checking":
      case "syncing":
      case "updating":
        return "warning" as const;
      default:
        return "secondary" as const;
    }
  }

  function shortRevision(revision: string | null | undefined): string {
    if (!revision) return "—";
    return revision.length > 12 ? `${revision.slice(0, 12)}…` : revision;
  }
</script>

<Card.Root class="mb-4 overflow-hidden">
  <Card.Header class="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
    <div class="space-y-1.5">
      <div class="flex flex-wrap items-center gap-2">
        <Card.Title>Matt Pocock’s skills</Card.Title>
        {#if state}
          <Badge variant={statusVariant(state.status)}>{state.status || "unknown"}</Badge>
          {#if !canMutate}<Badge variant="secondary">Read-only</Badge>{/if}
        {/if}
      </div>
      <Card.Description>
        Opt this curated upstream collection into the canonical fleet skill library.
      </Card.Description>
    </div>
    <Button
      variant="outline"
      size="sm"
      onclick={() => $refreshMutation.mutate()}
      disabled={busy || !state?.enabled || !canMutate}
    >
      <RefreshCw class={$refreshMutation.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      Check now
    </Button>
  </Card.Header>

  <Card.Content class="space-y-4">
    <Alert.Root variant="warning">
      <ShieldAlert class="h-4 w-4" />
      <Alert.Title>External instruction supply chain</Alert.Title>
      <Alert.Description>
        Enabling this source distributes upstream-authored instructions and supporting files to the
        fleet. Auto-update allows later upstream changes to flow in automatically.
        <a
          href={MATTPOCOCK_REPOSITORY}
          target="_blank"
          rel="noreferrer"
          class="ml-1 inline-flex items-center gap-1 font-medium underline underline-offset-2"
        >
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
          <button
            type="button"
            class="ml-1 font-medium underline underline-offset-2"
            onclick={() => void $query.refetch()}
          >
            Retry
          </button>
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if state && !canMutate}
      <p class="text-xs text-muted-foreground">
        Owner or admin access is required to change or refresh this source.
      </p>
    {/if}

    <div class="grid gap-3 md:grid-cols-2">
      <div class="flex items-center justify-between gap-4 rounded-lg border bg-muted/15 p-4">
        <div class="space-y-1">
          <Label for="mattpocock-skills-enabled">Include in fleet</Label>
          <p class="text-xs leading-relaxed text-muted-foreground">
            Import and publish the upstream collection through the existing skill sync.
          </p>
        </div>
        <Switch
          id="mattpocock-skills-enabled"
          checked={state?.enabled ?? false}
          disabled={busy || !state || !canMutate}
          onCheckedChange={(enabled) => $updateMutation.mutate({ enabled: Boolean(enabled) })}
        />
      </div>

      <div class="flex items-center justify-between gap-4 rounded-lg border bg-muted/15 p-4">
        <div class="space-y-1">
          <Label for="mattpocock-skills-auto-update">Auto-update</Label>
          <p class="text-xs leading-relaxed text-muted-foreground">
            Periodically adopt the latest validated upstream revision.
          </p>
        </div>
        <Switch
          id="mattpocock-skills-auto-update"
          checked={state?.auto_update ?? false}
          disabled={busy || !state || !canMutate}
          onCheckedChange={(auto_update) =>
            $updateMutation.mutate({ auto_update: Boolean(auto_update) })}
        />
      </div>
    </div>

    <dl class="grid gap-3 rounded-lg border bg-muted/15 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <dt class="text-muted-foreground">Upstream version</dt>
        <dd class="font-mono">{state?.upstream_version ?? "—"}</dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Ref</dt>
        <dd class="font-mono">{state?.ref ?? "—"}</dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Revision</dt>
        <dd class="font-mono" title={state?.revision ?? undefined}>
          {shortRevision(state?.revision)}
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Imported</dt>
        <dd>{state ? `${state.skill_count} skills · ${state.file_count} files` : "—"}</dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Last checked</dt>
        <dd title={state?.last_checked_at ?? undefined}>
          {state?.last_checked_at ? relativeTime(state.last_checked_at) : "—"}
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Last synced</dt>
        <dd title={state?.last_synced_at ?? undefined}>
          {state?.last_synced_at ? relativeTime(state.last_synced_at) : "—"}
        </dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-muted-foreground">Repository</dt>
        <dd class="truncate font-mono" title={state?.repository ?? MATTPOCOCK_REPOSITORY}>
          {state?.repository ?? MATTPOCOCK_REPOSITORY}
        </dd>
      </div>
    </dl>

    {#if state?.last_error}
      <Alert.Root variant="destructive">
        <Alert.Title>Last source update failed</Alert.Title>
        <Alert.Description>{state.last_error}</Alert.Description>
      </Alert.Root>
    {/if}
  </Card.Content>
</Card.Root>
