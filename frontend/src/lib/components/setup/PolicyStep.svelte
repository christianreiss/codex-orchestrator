<script lang="ts">
  /**
   * Fleet agent policy — shown, not asked.
   *
   * `ensureAgentPolicy` runs on every boot and seeds the full builder default
   * (all ten modules) on a fresh install, so there is nothing broken here to
   * fix. Making an operator assemble a policy before they have a single host
   * would be busywork.
   *
   * The one thing worth collecting is house rules, so that is the only input:
   * a `custom_instructions` textarea appended to the composition. Compose+store
   * only fires when they actually type something.
   */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Badge } from "$lib/components/ui/badge";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { agentsApi } from "$lib/api/agents";
  import type { AgentPolicyComposition } from "$lib/api/types";

  const qc = useQueryClient();

  const doc = createQuery({
    queryKey: ["agents", "document"],
    queryFn: () => agentsApi.get(),
  });

  const composition = $derived($doc.data?.builder_state ?? null);
  const modules = $derived(composition?.enabled_modules ?? []);

  let houseRules = $state("");
  let loaded = false;

  $effect(() => {
    const current = composition?.custom_instructions;
    if (!loaded && typeof current === "string") {
      houseRules = current;
      loaded = true;
    }
  });

  const dirty = $derived(loaded && houseRules !== (composition?.custom_instructions ?? ""));
  let saving = $state(false);

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return saving;
  }

  /** No-ops unless the operator edited the text. */
  export async function persist(): Promise<boolean> {
    if (!dirty || !composition) return true;
    saving = true;
    try {
      const next: AgentPolicyComposition = { ...composition, custom_instructions: houseRules };
      await agentsApi.store({ composition: next });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Fleet policy updated");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the policy");
      return false;
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  {#if $doc.isLoading}
    <p class="text-sm text-muted-foreground">Loading the fleet policy…</p>
  {:else if $doc.isError}
    <Alert variant="destructive">
      <AlertTitle>Could not load the fleet policy</AlertTitle>
      <AlertDescription>{$doc.error.message}</AlertDescription>
    </Alert>
  {:else}
    <Alert>
      <AlertTitle>Already configured</AlertTitle>
      <AlertDescription>
        A complete default policy is installed and served to every host. It carries the
        fleet identity, the safety floor and the hard-stop rules, which are managed here
        and cannot be switched off.
      </AlertDescription>
    </Alert>

    {#if modules.length > 0}
      <div class="space-y-2">
        <p class="text-sm font-medium">Active modules</p>
        <div class="flex flex-wrap gap-1.5">
          {#each modules as id (id)}
            <Badge variant="secondary" class="font-normal">{id.replace(/_/g, " ")}</Badge>
          {/each}
        </div>
      </div>
    {/if}

    <div class="space-y-1.5">
      <Label for="setup-house-rules">House rules (optional)</Label>
      <Textarea
        id="setup-house-rules"
        class="h-32 text-sm"
        placeholder="Anything specific to your fleet — deploy conventions, naming, which environments are off limits."
        bind:value={houseRules}
      />
      <p class="text-[11px] text-muted-foreground">
        Appended to the policy every host receives. Leave blank to keep the default as-is;
        the full builder lives on the Instructions page.
      </p>
    </div>
  {/if}
</div>
