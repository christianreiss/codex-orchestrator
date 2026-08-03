<script lang="ts">
  /**
   * The six critical readiness checks, read-only. Nothing here is fixable from
   * the browser — every one of them is owned by `bin/install.sh` or the
   * environment — so this step reports and points at the command that fixes it
   * rather than pretending to offer a control.
   */
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import type { SetupCheck } from "$lib/api/setup";

  let { checks, warnings }: { checks: SetupCheck[]; warnings: string[] } = $props();

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
    <Alert>
      <AlertTitle>Attention</AlertTitle>
      <AlertDescription>{warning}</AlertDescription>
    </Alert>
  {/each}

  <ul class="divide-y rounded-lg border">
    {#each checks as check (check.id)}
      <li class="flex items-start justify-between gap-4 p-3 text-sm">
        <span class="flex items-center gap-2">
          <span
            class={check.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
            aria-hidden="true">{check.ok ? "✓" : "✕"}</span
          >
          <span class="font-medium">{check.label}</span>
        </span>
        <span class="text-right text-xs text-muted-foreground">{check.detail}</span>
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
          These are host-level, not console-level — fix them on the machine running the
          stack, then this page updates on its own.
        </p>
        <ul class="space-y-1">
          {#each failing as check (check.id)}
            <li><span class="font-medium">{check.label}</span> — <code class="text-xs">{remedy(check.id)}</code></li>
          {/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}
</div>
