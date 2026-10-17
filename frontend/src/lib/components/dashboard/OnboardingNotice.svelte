<script lang="ts">
  /**
   * Resume entry point for the first-run wizard, shown only while setup is
   * incomplete.
   *
   * Hidden once the wizard is completed or explicitly dismissed, so declining
   * every optional module does not leave a permanent nag: half the wizard is
   * opt-ins, and "no" is a finished answer. The one exception is fleet
   * defaults: until that row exists skills, memory, projects and secrets are
   * all dark, so the notice stays until it is saved (and then has no Dismiss).
   *
   * Every item links to where it gets done; Resume opens the earliest wizard
   * step that still has something open.
   */
  import { Button } from "$lib/components/ui/button";
  import Circle from "@lucide/svelte/icons/circle";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { SETUP_STEPS, createSetupWizardMutation, setupStatusQuery, stepForAction } from "$lib/api/setup";

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
  <section class="rounded-md border border-primary/30 px-3 py-2" aria-labelledby="onboarding-title">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <h2 id="onboarding-title" class="text-h3">{started ? "Resume setup" : "Finish setting up"}</h2>
        <p class="text-body-sm text-muted-foreground">The console works, but these are still open.</p>
      </div>
      <div class="flex items-center gap-2">
        {#if !finished}
          <Button variant="ghost" size="sm" disabled={$dismiss.isPending} onclick={() => $dismiss.mutate({ dismissed: true })}>Dismiss</Button>
        {/if}
        <Button variant="outline" size="sm" href={resumeHref}>{started ? "Resume setup" : "Open the setup wizard"}</Button>
      </div>
    </div>
    <ul class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-body-sm">
      {#each pending as action (action.id)}
        <li class="flex items-center gap-1.5">
          <Circle class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <a href={toAppHref(action.href)} class="underline-offset-4 hover:underline focus-visible:underline">{action.label}</a>
        </li>
      {/each}
    </ul>
  </section>
{/if}
