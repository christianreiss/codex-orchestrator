<script module lang="ts">
  import type { ApiKeyEngine } from "$lib/api/types";

  /**
   * Module scope, not component state: survives an instance remount (e.g. a
   * dev-mode HMR recreate) so the one-shot sessionStorage handoff doesn't get
   * silently dropped if the component happens to mount twice for reasons
   * that have nothing to do with the handoff itself. Bounded by the same
   * freshness window as the sessionStorage entry it came from -- otherwise
   * it would keep re-showing a stale plaintext key (and shadow an explicit
   * `?existingKeyId=` deep link) for the rest of the SPA session.
   */
  let consumedHandoff: { engine: ApiKeyEngine; name: string; key: string; consumedAtMs: number } | null = null;
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Rocket from "@lucide/svelte/icons/rocket";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import NewProjectDialog from "$lib/components/projects/NewProjectDialog.svelte";
  import ProjectPreviewCard from "$lib/components/bootstrap/ProjectPreviewCard.svelte";
  import ExistingKeyPicker from "$lib/components/bootstrap/ExistingKeyPicker.svelte";
  import BootstrapDocument from "$lib/components/bootstrap/BootstrapDocument.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { keysApi, keyQueryKeys, engineLabel } from "$lib/api/keys";
  import { fetchProject, fetchProjects, projectKeys } from "$lib/api/projects";
  import type { AdminApiKey, AdminApiKeyCreated, CreateApiKeyPayload } from "$lib/api/types";

  const NONE_PROJECT = "__none__";
  const PENDING_KEY_STORAGE_KEY = "bootstrap:pending-key";
  const PENDING_KEY_MAX_AGE_MS = 2 * 60 * 1000;

  /** NewKeyDialog writes `Date.now()` (epoch ms); tolerate an ISO string too. */
  function parseCreatedAtMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  const qc = useQueryClient();

  // ---- Context ----
  let issuedTo = $state("");
  let engine = $state<ApiKeyEngine>("openai");
  let advancedOpen = $state(false);
  let rateLimitRpm = $state("60");
  let expiresEnabled = $state(false);
  let expiresAt = $state(""); // datetime-local string

  function onEngineChange(next: string | undefined) {
    if (!next || (next !== "openai" && next !== "claude") || next === engine) return;
    engine = next;
    // An existing-key selection is scoped to one engine's list; a different
    // engine invalidates it rather than silently pointing at the wrong row.
    existingKeyId = null;
  }

  // ---- Project ----
  let selectedProjectSlug = $state(NONE_PROJECT);
  let newProjectDialogOpen = $state(false);

  const projectsQuery = createQuery({ queryKey: projectKeys.list, queryFn: fetchProjects });
  const projects = $derived($projectsQuery.data?.projects ?? []);
  const projectSelectLabel = $derived(
    selectedProjectSlug === NONE_PROJECT
      ? "No project — key and base URL only"
      : projects.find((p) => p.slug === selectedProjectSlug)?.title || selectedProjectSlug,
  );

  const projectDetailQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.detail(selectedProjectSlug),
      queryFn: () => fetchProject(selectedProjectSlug),
      enabled: selectedProjectSlug !== NONE_PROJECT,
    })),
  );
  const selectedProject = $derived(
    selectedProjectSlug !== NONE_PROJECT ? $projectDetailQuery.data?.project ?? null : null,
  );

  // ---- Generate ----
  type GenerateMode = "create" | "existing";
  let generateMode = $state<GenerateMode>("create");
  let existingKeyId = $state<number | null>(null);

  const existingKeysQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: keyQueryKeys.list(engine),
      queryFn: () => keysApi.list(engine),
    })),
  );
  const existingKeys = $derived($existingKeysQuery.data ?? []);

  type CreatedDoc = { kind: "created"; engine: ApiKeyEngine; name: string; key: string };
  type ExistingDoc = { kind: "existing"; engine: ApiKeyEngine; name: string; keyPrefix: string };

  // The freshly-created (or handed-off) plaintext key, if any. Cleared when
  // the operator instead picks an existing key, so "last action wins".
  let createdDoc = $state<CreatedDoc | null>(null);
  const existingDoc = $derived<ExistingDoc | null>(
    existingKeyId !== null
      ? (() => {
          const record = existingKeys.find((k) => k.id === existingKeyId);
          return record
            ? { kind: "existing", engine, name: record.name, keyPrefix: record.key_prefix }
            : null;
        })()
      : null,
  );
  const doc = $derived(createdDoc ?? existingDoc);

  const createMut = createMutation<
    AdminApiKeyCreated,
    Error,
    { engine: ApiKeyEngine; payload: CreateApiKeyPayload }
  >({
    mutationFn: ({ engine, payload }) => keysApi.create(engine, payload),
    onSuccess: (data, vars) => {
      createdDoc = { kind: "created", engine: vars.engine, name: data.record.name, key: data.key };
      existingKeyId = null;
      toast.success(`${engineLabel(vars.engine)} key issued`, {
        description: `"${data.record.name}" is ready to use.`,
      });
      void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.engine) });
    },
    onError: (err) => {
      toast.error("Failed to create key", { description: err.message });
    },
  });

  function toIso(local: string): string | null {
    if (!local) return null;
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function handleCreate(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = issuedTo.trim();
    if (!trimmed) {
      toast.error("Issued to is required");
      return;
    }
    const rpm = Number(rateLimitRpm);
    if (!Number.isFinite(rpm) || rpm <= 0) {
      toast.error("Rate limit is required", {
        description: "Enter a positive number of requests per minute.",
      });
      return;
    }
    const payload: CreateApiKeyPayload = {
      name: trimmed,
      rate_limit_rpm: rpm,
      expires_at: expiresEnabled ? toIso(expiresAt) : null,
    };
    $createMut.mutate({ engine, payload });
  }

  function selectExisting(record: AdminApiKey) {
    createdDoc = null;
    existingKeyId = record.id;
  }

  function applyHandoff(payload: { engine: ApiKeyEngine; name: string; key: string }) {
    engine = payload.engine;
    issuedTo = payload.name;
    generateMode = "create";
    existingKeyId = null;
    createdDoc = { kind: "created", engine: payload.engine, name: payload.name, key: payload.key };
  }

  // ---- Integration contract: NewKeyDialog handoff + KeysTable deep link ----
  onMount(() => {
    // An explicit deep link (KeysTable's "Use in bootstrap" row action) is a
    // deliberate choice of a specific key and always wins over a leftover
    // handoff from an earlier visit in this SPA session.
    const paramEngine = page.url.searchParams.get("engine");
    const paramKeyId = page.url.searchParams.get("existingKeyId");
    if (paramKeyId) {
      const id = Number(paramKeyId);
      if (Number.isFinite(id)) {
        generateMode = "existing";
        if (paramEngine === "openai" || paramEngine === "claude") engine = paramEngine;
        existingKeyId = id;
        return;
      }
    }

    // A remount (e.g. dev-mode HMR recreating this instance) must not drop
    // the handoff just because sessionStorage was already consumed once,
    // but only within the handoff's original freshness window.
    if (consumedHandoff && Date.now() - consumedHandoff.consumedAtMs <= PENDING_KEY_MAX_AGE_MS) {
      applyHandoff(consumedHandoff);
      return;
    }

    try {
      const raw = sessionStorage.getItem(PENDING_KEY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{
          engine: ApiKeyEngine;
          keyId: number;
          key: string;
          name: string;
          createdAt: number | string;
        }>;
        const isValidShape =
          typeof parsed?.key === "string" &&
          typeof parsed?.name === "string" &&
          (parsed.engine === "openai" || parsed.engine === "claude");
        if (isValidShape) {
          const createdAtMs = parseCreatedAtMs(parsed.createdAt);
          const isFresh = createdAtMs !== null && Date.now() - createdAtMs <= PENDING_KEY_MAX_AGE_MS;
          if (isFresh) {
            sessionStorage.removeItem(PENDING_KEY_STORAGE_KEY);
            const payload = { engine: parsed.engine as ApiKeyEngine, name: parsed.name as string, key: parsed.key as string };
            consumedHandoff = { ...payload, consumedAtMs: Date.now() };
            applyHandoff(payload);
          }
        }
      }
    } catch {
      // Missing, malformed, or unparsable -- ignore silently.
    }
  });
</script>

<PageHeader
  title="Bootstrap"
  subtitle="Issue a key and point a coding AI at this fleet — base URL, credential, and project context in one document."
/>

<section class="setting-boundary">
  <div class="setting-boundary__head">
    <h2>Context</h2>
    <p>Who this key is for, and which engine it talks to.</p>
  </div>
  <div class="grid max-w-2xl gap-4 sm:grid-cols-2">
    <div class="grid gap-2 sm:col-span-2">
      <Label for="bootstrap-issued-to">Issued to</Label>
      <Input
        id="bootstrap-issued-to"
        bind:value={issuedTo}
        placeholder="jane@laptop, ci-runner, intern-macbook"
        autocomplete="off"
      />
    </div>
    <div class="grid gap-2">
      <Label for="bootstrap-engine">Engine</Label>
      <Select.Root type="single" value={engine} onValueChange={onEngineChange}>
        <Select.Trigger id="bootstrap-engine">{engineLabel(engine)}</Select.Trigger>
        <Select.Content>
          <Select.Item value="openai" label="OpenAI (Codex)" />
          <Select.Item value="claude" label="Claude (Anthropic)" />
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  <div class="mt-4 max-w-2xl border-t pt-4">
    <Collapsible.Root bind:open={advancedOpen}>
      <Collapsible.Trigger class="w-full">
        {#snippet child({ props })}
          <button {...props} type="button" class="group flex w-full items-center justify-between gap-3 text-left">
            <span class="text-sm font-medium">Advanced</span>
            <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div class="grid gap-4 pt-4 sm:grid-cols-2">
          <div class="grid gap-2">
            <Label for="bootstrap-rpm">Rate limit (requests / minute)</Label>
            <Input id="bootstrap-rpm" type="number" min="1" max="100000" bind:value={rateLimitRpm} />
          </div>
          <div class="grid gap-2">
            <div class="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label for="bootstrap-expires-toggle" class="text-sm">Expires</Label>
                <p class="text-xs text-muted-foreground">Off = never expires.</p>
              </div>
              <Switch
                id="bootstrap-expires-toggle"
                aria-label="Set an expiration date"
                checked={expiresEnabled}
                onCheckedChange={(v) => (expiresEnabled = v)}
              />
            </div>
            {#if expiresEnabled}
              <Input id="bootstrap-expires" type="datetime-local" bind:value={expiresAt} class="mt-2" />
            {/if}
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  </div>
</section>

<section class="setting-boundary">
  <div class="setting-boundary__head">
    <h2>Project</h2>
    <p>Attach a coordination workspace ("room") for informational context, or skip it.</p>
  </div>
  <div class="flex flex-wrap items-end gap-3">
    <div class="grid min-w-[16rem] max-w-md flex-1 gap-2">
      <Label for="bootstrap-project">Project</Label>
      <Select.Root
        type="single"
        value={selectedProjectSlug}
        onValueChange={(v) => (selectedProjectSlug = v ?? NONE_PROJECT)}
      >
        <Select.Trigger id="bootstrap-project">{projectSelectLabel}</Select.Trigger>
        <Select.Content>
          <Select.Item value={NONE_PROJECT} label="No project — key and base URL only" />
          {#each projects as project (project.slug)}
            <Select.Item value={project.slug} label={project.title || project.slug} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <Button type="button" variant="outline" onclick={() => (newProjectDialogOpen = true)}>
      <Plus class="h-4 w-4" />
      New project
    </Button>
  </div>

  {#if selectedProjectSlug !== NONE_PROJECT}
    <div class="mt-4 max-w-2xl">
      <ProjectPreviewCard project={selectedProject} loading={$projectDetailQuery.isLoading} />
    </div>
  {/if}
</section>

<section class="setting-boundary">
  <div class="setting-boundary__head">
    <h2>Generate</h2>
    <p>Issue a fresh key, or reuse one that already exists.</p>
  </div>

  <Tabs.Root value={generateMode} onValueChange={(v) => (generateMode = (v as GenerateMode) ?? generateMode)}>
    <Tabs.List>
      <Tabs.Trigger value="create">Create a new key</Tabs.Trigger>
      <Tabs.Trigger value="existing">Use an existing key</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="create" class="mt-4">
      <form onsubmit={handleCreate} class="flex max-w-lg flex-col gap-4">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">Issued to</dt>
          <dd class="truncate">{issuedTo || "—"}</dd>
          <dt class="text-muted-foreground">Engine</dt>
          <dd>{engineLabel(engine)}</dd>
          <dt class="text-muted-foreground">Rate limit</dt>
          <dd>{rateLimitRpm || "—"}/min</dd>
          <dt class="text-muted-foreground">Expires</dt>
          <dd>{expiresEnabled ? expiresAt || "Not set" : "Never"}</dd>
        </dl>
        <Button type="submit" disabled={$createMut.isPending || !issuedTo.trim()} class="self-start">
          <Rocket class="h-4 w-4" />
          {$createMut.isPending ? "Issuing…" : "Create key"}
        </Button>
      </form>
    </Tabs.Content>

    <Tabs.Content value="existing" class="mt-4">
      <div class="flex max-w-lg flex-col gap-3">
        <p class="text-sm text-muted-foreground">
          Existing keys never expose their plaintext again after creation, so this can only
          produce a placeholder line below — you'll paste in the value you saved when the key
          was issued.
        </p>
        <ExistingKeyPicker
          keys={existingKeys}
          value={existingKeyId}
          loading={$existingKeysQuery.isLoading}
          placeholder={`Select a ${engineLabel(engine)} key…`}
          onSelect={selectExisting}
        />
        {#if !$existingKeysQuery.isLoading && existingKeys.length === 0}
          <p class="text-xs text-muted-foreground">
            No {engineLabel(engine)} keys yet — switch to "Create a new key".
          </p>
        {/if}
      </div>
    </Tabs.Content>
  </Tabs.Root>
</section>

{#if doc}
  <section id="bootstrap-document" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2>Bootstrap document</h2>
      <p>Paste this into the coding AI's environment.</p>
    </div>
    <BootstrapDocument
      engine={doc.engine}
      issuedTo={doc.name}
      keyValue={doc.kind === "created" ? doc.key : null}
      keyPrefix={doc.kind === "existing" ? doc.keyPrefix : null}
      project={selectedProject}
    />
  </section>
{/if}

<NewProjectDialog
  bind:open={newProjectDialogOpen}
  onCreated={(slug) => {
    selectedProjectSlug = slug;
  }}
/>
