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
    kimiVersionMutation,
    kimiVersionsCheckMutation,
    kimiVersionsQuery,
  } from "$lib/api/settings";

  type Props = { headingLevel?: 2 | 3 };
  let { headingLevel = 2 }: Props = $props();

  const query = kimiVersionsQuery();
  let lastSavedAt = $state<Date | null>(null);

  const checkM = kimiVersionsCheckMutation({
    onSuccess: () => toast.success("Refreshed Kimi Code version list"),
    onError: (err) => toast.error(err.message),
  });

  const setM = kimiVersionMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Kimi Code version selection saved");
    },
    onError: (err) => toast.error(err.message),
  });

  type Selection = "latest" | "exact";
  let selection = $state<Selection>("latest");
  let exactVersion = $state("");
  let initialized = false;
  /** The selection the server holds; the form is dirty while it differs. */
  let saved = $state<string | null>(null);
  const draft = $derived(selection === "latest" ? "latest" : exactVersion.trim());
  const dirty = $derived(saved !== null && draft !== saved);

  const summary = $derived($query.data?.kimi_versions ?? null);
  const reportedClient = $derived(summary?.reported_client_version ?? null);
  const currentClient = $derived(summary?.client_version ?? summary?.client_version_lock ?? null);
  const enforceExact = $derived(Boolean(summary?.client_version_enforce_exact));
  const availableLatest = $derived(
    ($query.data?.kimi_available_client?.version as string | null) ?? null,
  );

  $effect(() => {
    if (!summary || initialized) return;
    if (summary.client_version_enforce_exact && (summary.client_version_lock ?? summary.client_version)) {
      selection = "exact";
      exactVersion = String(summary.client_version_lock ?? summary.client_version);
    } else {
      selection = "latest";
      exactVersion = "";
    }
    saved = selection === "latest" ? "latest" : exactVersion.trim();
    initialized = true;
  });

  function save() {
    const sent = draft;
    const onSuccess = () => { saved = sent; };
    if (selection === "latest") {
      $setM.mutate("latest", { onSuccess });
    } else {
      const v = exactVersion.trim();
      if (!v) {
        toast.error("Enter a version like 2.5.3");
        return;
      }
      $setM.mutate(v, { onSuccess });
    }
  }

  const status = $derived.by(() => {
    if ($setM.isPending) return "saving" as const;
    if ($setM.isError) return "error" as const;
    if ($setM.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<DraftGuard {dirty} />
<SectionCard
  id="kimi-version"
  title="Kimi Code version"
  description="Pin the fleet to the latest Kimi Code release or a specific semantic version."
  {status}
  savedAt={lastSavedAt}
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

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="kimi-version-selection">Selection</Label>
      <Select.Root
        type="single"
        value={selection}
        onValueChange={(v) => (selection = v as Selection)}
      >
        <Select.Trigger id="kimi-version-selection">
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
        <Label for="kimi-version-exact">Version</Label>
        <Input id="kimi-version-exact" bind:value={exactVersion} placeholder="2.5.3" />
      </div>
    {/if}
  </div>

  <p class="text-caption text-muted-foreground">
    Minimum supported version: 2.5.3. Older saved pins resolve to this baseline;
    installed older CLIs must be updated before their next session.
  </p>

  <dl class="grid gap-2 border-y py-2 text-caption sm:grid-cols-3">
    <div>
      <dt class="text-muted-foreground">Fleet target</dt>
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
      <dd>{enforceExact ? "Pinned (exact)" : ["latest", "auto"].includes(summary?.client_version ?? "") ? "Latest (auto)" : "Minimum target"}</dd>
    </div>
  </dl>

  <div>
    <Button size="sm" onclick={save} disabled={$setM.isPending}>{$setM.isPending ? "Saving…" : "Save Kimi Code version"}</Button>
  </div>
</SectionCard>
