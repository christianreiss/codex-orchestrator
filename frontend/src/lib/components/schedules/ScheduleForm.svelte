<script lang="ts">
  /** Create or edit one timed wake-up. Persistent recovery lives under Advanced. */
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import type { AgentAddress } from "$lib/api/agentMessaging";
  import type { Schedule } from "$lib/api/schedules";
  import AgentSelect from "./AgentSelect.svelte";

  type Props = {
    /** The wake-up being edited, or null for a new one. */
    schedule: Schedule | null;
    agents: AgentAddress[];
    agentsError?: string;
    pending: boolean;
    onSubmit: (method: "POST" | "PATCH", id: string | undefined, body: Record<string, unknown>) => void;
    onCancel: () => void;
  };
  let { schedule, agents, agentsError, pending, onSubmit, onCancel }: Props = $props();

  // The form is remounted per open (keyed by the caller), so seeding once is correct.
  /* svelte-ignore state_referenced_locally */
  const seed = schedule;
  let name = $state(seed?.name ?? "");
  let target = $state(seed?.target ?? "");
  let prompt = $state(seed?.prompt ?? "");
  let kind = $state<Schedule["kind"]>(seed?.kind ?? "interval");
  let at = $state(seed?.at ?? "");
  let cron = $state(seed?.cron ?? "0 9 * * *");
  let interval = $state(seed?.interval_minutes ?? 5);
  let timezone = $state(seed?.timezone ?? "Europe/Berlin");
  let enabled = $state(seed?.enabled ?? true);
  let persistent = $state(seed?.persistent ?? false);
  let timeout = $state<number | undefined>(seed?.progress_timeout_seconds ?? undefined);
  let recoveryLimit = $state<number | undefined>(seed?.max_recovery_attempts ?? undefined);

  function save(event: SubmitEvent) {
    event.preventDefault();
    if (!target) {
      toast.error("Choose a target agent");
      return;
    }
    onSubmit(seed ? "PATCH" : "POST", seed?.id, {
      ...(seed ? { version: seed.version } : {}),
      name,
      target,
      prompt,
      kind,
      at: kind === "once" ? at : null,
      cron: kind === "cron" ? cron : null,
      interval_minutes: kind === "interval" ? interval : null,
      timezone,
      enabled,
      persistent,
      max_recovery_attempts: persistent ? (recoveryLimit ?? null) : null,
      progress_timeout_seconds: persistent ? timeout : null,
    });
  }
</script>

<form onsubmit={save} class="grid gap-4 sm:grid-cols-2">
  <div class="space-y-1.5">
    <Label for="schedule-name">Name</Label>
    <Input id="schedule-name" bind:value={name} required maxlength={120} />
  </div>
  <div class="space-y-1.5">
    <span class="text-body-sm font-medium">Target agent</span>
    <AgentSelect bind:value={target} {agents} />
    {#if agentsError}<p role="alert" class="text-caption text-destructive">{agentsError}</p>{/if}
  </div>
  <div class="space-y-1.5 sm:col-span-2">
    <Label for="schedule-prompt">Prompt</Label>
    <Textarea id="schedule-prompt" bind:value={prompt} required maxlength={30000} />
  </div>

  <div class="space-y-1.5">
    <Label for="schedule-kind">Timing</Label>
    <select id="schedule-kind" class="h-9 w-full rounded-md border border-input bg-card px-3 text-body-sm" bind:value={kind}>
      <option value="once">Once</option>
      <option value="interval">Every X minutes</option>
      <option value="cron">Cron</option>
    </select>
  </div>
  <div class="space-y-1.5">
    {#if kind === "once"}
      <Label for="schedule-at">Time (RFC3339, including offset)</Label>
      <Input id="schedule-at" bind:value={at} placeholder="2026-10-09T09:00:00+02:00" required />
    {:else if kind === "interval"}
      <Label for="schedule-interval">Interval in minutes</Label>
      <Input id="schedule-interval" type="number" min={1} max={525600} bind:value={interval} required />
    {:else}
      <Label for="schedule-cron">Cron expression</Label>
      <Input id="schedule-cron" bind:value={cron} required placeholder="0 9 * * *" />
    {/if}
  </div>
  <div class="space-y-1.5">
    <Label for="schedule-timezone">Timezone</Label>
    <Input id="schedule-timezone" bind:value={timezone} required />
  </div>
  <label class="flex items-center gap-2 self-end pb-2 text-body-sm"><input type="checkbox" bind:checked={enabled} /> Enabled</label>

  <details class="rounded-md border px-3 py-2 sm:col-span-2" open={persistent}>
    <summary class="cursor-pointer select-none text-body font-medium">Advanced</summary>
    <div class="mt-3 space-y-3">
      <label class="flex items-start gap-2 text-body-sm">
        <input type="checkbox" class="mt-1" bind:checked={persistent} />
        <span>Persistent recovery — explicitly resume after crash, hang or capacity failure</span>
      </label>
      <p class="text-caption text-muted-foreground">Off by default. Repeating alone does not enable recovery. Requires a known native session and an active host worker. Missing transcripts block recovery.</p>
      {#if persistent}
        <div class="space-y-1.5">
          <Label for="schedule-recovery-limit">Maximum recovery attempts (empty means unlimited)</Label>
          <Input id="schedule-recovery-limit" type="number" min={1} max={10000} bind:value={recoveryLimit} />
          <p class="text-caption text-muted-foreground">Retries use exponential backoff with jitter and respect provider reset times. The whole schedule pauses when its limit is reached.</p>
        </div>
        <div class="space-y-1.5">
          <Label for="schedule-timeout">Progress timeout in seconds</Label>
          <Input id="schedule-timeout" type="number" min={60} max={604800} bind:value={timeout} required />
          <p class="text-caption text-muted-foreground">After this interval without observed progress, the Linux supervisor may stop its own process and resume the session. Active child tools prevent a timeout.</p>
        </div>
      {/if}
    </div>
  </details>

  <div class="flex gap-2 sm:col-span-2">
    <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
    <Button type="button" variant="outline" onclick={onCancel}>Cancel</Button>
  </div>
</form>
