<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Select from "$lib/components/ui/select";
  import { Label } from "$lib/components/ui/label";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { claudeVersionMutation, claudeVersionQuery } from "$lib/api/settings";

  const query = claudeVersionQuery();
  let lastSavedAt = $state<Date | null>(null);

  const setM = claudeVersionMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Claude version selection saved");
    },
    onError: (err) => toast.error(err.message),
  });

  type Selection = "latest" | "exact";
  let selection = $state<Selection>("latest");
  let exactVersion = $state("");
  let locked = $state(false);
  let initialized = false;

  const current = $derived($query.data ?? null);
  const currentVersion = $derived(current?.version ?? null);
  const currentLocked = $derived(Boolean(current?.locked));
  const updatedAt = $derived(current?.updated_at ?? null);

  $effect(() => {
    if (!current || initialized) return;
    if (current.version && current.version.trim() !== "") {
      selection = "exact";
      exactVersion = current.version;
    } else {
      selection = "latest";
      exactVersion = "";
    }
    locked = Boolean(current.locked);
    initialized = true;
  });

  function save() {
    if (selection === "latest") {
      $setM.mutate({ version: null, locked });
    } else {
      const v = exactVersion.trim();
      if (!v) {
        toast.error("Enter a version like 0.2.4");
        return;
      }
      $setM.mutate({ version: v, locked });
    }
  }

  const status = $derived.by(() => {
    if ($setM.isPending) return "saving" as const;
    if ($setM.isError) return "error" as const;
    if ($setM.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="claude-version"
  title="Claude version"
  description="Pin the fleet to the latest Claude wrapper release or a specific semantic version."
  {status}
  savedAt={lastSavedAt}
  error={$setM.error?.message}
>
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="claude-version-selection">Selection</Label>
      <Select.Root
        type="single"
        value={selection}
        onValueChange={(v) => (selection = v as Selection)}
      >
        <Select.Trigger id="claude-version-selection">
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
        <Label for="claude-version-exact">Version</Label>
        <Input id="claude-version-exact" bind:value={exactVersion} placeholder="0.2.4" />
      </div>
    {/if}
  </div>

  <SwitchRow
    id="claude-version-locked"
    label="Lock fleet to this version"
    description="When locked, hosts will not auto-upgrade past the selected Claude version."
    checked={locked}
    onCheckedChange={(v) => (locked = v)}
  />

  <dl class="grid gap-2 rounded-md border bg-muted/20 px-4 py-3 text-xs sm:grid-cols-3">
    <div>
      <dt class="text-muted-foreground">Current version</dt>
      <dd class="font-mono">{currentVersion ?? "—"}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Lock state</dt>
      <dd>{currentLocked ? "Locked" : "Unlocked"}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Last updated</dt>
      <dd class="tabular-nums">{updatedAt ?? "—"}</dd>
    </div>
    <div class="sm:col-span-3">
      <dt class="text-muted-foreground">Mode</dt>
      <dd>{currentLocked ? "Pinned (locked)" : currentVersion ? "Pinned (unlocked)" : "Latest (auto)"}</dd>
    </div>
  </dl>

  <div>
    <Button size="sm" onclick={save} disabled={$setM.isPending}>Save</Button>
  </div>
</SectionCard>
