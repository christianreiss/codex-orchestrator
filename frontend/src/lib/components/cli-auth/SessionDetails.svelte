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

  const scopeLabel = $derived(session.secure ? "Secure (mTLS)" : "Insecure (HTTP API key only)");
  const ScopeIcon = $derived(session.secure ? ShieldCheck : ShieldAlert);
  const scopeTone = $derived(
    session.secure ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
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
    "grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 rounded-lg border bg-muted/40 px-5 py-4 text-sm",
    className,
  )}
>
  <dt class="font-medium text-muted-foreground">Hostname</dt>
  <dd class="break-all font-mono text-foreground">{session.fqdn || "—"}</dd>

  <dt class="font-medium text-muted-foreground">Source IP</dt>
  <dd class="font-mono text-foreground">{session.ip || "unknown"}</dd>

  <dt class="font-medium text-muted-foreground">Requested</dt>
  <dd class="text-foreground">
    {relativeTime(session.created_at) || "—"}
    {#if session.created_at}
      <span class="text-muted-foreground"> · {formatAbsolute(session.created_at)}</span>
    {/if}
  </dd>

  <dt class="font-medium text-muted-foreground">Scope</dt>
  <dd class={cn("flex items-center gap-1.5 font-medium", scopeTone)}>
    <ScopeIcon class="h-4 w-4" aria-hidden="true" />
    {scopeLabel}
  </dd>

  {#if session.expires_at}
    <dt class="font-medium text-muted-foreground">Expires</dt>
    <dd class="text-foreground">
      {relativeTime(session.expires_at) || "—"}
    </dd>
  {/if}
</dl>
