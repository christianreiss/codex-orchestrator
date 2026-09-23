<script lang="ts">
  /**
   * Resume entry point for the first-run wizard.
   *
   * Hidden once the wizard is completed or explicitly dismissed, so declining
   * every optional module does not leave a permanent nag — half the wizard is
   * opt-ins, and "no" is a finished answer. The one exception is fleet
   * defaults: until that row exists skills, memory, projects and secrets are
   * all dark, so the card stays until it is saved.
   *
   * Every item links to where it gets done; Resume opens the earliest wizard
   * step that still has something open.
   */
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import Circle from "@lucide/svelte/icons/circle";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import {
    SETUP_STEPS,
    createSetupWizardMutation,
    setupStatusQuery,
    stepForAction,
  } from "$lib/api/setup";

  const qc = useQueryClient();
  const setup = setupStatusQuery();
  const dismiss = createSetupWizardMutation(qc);

  const wizard = $derived($setup.data?.wizard ?? null);
  const finished = $derived(Boolean(wizard?.completed_at || wizard?.dismissed_at));
  const pending = $derived($setup.data?.next_actions.filter((action) => !action.complete) ?? []);
  const defaultsOpen = $derived(pending.some((action) => action.id === "fleet_defaults"));
  const visible = $derived((!finished && pending.length > 0) || defaultsOpen);
  const started = $derived(Boolean(wizard?.last_step));

  /**
   * Server hrefs are absolute and already carry the SPA base (`/admin/...`).
   * Re-root them on `paths.base` so a different base still resolves.
   */
  function toAppHref(href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    const relative = href.startsWith("/admin/") || href === "/admin" ? href.slice("/admin".length) : href;
    return `${base}${relative.startsWith("/") ? relative : `/${relative}`}`;
  }

  const resumeStep = $derived.by(() => {
    const steps = pending
      .map((action) => stepForAction(action.id))
      .filter((step) => step !== null)
      .sort((a, b) => SETUP_STEPS.indexOf(a) - SETUP_STEPS.indexOf(b));
    return steps[0] ?? wizard?.last_step ?? null;
  });
  const resumeHref = $derived(resumeStep ? `${base}/setup?step=${resumeStep}` : `${base}/setup`);
</script>

{#if visible}
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
          <li class="flex items-center gap-2">
            <Circle class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <a
              href={toAppHref(action.href)}
              class="underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
            >
              {action.label}
            </a>
          </li>
        {/each}
      </ul>
    </Card.Content>
    <Card.Footer class="gap-2">
      <Button variant="outline" href={resumeHref}>
        {started ? "Resume setup" : "Open the setup wizard"}
      </Button>
      {#if !finished}
        <Button
          variant="ghost"
          size="sm"
          disabled={$dismiss.isPending}
          onclick={() => $dismiss.mutate({ dismissed: true })}
        >
          Dismiss
        </Button>
      {/if}
    </Card.Footer>
  </Card.Root>
{/if}
