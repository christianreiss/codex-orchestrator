<script lang="ts">
  import { toast } from "svelte-sonner";
  import { base } from "$app/paths";
  import { authStore } from "$lib/stores/auth";
  import {
    agentMessagingStateMutation,
    agentMessagingStateQuery,
  } from "$lib/api/agentMessaging";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";

  const query = agentMessagingStateQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = agentMessagingStateMutation({
    onSuccess: (data) => {
      lastSavedAt = new Date();
      toast.success(data.enabled
        ? "Agent Messaging enabled"
        : "Agent Messaging disabled; open conversations and in-flight work canceled");
    },
    onError: (error) => toast.error(error.message),
  });
  const data = $derived($query.data);
  const accessLevel = $derived(
    ($authStore.user as (typeof $authStore.user & { access_level?: string }) | null)?.access_level,
  );
  const canMutate = $derived(
    [...$authStore.roles, accessLevel ?? ""]
      .map((role) => role.trim().toLowerCase())
      .some((role) => role === "owner" || role === "admin"),
  );
  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="agent-messaging"
  title="Agent Messaging"
  description="Fleet-wide Codex ↔ Claude communication with stable addresses, automatic resume/fresh delivery, encrypted content, and ordered at-least-once semantics. The initial default is off."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="agent-messaging-toggle"
    label="Enable agent-to-agent messaging"
    description={$query.isPending
      ? "Loading current state…"
      : data?.enabled
        ? `${data.live_addresses} live addresses · ${data.messages.queued + data.messages.leased + data.messages.accepted} pending deliveries`
        : "Discovery, send, reply, wake, resume, and relay polling are disabled."}
    checked={data?.enabled ?? false}
    disabled={!canMutate || $query.isPending || $mutation.isPending}
    onCheckedChange={(enabled) => $mutation.mutate(enabled)}
  />

  <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
    Turning this off revokes relays, cancels queued/in-flight peer work and open conversations, and stops only managed headless deliveries. Interactive Codex and Claude sessions keep running. History and audit metadata remain available.
  </div>

  <div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
    <span>32 KiB text · 24h default TTL · 12 delivery attempts · no broadcast or attachments</span>
    <Button href={`${base}/agent-messaging`} size="sm" variant="outline">Open operations</Button>
  </div>
</SectionCard>
