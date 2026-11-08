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
    codexVersionMutation,
    codexVersionsCheckMutation,
    codexVersionsQuery,
  } from "$lib/api/settings";

  type Props = { headingLevel?: 2 | 3 };
  let { headingLevel = 2 }: Props = $props();

  const query = codexVersionsQuery();
  let lastSavedAt = $state<Date | null>(null);

  const checkM = codexVersionsCheckMutation({
    onSuccess: () => toast.success("Refreshed Codex version list"),
    onError: (err) => toast.error(err.message),
  });

  const setM = codexVersionMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Codex version selection saved");
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

  const summary = $derived($query.data?.versions ?? null);
  const reportedClient = $derived(summary?.reported_client_version ?? null);
  const currentClient = $derived(summary?.client_version ?? null);
  const enforceExact = $derived(Boolean(summary?.client_version_enforce_exact));
  const availableLatest = $derived(($query.data?.available_client?.version as string | null) ?? null);

  $effect(() => {
    if (!summary || initialized) return;
    if (summary.client_version_enforce_exact && summary.client_version) {
      selection = "exact";
      exactVersion = String(summary.client_version);
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
        toast.error("Enter a version like 0.125.0");
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
</script>

<DraftGuard {dirty} />
<SectionCard
  id="codex-version"
  title="Codex version"
  description="Pin the fleet to the latest Codex release or a specific semantic version."
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

  {#if $query.isPending}<p role="status">Loading current Codex version selection…</p>{/if}
  {#if $query.isError}<p role="alert" class="text-body-sm text-destructive">Could not load Codex version selection: {$query.error.message}</p><Button variant="outline" size="sm" onclick={() => $query.refetch()}>Retry version selection</Button>{/if}
  {#if dirty}<p role="status" class="text-body-sm text-muted-foreground">Unsaved changes</p>{/if}
  <fieldset disabled={!initialized || $query.isError || $query.isPending || $setM.isPending} class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="codex-version-selection">Selection</Label>
      <Select.Root
        type="single"
        value={selection}
        onValueChange={(v) => (selection = v as Selection)}
      >
        <Select.Trigger id="codex-version-selection">
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
        <Label for="codex-version-exact">Version</Label>
        <Input id="codex-version-exact" bind:value={exactVersion} placeholder="0.125.0" />
      </div>
    {/if}
  </fieldset>

  <dl class="grid gap-2 border-y py-2 text-caption sm:grid-cols-3">
    <div>
      <dt class="text-muted-foreground">Resolved client</dt>
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
      <dd>{summary ? (enforceExact ? "Pinned (exact)" : "Latest (auto)") : "Unavailable"}</dd>
    </div>
  </dl>

  <div>
    <Button size="sm" onclick={save} disabled={!initialized || $query.isError || $query.isPending || $setM.isPending}>{$setM.isPending ? "Saving…" : "Save Codex version"}</Button>
  </div>
</SectionCard>
