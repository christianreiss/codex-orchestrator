<script lang="ts">
  import { toast } from "svelte-sonner";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import * as Select from "$lib/components/ui/select";
  import { Label } from "$lib/components/ui/label";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import SectionCard from "$lib/components/engines/SettingGroup.svelte";
  import {
    engineVersionMutation,
    versionsCheckMutation,
    versionsQuery,
    type VersionEngine,
  } from "$lib/api/settings";
  import { ENGINE_VERSION_CONFIG } from "./engine-version-config";

  type Props = { engine: VersionEngine; headingLevel?: 2 | 3 };
  let { engine, headingLevel = 2 }: Props = $props();

  // The section is mounted once per engine and never switches engine in place.
  // svelte-ignore state_referenced_locally
  const cfg = ENGINE_VERSION_CONFIG[engine];
  // svelte-ignore state_referenced_locally
  const idPrefix = `${engine}-version`;
  const floored = cfg.minVersion !== undefined;

  const query = versionsQuery();
  let lastSavedAt = $state<Date | null>(null);

  const checkM = versionsCheckMutation({
    onSuccess: () => toast.success(`Refreshed ${cfg.label} version list`),
    onError: (err) => toast.error(err.message),
  });

  // svelte-ignore state_referenced_locally
  const setM = engineVersionMutation(engine, {
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success(`${cfg.label} version selection saved`);
    },
    onError: (err) => toast.error(err.message),
  });

  type Selection = "latest" | "exact";
  let selection = $state<Selection>("latest");
  let exactVersion = $state("");
  let initialized = $state(false);
  /** The selection the server holds; the form is dirty while it differs. */
  let saved = $state<string | null>(null);
  const draft = $derived(selection === "latest" ? "latest" : exactVersion.trim());
  const dirty = $derived(saved !== null && draft !== saved);

  const summary = $derived($query.data ? (cfg.summary($query.data) ?? null) : null);
  const reportedClient = $derived(summary?.reported_client_version ?? null);
  // Floored engines resolve their target through the lock; the others report it directly.
  const currentClient = $derived(
    floored ? (summary?.client_version ?? summary?.client_version_lock ?? null) : (summary?.client_version ?? null),
  );
  const pinnedClient = $derived(
    floored ? (summary?.client_version_lock ?? summary?.client_version) : summary?.client_version,
  );
  const enforceExact = $derived(Boolean(summary?.client_version_enforce_exact));
  const availableLatest = $derived(
    ($query.data ? (cfg.available($query.data)?.version as string | null | undefined) : null) ?? null,
  );

  $effect(() => {
    if (!summary || initialized) return;
    if (summary.client_version_enforce_exact && pinnedClient) {
      selection = "exact";
      exactVersion = String(pinnedClient);
    } else {
      selection = "latest";
      exactVersion = "";
    }
    saved = selection === "latest" ? "latest" : exactVersion.trim();
    initialized = true;
  });

  function save() {
    if (!initialized || $query.isError || $query.isPending || $setM.isPending) return;
    const sent = draft;
    const onSuccess = () => { saved = sent; };
    if (selection === "latest") {
      $setM.mutate("latest", { onSuccess });
    } else {
      const v = exactVersion.trim();
      if (!v) {
        toast.error(`Enter a version like ${cfg.example}`);
        return;
      }
      $setM.mutate(v, { onSuccess });
    }
  }

  const status = $derived.by(() => {
    if ($setM.isPending) return "saving" as const;
    if ($setM.isError) return "error" as const;
    if ($setM.isSuccess && !dirty) return "saved" as const;
    return "idle" as const;
  });

  const modeLabel = $derived.by(() => {
    if (!summary) return "Unavailable";
    if (enforceExact) return "Pinned (exact)";
    if (!floored) return "Latest (auto)";
    return ["latest", "auto"].includes(summary.client_version ?? "") ? "Latest (auto)" : "Minimum target";
  });
</script>

<DraftGuard {dirty} />
<SectionCard
  id={idPrefix}
  title="{cfg.label} version"
  description="Pin the fleet to the latest {cfg.release} release or a specific semantic version."
  {status}
  savedAt={dirty ? null : lastSavedAt}
  error={$setM.error?.message}
  {headingLevel}
>
  {#snippet headerAction()}
    <Button
      variant="outline"
      size="sm"
      onclick={() => $checkM.mutate()}
      disabled={$checkM.isPending}
    >
      <RefreshCw class="mr-1.5 h-3.5 w-3.5 {$checkM.isPending ? 'animate-spin' : ''}" />
      Check for updates
    </Button>
  {/snippet}

  {#if $query.isPending}<p role="status">Loading current {cfg.label} version selection…</p>{/if}
  {#if $query.isError}<p role="alert" class="text-body-sm text-destructive">Could not load {cfg.label} version selection: {$query.error.message}</p><Button variant="outline" size="sm" onclick={() => $query.refetch()}>Retry version selection</Button>{/if}
  {#if dirty}<p role="status" class="text-body-sm text-muted-foreground">Unsaved changes</p>{/if}
  <fieldset disabled={!initialized || $query.isError || $query.isPending || $setM.isPending} class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="{idPrefix}-selection">Selection</Label>
      <Select.Root
        type="single"
        value={selection}
        onValueChange={(v) => (selection = v as Selection)}
      >
        <Select.Trigger id="{idPrefix}-selection">
          <Select.Value placeholder="Selection">
            {selection === "latest" ? "Latest available" : "Pinned exact version"}
          </Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="latest" label="Latest">Latest available</Select.Item>
          <Select.Item value="exact" label="Exact">Pinned exact version</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>

    {#if selection === "exact"}
      <div class="grid gap-1.5">
        <Label for="{idPrefix}-exact">Version</Label>
        <Input id="{idPrefix}-exact" bind:value={exactVersion} placeholder={cfg.example} />
      </div>
    {/if}
  </fieldset>

  {#if cfg.minVersion}
    <p class="text-caption text-muted-foreground">
      Minimum supported version: {cfg.minVersion}. Older saved pins resolve to this baseline;
      installed older CLIs must be updated before their next session.
    </p>
  {/if}

  <dl class="grid gap-2 border-y py-2 text-caption sm:grid-cols-3">
    <div>
      <dt class="text-muted-foreground">{floored ? "Fleet target" : "Resolved client"}</dt>
      <dd class="font-mono">{currentClient ?? "—"}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Latest available</dt>
      <dd class="font-mono">{availableLatest ?? "—"}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Reported by hosts</dt>
      <dd class="font-mono">{reportedClient ?? "—"}</dd>
    </div>
    <div class="sm:col-span-3">
      <dt class="text-muted-foreground">Mode</dt>
      <dd>{modeLabel}</dd>
    </div>
  </dl>

  <div>
    <Button size="sm" onclick={save} disabled={!initialized || $query.isError || $query.isPending || $setM.isPending}>{$setM.isPending ? "Saving…" : `Save ${cfg.label} version`}</Button>
  </div>
</SectionCard>
