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
  import { Switch } from "$lib/components/ui/switch";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { fetchProjectsState, updateProjectsState, createProject } from "$lib/api/projects";
  import { secretsApi } from "$lib/api/secrets";

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
  let projectsLoaded = false;
  let secretsLoaded = false;

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
      if (projectsOn !== ($projectsState.data?.enabled ?? false)) {
        await updateProjectsState(projectsOn);
        void qc.invalidateQueries({ queryKey: ["projects"] });
      }
      if (secretsOn !== ($secretsState.data?.enabled ?? false)) {
        await secretsApi.setState(secretsOn);
        void qc.invalidateQueries({ queryKey: ["secrets"] });
      }
      if (wantsProject) {
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

<div class="space-y-5">
  <Alert>
    <AlertTitle>Both are off until you turn them on</AlertTitle>
    <AlertDescription>
      Neither is required. They can be switched on later from their own pages, and turning
      one on here does not change anything about how agents authenticate.
    </AlertDescription>
  </Alert>

  <div class="flex items-start justify-between gap-4 rounded-lg border p-4">
    <div class="space-y-1">
      <Label for="setup-projects" class="text-sm font-medium">Projects</Label>
      <p class="text-xs text-muted-foreground">
        Shared workstream state agents read and write over MCP — notes, todos, files and
        per-project memory. Adds the coordination skill to every host.
      </p>
      {#if projectsOn}
        <div class="pt-3 space-y-1.5">
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
            <p class="text-[11px] text-muted-foreground">A slug is all that is required.</p>
          {/if}
        </div>
      {/if}
    </div>
    <Switch id="setup-projects" checked={projectsOn} onCheckedChange={(v) => (projectsOn = v)} />
  </div>

  <div class="flex items-start justify-between gap-4 rounded-lg border p-4">
    <div class="space-y-1">
      <Label for="setup-secrets" class="text-sm font-medium">Secrets</Label>
      <p class="text-xs text-muted-foreground">
        A fleet-wide credential store agents reach over MCP instead of hunting through env
        files. Values are encrypted at rest and never written to host disks.
      </p>
    </div>
    <Switch id="setup-secrets" checked={secretsOn} onCheckedChange={(v) => (secretsOn = v)} />
  </div>
</div>
