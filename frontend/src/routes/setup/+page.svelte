<script lang="ts">
  /**
   * First-run setup wizard.
   *
   * Renders outside AppShell (it is in the layout's STANDALONE list), so it
   * owns the viewport.
   *
   * Position is client state mirrored to `?step=` for deep links and reloads,
   * and persisted server-side so the dashboard can offer Resume. Server truth
   * comes from the polling setup-status query, which every step shares.
   *
   * Only the first two steps block: infrastructure is not fixable from a
   * browser, and nothing else can be written without the session the owner
   * claim issues. Everything after is skippable, because "no" is a complete
   * answer to most of it.
   */
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import WizardShell from "$lib/components/setup/WizardShell.svelte";
  import type { WizardStepMeta } from "$lib/components/setup/WizardShell.svelte";
  import InfrastructureStep from "$lib/components/setup/InfrastructureStep.svelte";
  import OwnerStep from "$lib/components/setup/OwnerStep.svelte";
  import EnginesStep from "$lib/components/setup/EnginesStep.svelte";
  import AuthStep from "$lib/components/setup/AuthStep.svelte";
  import DefaultsStep from "$lib/components/setup/DefaultsStep.svelte";
  import PolicyStep from "$lib/components/setup/PolicyStep.svelte";
  import ModulesStep from "$lib/components/setup/ModulesStep.svelte";
  import CollaborationStep from "$lib/components/setup/CollaborationStep.svelte";
  import HostStep from "$lib/components/setup/HostStep.svelte";
  import {
    createSetupWizardMutation,
    isSetupStep,
    setupStatusQuery,
    type SetupStep,
    type SetupWizardUpdate,
  } from "$lib/api/setup";

  const qc = useQueryClient();
  const status = setupStatusQuery();
  const wizardMutation = createSetupWizardMutation(qc);

  let current = $state<SetupStep>("infrastructure");
  let engines = $state<("codex" | "claude")[]>(["codex"]);
  let furthest = $state(0);
  let hydrated = false;
  let finishing = $state(false);

  let ownerStep = $state<OwnerStep | null>(null);
  let defaultsStep = $state<DefaultsStep | null>(null);
  let policyStep = $state<PolicyStep | null>(null);
  let modulesStep = $state<ModulesStep | null>(null);
  let collabStep = $state<CollaborationStep | null>(null);
  let hostStep = $state<HostStep | null>(null);

  const data = $derived($status.data ?? null);
  const criticalFailing = $derived(
    (data?.checks ?? []).some((check) => check.critical && !check.ok),
  );
  const runnerHealthy = $derived(
    (data?.checks ?? []).find((check) => check.id === "runner")?.ok ?? true,
  );

  // `auth` disappears from the rail entirely when no engine is selected — an
  // empty step reading "nothing to do here" is worse than no step.
  const steps = $derived<WizardStepMeta[]>([
    { id: "infrastructure", label: "Infrastructure" },
    { id: "owner", label: "Owner" },
    { id: "engines", label: "Engines" },
    { id: "auth", label: "Credentials", skipped: engines.length === 0 },
    { id: "defaults", label: "Fleet defaults" },
    { id: "policy", label: "Agent policy" },
    { id: "modules", label: "Modules" },
    { id: "collaboration", label: "Collaboration" },
    { id: "host", label: "First host" },
  ]);
  const visible = $derived(steps.filter((step) => !step.skipped));

  function indexOf(step: SetupStep): number {
    const i = visible.findIndex((entry) => entry.id === step);
    return i < 0 ? 0 : i;
  }

  // Hydrate position once: the URL wins over stored progress so a deep link
  // from the checklist lands where it says it will.
  $effect(() => {
    const wizard = data?.wizard;
    if (hydrated || !wizard) return;
    hydrated = true;
    if (wizard.engines) engines = [...wizard.engines];

    const fromUrl = page.url.searchParams.get("step");
    const target: SetupStep = isSetupStep(fromUrl)
      ? fromUrl
      : (wizard.last_step ?? "infrastructure");
    current = target;
    furthest = Math.max(furthest, indexOf(target));
  });

  function syncUrl(step: SetupStep): void {
    const url = new URL(page.url);
    url.searchParams.set("step", step);
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function record(update: SetupWizardUpdate): void {
    $wizardMutation.mutate(update);
  }

  function navigate(step: SetupStep): void {
    current = step;
    furthest = Math.max(furthest, indexOf(step));
    syncUrl(step);
    record({ last_step: step, engines });
  }

  function advance(): void {
    const next = visible[indexOf(current) + 1];
    if (next) navigate(next.id);
    else void finish();
  }

  async function finish(): Promise<void> {
    finishing = true;
    try {
      await $wizardMutation.mutateAsync({ completed: true, engines, last_step: current });
      await goto(`${base}/dashboard`);
    } catch {
      // Recording completion is bookkeeping; never trap the operator here.
      await goto(`${base}/dashboard`);
    } finally {
      finishing = false;
    }
  }

  /**
   * Steps that write expose `persist()`/`submit()`. A false return means the
   * write failed or validation rejected, so the wizard holds position rather
   * than advancing past an error the operator has not seen yet.
   */
  async function next(): Promise<void> {
    switch (current) {
      case "owner": {
        if (!(await ownerStep?.submit())) return;
        void $status.refetch();
        break;
      }
      case "defaults":
        if (!(await defaultsStep?.persist())) return;
        break;
      case "policy":
        if (!(await policyStep?.persist())) return;
        break;
      case "modules":
        if (!(await modulesStep?.persist())) return;
        break;
      case "collaboration":
        if (!(await collabStep?.persist())) return;
        break;
      default:
        // Read-only steps, and the host step whose registration is its own
        // button — Finish never blocks on it.
        break;
    }
    advance();
  }

  // Steps expose `isBusy()` rather than a derived value — Svelte 5 cannot
  // export derived state — and reading it inside this `$derived` still tracks
  // whatever signals the call touches.
  const busy = $derived(
    finishing ||
      (current === "defaults" && (defaultsStep?.isBusy() ?? false)) ||
      (current === "policy" && (policyStep?.isBusy() ?? false)) ||
      (current === "modules" && (modulesStep?.isBusy() ?? false)) ||
      (current === "collaboration" && (collabStep?.isBusy() ?? false)) ||
      (current === "host" && (hostStep?.isBusy() ?? false)),
  );

  const meta = $derived.by(() => {
    switch (current) {
      case "infrastructure":
        return {
          title: "Infrastructure",
          description: "Everything the console needs before it can be configured.",
          skippable: false,
          nextLabel: "Continue",
        };
      case "owner":
        return {
          title: "Create the first owner",
          description: "A one-time claim that also signs you in.",
          skippable: false,
          nextLabel: data?.owner_created ? "Continue" : "Create owner",
        };
      case "engines":
        return {
          title: "Which engines will this fleet run?",
          description: "Decides which credentials to ask for next.",
          skippable: true,
          nextLabel: "Continue",
        };
      case "auth":
        return {
          title: "Provider credentials",
          description: "One canonical credential per engine, verified before it is stored.",
          skippable: true,
          nextLabel: "Continue",
        };
      case "defaults":
        return {
          title: "Fleet defaults",
          description:
            "Model and effort for every managed host — and the write that turns MCP on.",
          skippable: true,
          nextLabel: "Save and continue",
        };
      case "policy":
        return {
          title: "Agent policy",
          description: "What every agent in this fleet is told before it starts work.",
          skippable: true,
          nextLabel: "Continue",
        };
      case "modules":
        return {
          title: "Optional modules",
          description: "Shared capabilities agents reach over MCP.",
          skippable: true,
          nextLabel: "Save and continue",
        };
      case "collaboration":
        return {
          title: "Collaboration",
          description: "How humans and agents reach each other. Both are off by default.",
          skippable: true,
          nextLabel: "Save and continue",
        };
      case "host":
        return {
          title: "Register your first host",
          description: "Optional — the console works without one.",
          skippable: true,
          nextLabel: "Finish",
        };
    }
  });

  onMount(() => {
    void $status.refetch();
  });
</script>

<svelte:head><title>Setup · Codex Orchestrator</title></svelte:head>

{#if $status.isError}
  <main class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-md space-y-4">
      <Alert variant="destructive">
        <AlertTitle>API unreachable</AlertTitle>
        <AlertDescription>{$status.error.message}</AlertDescription>
      </Alert>
      <Button variant="outline" onclick={() => $status.refetch()}>Retry</Button>
    </div>
  </main>
{:else if !data}
  <main class="flex min-h-screen items-center justify-center p-6">
    <p class="text-sm text-muted-foreground">Checking installation…</p>
  </main>
{:else}
  <WizardShell
    {steps}
    {current}
    {furthest}
    {busy}
    title={meta.title}
    description={meta.description}
    skippable={meta.skippable}
    nextLabel={meta.nextLabel}
    blocked={current === "infrastructure" && criticalFailing}
    blockedReason={current === "infrastructure" && criticalFailing
      ? "Fix the failing checks on the host first."
      : undefined}
    onNavigate={navigate}
    onNext={next}
    onSkip={advance}
  >
    {#if current === "infrastructure"}
      <InfrastructureStep checks={data.checks} warnings={data.warnings} />
    {:else if current === "owner"}
      <OwnerStep
        bind:this={ownerStep}
        ownerCreated={data.owner_created}
        onCreated={() => void $status.refetch()}
        onSubmitRequested={next}
      />
    {:else if current === "engines"}
      <EnginesStep bind:engines />
    {:else if current === "auth"}
      <AuthStep {engines} canonical={data.canonical_auth} {runnerHealthy} />
    {:else if current === "defaults"}
      <DefaultsStep bind:this={defaultsStep} {engines} />
    {:else if current === "policy"}
      <PolicyStep bind:this={policyStep} />
    {:else if current === "modules"}
      <ModulesStep bind:this={modulesStep} />
    {:else if current === "collaboration"}
      <CollaborationStep bind:this={collabStep} />
    {:else if current === "host"}
      <HostStep
        bind:this={hostStep}
        defaultEngines={engines}
        syncedHosts={data.hosts.synced}
        totalHosts={data.hosts.total}
      />
    {/if}
  </WizardShell>
{/if}
