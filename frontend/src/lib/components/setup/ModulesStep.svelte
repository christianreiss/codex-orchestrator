<script lang="ts">
  /**
   * Optional feature modules, both off by default with no row on a fresh
   * install.
   *
   * Ordered after the fleet-defaults step on purpose: both of these are read
   * through the managed feature context, which reports `config_missing` and
   * disables everything until the client-config row exists. Enabled before
   * that, the switches are inert.
   */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { fetchProjectsState, updateProjectsState, createProject } from "$lib/api/projects";
  import { secretsApi } from "$lib/api/secrets";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import StepQueryState from "./StepQueryState.svelte";

  const qc = useQueryClient();

  const projectsState = createQuery({
    queryKey: ["projects", "state"],
    queryFn: fetchProjectsState,
  });
  const secretsState = createQuery({
    queryKey: ["secrets", "state"],
    queryFn: () => secretsApi.getState(),
  });

  let projectsOn = $state(false);
  let secretsOn = $state(false);
  let slug = $state("");
  let slugError = $state<string | null>(null);
  let saving = $state(false);
  let projectsLoaded = $state(false);
  let secretsLoaded = $state(false);

  const loading = $derived($projectsState.isLoading || $secretsState.isLoading);
  const loadError = $derived($projectsState.error?.message ?? $secretsState.error?.message ?? null);

  $effect(() => {
    const value = $projectsState.data?.enabled;
    if (!projectsLoaded && typeof value === "boolean") {
      projectsOn = value;
      projectsLoaded = true;
    }
  });
  $effect(() => {
    const value = $secretsState.data?.enabled;
    if (!secretsLoaded && typeof value === "boolean") {
      secretsOn = value;
      secretsLoaded = true;
    }
  });

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return saving;
  }

  export async function persist(): Promise<boolean> {
    slugError = null;
    const wantsProject = projectsOn && slug.trim() !== "";
    if (wantsProject && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug.trim())) {
      slugError = "Letters, digits, dash and underscore; must start with a letter or digit.";
      return false;
    }

    saving = true;
    try {
      // An unloaded state is never written: "off" read from a failed query is
      // not the operator's answer.
      if (projectsLoaded && projectsOn !== ($projectsState.data?.enabled ?? false)) {
        await updateProjectsState(projectsOn);
        void qc.invalidateQueries({ queryKey: ["projects"] });
      }
      if (secretsLoaded && secretsOn !== ($secretsState.data?.enabled ?? false)) {
        await secretsApi.setState(secretsOn);
        void qc.invalidateQueries({ queryKey: ["secrets"] });
      }
      if (wantsProject && projectsLoaded) {
        await createProject({ slug: slug.trim() });
        void qc.invalidateQueries({ queryKey: ["projects"] });
        toast.success(`Project ${slug.trim()} created`);
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save module settings");
      return false;
    } finally {
      saving = false;
    }
  }
</script>

{#snippet projectNotice()}
  <div class="space-y-1.5">
    <Label for="setup-project-slug" class="text-xs">First project (optional)</Label>
    <Input
      id="setup-project-slug"
      bind:value={slug}
      placeholder="platform"
      class="max-w-xs"
      aria-invalid={slugError ? "true" : undefined}
    />
    {#if slugError}
      <p class="text-xs text-destructive">{slugError}</p>
    {:else}
      <p class="text-xs text-muted-foreground">A slug is all that is required.</p>
    {/if}
  </div>
{/snippet}

<div class="space-y-5">
  <Alert>
    <AlertTitle>Both are off until you turn them on</AlertTitle>
    <AlertDescription>
      Neither is required. They can be switched on later from their own pages, and turning
      one on here does not change anything about how agents authenticate.
    </AlertDescription>
  </Alert>

  {#if loading || loadError}
    <StepQueryState
      {loading}
      error={loadError}
      subject="module settings"
      onRetry={() => {
        void $projectsState.refetch();
        void $secretsState.refetch();
      }}
    />
  {:else}
    <div class="space-y-3">
      <ModuleSwitchRow
        id="setup-projects"
        class="rounded-lg border"
        label="Projects"
        description="Shared workstream state agents read and write over MCP — notes, todos, files and per-project memory. Adds the coordination skill to every host."
        checked={projectsOn}
        onCheckedChange={(v) => (projectsOn = v)}
        notice={projectsOn ? projectNotice : undefined}
      />
      <ModuleSwitchRow
        id="setup-secrets"
        class="rounded-lg border"
        label="Secrets"
        description="A fleet-wide credential store agents reach over MCP instead of hunting through env files. Values are encrypted at rest and never written to host disks."
        checked={secretsOn}
        onCheckedChange={(v) => (secretsOn = v)}
      />
    </div>
  {/if}
</div>
