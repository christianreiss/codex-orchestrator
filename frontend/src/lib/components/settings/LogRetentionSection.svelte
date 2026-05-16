<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { logRetentionMutation, logRetentionQuery } from "$lib/api/settings";

  const query = logRetentionQuery();
  let lastSavedAt = $state<Date | null>(null);

  const mutation = logRetentionMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Log retention saved");
    },
    onError: (err) => toast.error(err.message),
  });

  let enabled = $state(false);
  let daysLogs = $state(90);
  let daysMcp = $state(90);
  let daysEvents = $state(30);
  let daysGraphStats = $state(180);
  let initialized = false;

  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    enabled = d.enabled;
    daysLogs = d.days_logs;
    daysMcp = d.days_mcp;
    daysEvents = d.days_events;
    daysGraphStats = d.days_graph_stats;
    initialized = true;
  });

  function save() {
    $mutation.mutate({
      enabled,
      days_logs: Number(daysLogs),
      days_mcp: Number(daysMcp),
      days_events: Number(daysEvents),
      days_graph_stats: Number(daysGraphStats),
    });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="log-retention"
  title="Log retention"
  description="How long to keep API, MCP, event, and graph-stat rows before pruning. Each value is in days (1–365)."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="log-retention-enabled"
    label="Enable log retention pruning"
    description={enabled ? "Old log rows will be pruned by the policy below." : "Logs are retained indefinitely."}
    checked={enabled}
    onCheckedChange={(v) => (enabled = v)}
  />

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <div class="grid gap-1.5">
      <Label for="log-retention-logs">API logs (days)</Label>
      <Input id="log-retention-logs" type="number" min={1} max={365} bind:value={daysLogs} />
    </div>
    <div class="grid gap-1.5">
      <Label for="log-retention-mcp">MCP logs (days)</Label>
      <Input id="log-retention-mcp" type="number" min={1} max={365} bind:value={daysMcp} />
    </div>
    <div class="grid gap-1.5">
      <Label for="log-retention-events">Events (days)</Label>
      <Input id="log-retention-events" type="number" min={1} max={365} bind:value={daysEvents} />
    </div>
    <div class="grid gap-1.5">
      <Label for="log-retention-graph">Graph stats (days)</Label>
      <Input
        id="log-retention-graph"
        type="number"
        min={1}
        max={365}
        bind:value={daysGraphStats}
      />
    </div>
  </div>

  <div>
    <Button size="sm" onclick={save} disabled={$mutation.isPending}>Save log retention</Button>
  </div>
</SectionCard>
