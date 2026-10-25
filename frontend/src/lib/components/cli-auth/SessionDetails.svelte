<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import { relativeTime } from "$lib/utils/format";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import type { CliAuthLookup } from "$lib/api/types";

  type Props = {
    session: CliAuthLookup;
    class?: string;
  };

  let { session, class: className }: Props = $props();

  const scopeLabel = $derived(session.secure ? "Trusted (no approval window)" : "Insecure (approval window required)");
  const ScopeIcon = $derived(session.secure ? ShieldCheck : ShieldAlert);
  const scopeTone = $derived(
    session.secure ? "text-success" : "text-warning",
  );

  function formatAbsolute(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<dl
  class={cn(
    "grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 border-y py-4 text-body-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-y-3 [&>dd]:mb-3 [&>dd]:min-w-0 [&>dd]:break-words sm:[&>dd]:mb-0",
    className,
  )}
>
  <dt class="font-medium text-muted-foreground">Hostname</dt>
  <dd class="break-all font-mono text-foreground">{session.fqdn || "—"}</dd>

  <dt class="font-medium text-muted-foreground">Source IP</dt>
  <dd class="break-all font-mono text-foreground">{session.ip || "unknown"}</dd>

  <dt class="font-medium text-muted-foreground">Requested</dt>
  <dd class="text-foreground">
    {relativeTime(session.created_at) || "—"}
    {#if session.created_at}
      <span class="text-muted-foreground"> · {formatAbsolute(session.created_at)}</span>
    {/if}
  </dd>

  <dt class="font-medium text-muted-foreground">Scope</dt>
  <dd class={cn("flex items-start gap-1.5 font-medium", scopeTone)}>
    <ScopeIcon class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    {scopeLabel}
  </dd>

  {#if session.expires_at}
    <dt class="font-medium text-muted-foreground">Expires</dt>
    <dd class="text-foreground">
      {relativeTime(session.expires_at) || "—"}
    </dd>
  {/if}
</dl>
