<script lang="ts">
  /**
   * The installer and host environment own the readiness prerequisites.
   * An operator can repeat the shared status check after repairing the host.
   */
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import type { SetupCheck } from "$lib/api/setup";

  let { checks, warnings, checking, paused, refreshError, onRecheck }: {
    checks: SetupCheck[];
    warnings: string[];
    checking: boolean;
    paused: boolean;
    refreshError: string | null;
    onRecheck: () => void;
  } = $props();

  const failing = $derived(checks.filter((check) => check.critical && !check.ok));

  /** Same mapping `bin/install.sh doctor` prints, so both name one fix. */
  function remedy(id: string): string {
    switch (id) {
      case "database":
        return "docker compose logs mysql, then bin/install.sh --from datatier";
      case "migrations":
        return "bin/install.sh --only schema";
      case "runner":
        return "docker compose logs auth-runner — it needs build-time internet access";
      case "signer":
        return "bin/install.sh --only signer";
      case "wrappers":
        return "bin/install.sh --only wrappers --force wrappers";
      case "public_base_url":
        return "bin/install.sh --only urls";
      default:
        return "docker compose logs api";
    }
  }
</script>

<div class="space-y-4">
  {#each warnings as warning}
    <Alert variant="warning">
      <AlertTitle>Attention</AlertTitle>
      <AlertDescription>{warning}</AlertDescription>
    </Alert>
  {/each}

  <ul aria-label="Last reported infrastructure checks" class="divide-y rounded-md border">
    {#each checks as check (check.id)}
      <li class="flex items-start justify-between gap-4 p-3 text-body">
        <span class="flex flex-wrap items-center gap-2">
          <span class={`inline-flex items-center gap-1 text-body-sm font-medium ${check.ok ? "text-success" : "text-destructive"}`}>
            {#if check.ok}<CircleCheck class="h-4 w-4" aria-hidden="true" /> Passed{:else}<CircleX class="h-4 w-4" aria-hidden="true" /> Failing{/if}
          </span>
          <span class="font-medium">{check.label}</span>
        </span>
        <span class="text-right text-body-sm text-muted-foreground">{check.detail}</span>
      </li>
    {/each}
  </ul>

  {#if failing.length > 0}
    <Alert variant="destructive">
      <AlertTitle>
        {failing.length === 1 ? "One check is failing" : `${failing.length} checks are failing`}
      </AlertTitle>
      <AlertDescription>
        <p class="mb-2">
          Repair the failing checks on the machine running the stack, then choose Check again.
        </p>
        <ul class="space-y-1">
          {#each failing as check (check.id)}
            <li><span class="font-medium">{check.label}</span> — <code class="text-body-sm">{remedy(check.id)}</code></li>
          {/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}

  {#if refreshError && !checking && !paused}
    <Alert variant="destructive">
      <AlertTitle>Could not refresh infrastructure checks</AlertTitle>
      <AlertDescription>{refreshError} The list shows the last reported results. Choose Check again to retry.</AlertDescription>
    </Alert>
  {/if}
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" aria-disabled={checking || paused} onclick={() => { if (!checking && !paused) onRecheck(); }}>
      Check again
    </Button>
    <p role="status" class="text-body-sm text-muted-foreground">
      {#if checking}Checking infrastructure…{:else if paused}Waiting for a network connection…{:else if !refreshError && failing.length === 0}All required checks passed.{/if}
    </p>
  </div>
</div>
