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
  import { ApiError } from "$lib/api/client";
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
    SETUP_STEPS,
    createSetupWizardMutation,
    defaultEnginesOf,
    isSetupStep,
    setupStatusQuery,
    type SetupStatus,
    type SetupStep,
    type SetupWizardUpdate,
  } from "$lib/api/setup";

  const qc = useQueryClient();
  const status = setupStatusQuery();
  const wizardMutation = createSetupWizardMutation(qc);

  type Engine = "codex" | "claude";

  let current = $state<SetupStep>("infrastructure");
  let engines = $state<Engine[]>(["codex"]);
  /**
   * Whether `engines` is an answer. Skip on the Engines step leaves it false,
   * so the wizard never records a choice the operator did not make.
   */
  let enginesAnswered = $state(false);
  /** Furthest step reached, by id — hiding `auth` must not shift the marks. */
  let furthest = $state<SetupStep>("infrastructure");
  let hydrated = false;
  let finishing = $state(false);

  let ownerStep = $state<OwnerStep | null>(null);
  let authStep = $state<AuthStep | null>(null);
  let defaultsStep = $state<DefaultsStep | null>(null);
  let policyStep = $state<PolicyStep | null>(null);
  let modulesStep = $state<ModulesStep | null>(null);
  let collabStep = $state<CollaborationStep | null>(null);
  let hostStep = $state<HostStep | null>(null);

  const data = $derived($status.data ?? null);
  const unauthorized = $derived($status.error instanceof ApiError && $status.error.status === 401);
  const criticalFailing = $derived(
    (data?.checks ?? []).some((check) => check.critical && !check.ok),
  );
  const runnerHealthy = $derived(
    (data?.checks ?? []).find((check) => check.id === "runner")?.ok ?? true,
  );

  const order = (step: SetupStep): number => SETUP_STEPS.indexOf(step);
  const later = (a: SetupStep, b: SetupStep): SetupStep => (order(a) >= order(b) ? a : b);

  const LABELS: Record<SetupStep, string> = {
    infrastructure: "Infrastructure",
    owner: "Owner",
    engines: "Engines",
    auth: "Credentials",
    defaults: "Fleet defaults",
    policy: "Agent policy",
    modules: "Modules",
    collaboration: "Collaboration",
    host: "First host",
  };

  // `auth` disappears from the rail entirely when no engine is selected — an
  // empty step reading "nothing to do here" is worse than no step.
  const visible = $derived(
    SETUP_STEPS.filter((step) => !(step === "auth" && engines.length === 0)),
  );
  const steps = $derived<WizardStepMeta[]>(
    visible.map((id) => ({
      id,
      label: LABELS[id],
      done: order(id) < order(furthest),
      reachable: order(id) <= order(furthest),
    })),
  );

  /** The engines the wizard would record if asked now. */
  function answeredEngines(status: SetupStatus): Engine[] {
    return status.wizard.engines ? [...status.wizard.engines] : defaultEnginesOf(status);
  }

  // Hydrate position once: the URL wins over stored progress so a deep link
  // from the checklist lands where it says it will. Without one, an
  // installation that already has an owner opens past the steps it cannot
  // act on — past Infrastructure too when every critical check passes.
  $effect(() => {
    if (hydrated || !data) return;
    hydrated = true;
    const wizard = data.wizard;
    engines = answeredEngines(data);
    enginesAnswered = wizard.engines !== null;

    const fromUrl = page.url.searchParams.get("step");
    const floor: SetupStep =
      data.owner_created && data.critical_complete ? "engines" : "infrastructure";
    const resumed = later(wizard.last_step ?? "infrastructure", floor);
    let target: SetupStep = isSetupStep(fromUrl) ? fromUrl : resumed;
    if (target === "auth" && engines.length === 0) target = "defaults";
    current = target;
    // A deep link to an earlier step keeps what was already reached.
    furthest = later(furthest, later(target, resumed));
  });

  // `/setup` renders outside the layout's auth redirect, so a lapsed session
  // is handled here: the status endpoint answers 401 once an owner exists.
  $effect(() => {
    if (unauthorized) {
      void goto(`${base}/login?next=${encodeURIComponent("/setup")}`, { replaceState: true });
    }
  });

  function syncUrl(step: SetupStep): void {
    const url = new URL(page.url);
    url.searchParams.set("step", step);
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function record(update: SetupWizardUpdate): void {
    $wizardMutation.mutate(update);
  }

  /** Bookmark payload; engines ride along only once they are an answer. */
  function progress(step: SetupStep): SetupWizardUpdate {
    return enginesAnswered ? { last_step: step, engines } : { last_step: step };
  }

  function navigate(step: SetupStep): void {
    current = step;
    furthest = later(furthest, step);
    syncUrl(step);
    record(progress(step));
  }

  function advance(): void {
    const next = visible[visible.indexOf(current) + 1];
    if (next) navigate(next);
    else void finish();
  }

  async function finish(): Promise<void> {
    finishing = true;
    try {
      await $wizardMutation.mutateAsync({ ...progress(current), completed: true });
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
   * write failed, validation rejected, or the step has something to show
   * first (a one-time link, an install command), so the wizard holds position.
   */
  async function next(): Promise<void> {
    switch (current) {
      case "owner": {
        if (!(await ownerStep?.submit())) return;
        void $status.refetch();
        break;
      }
      case "engines":
        enginesAnswered = true;
        break;
      case "auth":
        if (!(await authStep?.submit())) return;
        break;
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
      case "host":
        // A typed hostname is registered first; the step then shows the
        // install command and progress, and the next press finishes.
        if (hostStep?.hasPendingInput()) {
          await hostStep.submit();
          return;
        }
        break;
      default:
        break;
    }
    advance();
  }

  /** Skip moves on without answering — except where moving on needs a write. */
  async function skip(): Promise<void> {
    switch (current) {
      case "engines":
        // Leave the previous answer (or the server default) in force.
        if (data) engines = answeredEngines(data);
        break;
      case "defaults":
        // The client-config row is what turns MCP on, and it only exists once
        // defaults are saved: skipping saves the catalog defaults. The wizard
        // advances even if that fails; the checklist keeps the item open.
        await defaultsStep?.persist();
        break;
      case "host":
        await next();
        return;
      default:
        break;
    }
    advance();
  }

  // Steps expose `isBusy()` rather than a derived value — Svelte 5 cannot
  // export derived state — and reading it inside this `$derived` still tracks
  // whatever signals the call touches.
  const busy = $derived(
    finishing ||
      (current === "auth" && (authStep?.isBusy() ?? false)) ||
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
          description: "Your admin account. Creating it also signs you in.",
          skippable: false,
          nextLabel: data?.owner_created ? "Continue" : "Create owner",
        };
      case "engines":
        return {
          title: "Which engines will this fleet run?",
          description: "Decides which credentials to ask for next.",
          skippable: true,
          nextLabel: "Save and continue",
        };
      case "auth":
        return {
          title: "Provider credentials",
          description: "One credential per engine, checked with the provider before it is stored.",
          skippable: true,
          nextLabel: authStep?.hasPendingInput() ? "Save and continue" : "Continue",
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
          nextLabel: "Save and continue",
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
          nextLabel: collabStep?.primaryLabel() ?? "Save and continue",
        };
      case "host":
        return {
          title: "Register your first host",
          description: "Optional — the console works without one.",
          skippable: false,
          nextLabel: hostStep?.hasPendingInput() ? "Register host" : "Finish",
        };
    }
  });

  onMount(() => {
    void $status.refetch();
  });
</script>

<svelte:head><title>Setup · Codex Orchestrator</title></svelte:head>

{#if unauthorized}
  <main class="flex min-h-screen items-center justify-center p-6">
    <p class="text-sm text-muted-foreground">Your session has ended. Redirecting to sign in…</p>
  </main>
{:else if $status.isError && !data}
  <main class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-md space-y-4">
      <Alert variant="destructive">
        <AlertTitle>API unreachable</AlertTitle>
        <AlertDescription>{$status.error?.message}</AlertDescription>
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
    onSkip={skip}
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
      <AuthStep bind:this={authStep} {engines} canonical={data.canonical_auth} {runnerHealthy} />
    {:else if current === "defaults"}
      <DefaultsStep bind:this={defaultsStep} {engines} />
    {:else if current === "policy"}
      <PolicyStep bind:this={policyStep} />
    {:else if current === "modules"}
      <ModulesStep bind:this={modulesStep} />
    {:else if current === "collaboration"}
      <CollaborationStep bind:this={collabStep} />
    {:else if current === "host"}
      <HostStep bind:this={hostStep} defaultEngines={engines} onSubmitRequested={next} />
    {/if}
  </WizardShell>
{/if}
