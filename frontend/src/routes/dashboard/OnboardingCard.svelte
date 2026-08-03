<script lang="ts">
  /**
   * Resume entry point for the first-run wizard.
   *
   * Hidden once the wizard is completed or explicitly dismissed, so declining
   * every optional module does not leave a permanent nag — half the wizard is
   * opt-ins, and "no" is a finished answer. Until then it deep-links back to
   * wherever the operator stopped.
   */
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { createSetupWizardMutation, setupStatusQuery } from "$lib/api/setup";

  const qc = useQueryClient();
  const setup = setupStatusQuery();
  const dismiss = createSetupWizardMutation(qc);

  const wizard = $derived($setup.data?.wizard ?? null);
  const finished = $derived(Boolean(wizard?.completed_at || wizard?.dismissed_at));
  const pending = $derived($setup.data?.next_actions.filter((action) => !action.complete) ?? []);
  const started = $derived(Boolean(wizard?.last_step));
  const resumeHref = $derived(
    wizard?.last_step ? `${base}/setup?step=${wizard.last_step}` : `${base}/setup`,
  );
</script>

{#if !finished && pending.length > 0}
  <Card.Root class="border-primary/30">
    <Card.Header>
      <Card.Title>{started ? "Resume setup" : "Finish setting up"}</Card.Title>
      <Card.Description>
        The console works, but these are still open.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <ul class="space-y-2 text-sm">
        {#each pending as action (action.id)}
          <li>○ {action.label}</li>
        {/each}
      </ul>
    </Card.Content>
    <Card.Footer class="gap-2">
      <Button variant="outline" href={resumeHref}>
        {started ? "Resume where you left off" : "Open the setup wizard"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={$dismiss.isPending}
        onclick={() => $dismiss.mutate({ dismissed: true })}
      >
        Dismiss
      </Button>
    </Card.Footer>
  </Card.Root>
{/if}
