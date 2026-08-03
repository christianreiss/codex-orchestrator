<script lang="ts">
  /**
   * Provider auth for whichever engines the previous step selected.
   *
   * With both engines chosen this shows one panel per engine, each with its own
   * verified/pending state, because they are independent credentials with
   * independent failure modes.
   */
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import SeedAuthPanel from "./SeedAuthPanel.svelte";
  import type { AuthEngine } from "$lib/api/auth";

  type Props = {
    engines: AuthEngine[];
    canonical: { codex: boolean; claude: boolean };
    runnerHealthy: boolean;
  };

  let { engines, canonical, runnerHealthy }: Props = $props();

  const label = (engine: AuthEngine) => (engine === "codex" ? "Codex" : "Claude");
  const verified = (engine: AuthEngine) => (engine === "codex" ? canonical.codex : canonical.claude);
</script>

{#if engines.length === 0}
  <Alert>
    <AlertTitle>No engines selected</AlertTitle>
    <AlertDescription>
      Nothing to seed. Everything else still gets configured, and you can add credentials
      later from Hosts → More → Seed canonical auth.
    </AlertDescription>
  </Alert>
{:else}
  <div class="space-y-6">
    <p class="text-sm text-muted-foreground">
      One canonical credential per engine serves the whole fleet. Each is verified against
      the live provider before it is stored, so a bad value fails here rather than on a
      host at 3am.
    </p>

    {#each engines as engine (engine)}
      <section class="rounded-lg border p-4">
        <header class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-sm font-medium">{label(engine)}</h3>
          {#if verified(engine)}
            <Badge variant="secondary">Verified</Badge>
          {:else}
            <Badge variant="outline">Not seeded</Badge>
          {/if}
        </header>

        {#if verified(engine)}
          <p class="text-sm text-muted-foreground">
            A verified canonical credential is already stored. Upload again only to replace
            it.
          </p>
          <details class="mt-3">
            <summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Replace {label(engine)} credentials
            </summary>
            <div class="pt-3">
              <SeedAuthPanel allowedEngines={[engine]} defaultEngine={engine} {runnerHealthy} />
            </div>
          </details>
        {:else}
          <SeedAuthPanel allowedEngines={[engine]} defaultEngine={engine} {runnerHealthy} />
        {/if}
      </section>
    {/each}
  </div>
{/if}
